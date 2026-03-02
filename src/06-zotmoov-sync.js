var ZotMoovGitHubSync = class {
    static get AUTO_PUSH_INTERVAL_MS() { return 10 * 60 * 1000; }
    static get AUTO_PUSH_RETRY_MS() { return 5 * 60 * 1000; }
    static get REQUEST_TIMEOUT_MS() { return 30000; }

    constructor(zotmoov, zotmoovMenus, debuggerInstance)
    {
        this._zotmoov = zotmoov;
        this._zotmoovMenus = zotmoovMenus;
        this._debugger = debuggerInstance;

        this._prefPrefix = 'extensions.zotmoov.';
        this._syncPrefix = 'extensions.zotmoov.sync.github.';

        this._jsonPrefKeys = new Set([
            'extensions.zotmoov.allowed_fileext',
            'extensions.zotmoov.cwc_commands',
            'extensions.zotmoov.custom_menu_items'
        ]);

        this._excludedPrefKeys = new Set([
            'extensions.zotmoov.sync.github.enabled',
            'extensions.zotmoov.sync.github.repository',
            'extensions.zotmoov.sync.github.branch',
            'extensions.zotmoov.sync.github.filepath',
            'extensions.zotmoov.sync.github.token',
            'extensions.zotmoov.sync.github.auto_pull',
            'extensions.zotmoov.sync.github.auto_push',
            'extensions.zotmoov.sync.github.sync_pdfs',
            'extensions.zotmoov.sync.github.pdf_root',
            'extensions.zotmoov.sync.github.remote_pdf_mode',
            'extensions.zotmoov.sync.github.last_remote_sha',
            'extensions.zotmoov.sync.github.last_sync_time'
        ]);

        this._autoPushTimer = null;
        this._pushInProgress = false;
        this._pushPromise = null;
        this._destroyed = false;

        // Capture the cache path NOW while Zotero is fully alive.
        // Zotero.DataDirectory may be unavailable at shutdown time.
        try
        {
            const dataDir = (Zotero.DataDirectory && Zotero.DataDirectory.dir) ? Zotero.DataDirectory.dir : '';
            this._cacheDir = dataDir ? PathUtils.join(dataDir, 'zotgit-cache') : '';
        }
        catch (e)
        {
            this._cacheDir = '';
        }
    }

    _clearAutoPushTimer()
    {
        if (!this._autoPushTimer) return;

        clearTimeout(this._autoPushTimer);
        this._autoPushTimer = null;
    }

    _getShutdownCacheDirs()
    {
        const cacheDirs = new Set();

        if (this._cacheDir) cacheDirs.add(this._cacheDir);

        try
        {
            const dataDir = (Zotero.DataDirectory && Zotero.DataDirectory.dir) ? Zotero.DataDirectory.dir : '';
            if (dataDir)
            {
                cacheDirs.add(PathUtils.join(dataDir, 'zotgit-cache'));
                cacheDirs.add(PathUtils.join(dataDir, 'zogit-cache'));
            }
        }
        catch (e) {}

        return Array.from(cacheDirs).filter(Boolean);
    }

    async _delay(ms)
    {
        await new Promise(resolve => setTimeout(resolve, ms));
    }

    _isAutoPushEnabled()
    {
        return Zotero.Prefs.get('extensions.zotmoov.sync.github.enabled', true)
            && Zotero.Prefs.get('extensions.zotmoov.sync.github.auto_push', true);
    }

    _scheduleAutoPush(delayMs)
    {
        this._clearAutoPushTimer();
        if (this._destroyed) return;
        if (!this._isAutoPushEnabled()) return;

        this._autoPushTimer = setTimeout(() => this._runScheduledPush(), delayMs);
    }

    _scheduleAfterPushResult(success)
    {
        if (!this._isAutoPushEnabled()) return;

        this._scheduleAutoPush(success ? this.constructor.AUTO_PUSH_INTERVAL_MS : this.constructor.AUTO_PUSH_RETRY_MS);
    }

    async _runScheduledPush()
    {
        this._autoPushTimer = null;

        if (this._destroyed) return;
        if (!this._isAutoPushEnabled()) return;

        await this.pushToGitHub();
    }

    configureAutoPushScheduler()
    {
        if (this._destroyed) return;

        this._clearAutoPushTimer();
        if (!this._isAutoPushEnabled()) return;

        this._scheduleAutoPush(this.constructor.AUTO_PUSH_INTERVAL_MS);
    }

    async cleanupRemoteCacheOnShutdown(onProgress = null)
    {
        // Only remove cache directories, never user destination directories.
        const cacheDirs = this._getShutdownCacheDirs();

        for (let cacheDir of cacheDirs)
        {
            try
            {
                const exists = await IOUtils.exists(cacheDir);
                if (!exists) continue;

                // Remove all files individually first (avoids locked-file blocking the whole tree on Windows)
                const files = await this._collectLocalPDFFiles(cacheDir).catch(() => []);
                for (let file of files)
                {
                    try { await IOUtils.remove(file.fullPath, { ignoreAbsent: true }); } catch (e) {}
                }

                // Now remove the directory tree, retrying briefly on Windows shutdown file locks.
                let removed = false;
                let lastError = null;
                for (let attempt = 0; attempt < 3; attempt++)
                {
                    try
                    {
                        await IOUtils.remove(cacheDir, { recursive: true, ignoreAbsent: true });
                        removed = !(await IOUtils.exists(cacheDir));
                        if (removed) break;
                    }
                    catch (e)
                    {
                        lastError = e;
                    }

                    await this._delay(250 * (attempt + 1));
                }

                if (!removed && lastError)
                {
                    throw lastError;
                }

                this._emitProgress(onProgress, 'Shutdown: removed cache directory ' + cacheDir);
            }
            catch (e)
            {
                this._debugger.warn('Cache cleanup failed for ' + cacheDir + ': ' + e.message);
            }
        }
    }

    async destroy({ pushOnShutdown = false, cleanupCacheOnShutdown = false, onProgress = null } = {})
    {
        this._destroyed = true;
        this._clearAutoPushTimer();

        // Wait for any already-running auto-push to finish before we do our own shutdown push
        if (this._pushPromise)
        {
            try { await this._pushPromise; } catch (e) {}
        }

        // In remote PDF mode the cache is purely transient (downloaded on demand).
        // Always delete it on shutdown — the source of truth is GitHub, not the local cache.
        const remotePDFMode = this.isRemotePDFModeEnabled();

        let pushSucceeded = false;
        if (pushOnShutdown)
        {
            const syncEnabled = Zotero.Prefs.get('extensions.zotmoov.sync.github.enabled', true);
            if (syncEnabled)
            {
                try
                {
                    this._emitProgress(onProgress, 'Shutdown: pushing latest changes to GitHub');
                    const pushResult = await this.pushToGitHub({ onProgress });
                    pushSucceeded = !!(pushResult && pushResult.ok);
                    Zotero.debug('ZotGit Shutdown: push ' + (pushSucceeded ? 'succeeded' : 'failed'));
                }
                catch (e)
                {
                    this._debugger.warn('Shutdown push failed: ' + e.message);
                    Zotero.debug('ZotGit Shutdown: push exception: ' + e.message);
                }
            }
            else
            {
                Zotero.debug('ZotGit Shutdown: sync not enabled, skipping push');
            }
        }

        // Cache is always transient by definition; always clean it when requested.
        if (cleanupCacheOnShutdown)
        {
            Zotero.debug('ZotGit Shutdown: cleaning cache (remotePDFMode=' + remotePDFMode + ' pushSucceeded=' + pushSucceeded + ')');
            await this.cleanupRemoteCacheOnShutdown();
        }
    }

    _emitProgress(callback, message)
    {
        if (typeof callback != 'function') return;
        try
        {
            callback(message);
        }
        catch (e)
        {
            // Do not fail sync because of UI logging callback issues
        }
    }

    _getSyncPref(key)
    {
        return Zotero.Prefs.get(this._syncPrefix + key, true);
    }

    _setSyncPref(key, value)
    {
        Zotero.Prefs.set(this._syncPrefix + key, value, true);
    }

    _isPDFSyncEnabled()
    {
        return Zotero.Prefs.get('extensions.zotmoov.sync.github.sync_pdfs', true);
    }

    isRemotePDFModeEnabled()
    {
        return Zotero.Prefs.get('extensions.zotmoov.sync.github.remote_pdf_mode', true);
    }

    getPreferredLocalDir()
    {
        if (this.isRemotePDFModeEnabled())
        {
            const dataDir = (Zotero.DataDirectory && Zotero.DataDirectory.dir) ? Zotero.DataDirectory.dir : '';
            if (dataDir) return PathUtils.join(dataDir, 'zotgit-cache');
        }

        return (Zotero.Prefs.get('extensions.zotmoov.dst_dir', true) || '').trim();
    }

    _getPDFRootPath()
    {
        const root = (Zotero.Prefs.get('extensions.zotmoov.sync.github.pdf_root', true) || '').trim();
        return root || 'pdfs';
    }

    _getLocalPDFBaseDir()
    {
        const baseDir = (this.getPreferredLocalDir() || '').trim();
        if (!baseDir) throw new Error('Local PDF directory is not configured');

        return baseDir;
    }

    _isAbsolutePath(path)
    {
        if (!path) return false;
        if (path.startsWith('\\\\')) return true;
        if (/^[A-Za-z]:[\\/]/.test(path)) return true;
        return path.startsWith('/');
    }

    _normalizeRelativePath(path)
    {
        return (path || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
    }

    _getPathBasename(path)
    {
        const normalized = this._normalizeRelativePath(path);
        if (!normalized) return '';

        const parts = normalized.split('/').filter(Boolean);
        if (!parts.length) return '';
        return parts[parts.length - 1];
    }

    _getLegacyLocalDir()
    {
        return (Zotero.Prefs.get('extensions.zotmoov.dst_dir', true) || '').trim();
    }

    _getAttachmentRemoteRelative(item, baseDir)
    {
        if (!item) return '';

        const rawPath = (item.attachmentPath || '').trim();
        if (!rawPath) return '';

        if (rawPath.startsWith('attachments:'))
        {
            return this._normalizeRelativePath(rawPath.substring('attachments:'.length));
        }

        const normalizedRaw = rawPath.replace(/\//g, '\\');
        if (this._isAbsolutePath(rawPath))
        {
            let relative = this._localPathToRemoteRelative(baseDir, normalizedRaw);
            if (relative) return this._normalizeRelativePath(relative);

            const legacyBase = this._getLegacyLocalDir();
            if (legacyBase)
            {
                relative = this._localPathToRemoteRelative(legacyBase, normalizedRaw);
                if (relative) return this._normalizeRelativePath(relative);
            }

            const filename = this._getPathBasename(normalizedRaw);
            return this._normalizeRelativePath(filename);
        }

        return this._normalizeRelativePath(rawPath);
    }

    _getAttachmentLocalPath(item, baseDir)
    {
        if (!item) return null;

        const relative = this._getAttachmentRemoteRelative(item, baseDir);
        if (!relative) return null;

        return this._remoteRelativeToLocal(baseDir, relative);
    }

    _normalizeRemotePath(path)
    {
        return path.split('/').filter(Boolean).join('/');
    }

    _joinRemotePath(...parts)
    {
        return this._normalizeRemotePath(parts.filter(Boolean).join('/'));
    }

    _localPathToRemoteRelative(baseDir, fullPath)
    {
        const loweredBase = baseDir.toLowerCase();
        const loweredFull = fullPath.toLowerCase();
        if (!loweredFull.startsWith(loweredBase)) return null;

        let relative = fullPath.substring(baseDir.length);
        relative = relative.replace(/^[\\/]+/, '');
        relative = relative.replace(/\\/g, '/');

        return relative;
    }

    _remoteRelativeToLocal(baseDir, relativePath)
    {
        const segments = relativePath.split('/').filter(Boolean);
        return PathUtils.join(baseDir, ...segments);
    }

    _uint8ToBase64(bytes)
    {
        let binary = '';
        for (let b of bytes)
        {
            binary += String.fromCharCode(b);
        }

        return btoa(binary);
    }

    _base64ToUint8(base64String)
    {
        let binary = atob((base64String || '').replace(/\n/g, ''));
        return Uint8Array.from(binary, c => c.charCodeAt(0));
    }

    _buildRepoContentsUrl(config, remotePath, includeRef = true)
    {
        const owner = encodeURIComponent(config.owner);
        const repo = encodeURIComponent(config.repo);
        const encodedPath = remotePath.split('/').filter(Boolean).map(segment => encodeURIComponent(segment)).join('/');

        let url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + encodedPath;
        if (includeRef)
        {
            url += '?ref=' + encodeURIComponent(config.branch);
        }

        return url;
    }

    async _collectLocalPDFFiles(baseDir)
    {
        let results = [];

        const walk = async (dirPath) => {
            let children = [];
            try
            {
                children = await IOUtils.getChildren(dirPath);
            }
            catch (e)
            {
                return;
            }

            for (let childPath of children)
            {
                let stat = null;
                try
                {
                    stat = await IOUtils.stat(childPath);
                }
                catch (e)
                {
                    continue;
                }

                if (stat.type == 'directory')
                {
                    await walk(childPath);
                    continue;
                }

                if (stat.type != 'regular') continue;
                if (!childPath.toLowerCase().endsWith('.pdf')) continue;

                const relative = this._localPathToRemoteRelative(baseDir, childPath);
                if (!relative) continue;

                results.push({
                    fullPath: childPath,
                    relativePath: relative
                });
            }
        };

        await walk(baseDir);

        return results;
    }

    async _listRemoteFilesRecursive(config, remoteDir, onProgress = null)
    {
        const url = this._buildRepoContentsUrl(config, remoteDir, true);
        let entries = null;

        try
        {
            entries = await this._requestJSON(url, {
                method: 'GET',
                headers: this._getHeaders(config.token)
            }, onProgress);
        }
        catch (e)
        {
            if (e.status == 404) return [];
            throw e;
        }

        if (!Array.isArray(entries)) return [];

        let files = [];
        for (let entry of entries)
        {
            if (!entry || !entry.path || !entry.type) continue;

            if (entry.type == 'file')
            {
                files.push(entry.path);
                continue;
            }

            if (entry.type == 'dir')
            {
                const nested = await this._listRemoteFilesRecursive(config, entry.path, onProgress);
                files.push(...nested);
            }
        }

        return files;
    }

    async _findRemotePDFPathByFilename(config, filename, onProgress = null)
    {
        const cleanName = (filename || '').trim().toLowerCase();
        if (!cleanName) return null;

        const pdfRoot = this._getPDFRootPath();
        const allFiles = await this._listRemoteFilesRecursive(config, pdfRoot, onProgress);
        const pdfFiles = allFiles.filter(path => path && path.toLowerCase().endsWith('.pdf'));

        const exact = pdfFiles.find(path => this._getPathBasename(path).toLowerCase() == cleanName);
        if (exact) return exact;

        const partial = pdfFiles.find(path => path.toLowerCase().includes(cleanName));
        return partial || null;
    }

    async _pushSinglePDF(config, remotePath, bytes, onProgress = null)
    {
        const content = this._uint8ToBase64(bytes);
        const url = this._buildRepoContentsUrl(config, remotePath, false);
        let existingSha = null;

        try
        {
            const existing = await this._requestJSON(this._buildRepoContentsUrl(config, remotePath, true), {
                method: 'GET',
                headers: this._getHeaders(config.token)
            }, onProgress);

            existingSha = existing && existing.sha ? existing.sha : null;
        }
        catch (e)
        {
            if (e.status != 404) throw e;
        }

        const body = {
            message: 'ZotGit PDF sync update: ' + remotePath,
            content,
            branch: config.branch
        };
        if (existingSha) body.sha = existingSha;

        await this._requestJSON(url, {
            method: 'PUT',
            headers: this._getHeaders(config.token),
            body: JSON.stringify(body)
        }, onProgress);
    }

    async _pushPDFFiles(config, onProgress = null)
    {
        if (!this._isPDFSyncEnabled())
        {
            this._emitProgress(onProgress, 'Push: PDF sync disabled');
            return { uploaded: 0 };
        }

        const baseDir = this._getLocalPDFBaseDir();
        try
        {
            await IOUtils.makeDirectory(baseDir, { createAncestors: true });
        }
        catch (e)
        {
            // already exists
        }
        this._emitProgress(onProgress, 'Push: scanning local PDFs from ' + baseDir);

        const files = await this._collectLocalPDFFiles(baseDir);
        const pdfRoot = this._getPDFRootPath();
        this._emitProgress(onProgress, 'Push: found ' + files.length + ' PDF files');

        let uploaded = 0;
        for (let file of files)
        {
            const remotePath = this._joinRemotePath(pdfRoot, file.relativePath);
            this._emitProgress(onProgress, 'Push: uploading PDF ' + file.relativePath);

            const bytes = await IOUtils.read(file.fullPath);
            await this._pushSinglePDF(config, remotePath, bytes, onProgress);
            uploaded += 1;
        }

        this._emitProgress(onProgress, 'Push: uploaded ' + uploaded + ' PDF files');
        return { uploaded };
    }

    async _cleanupLocalPDFCache(onProgress = null)
    {
        if (!this.isRemotePDFModeEnabled()) return 0;

        const baseDir = this._getLocalPDFBaseDir();
        let files = await this._collectLocalPDFFiles(baseDir);
        let removed = 0;

        for (let file of files)
        {
            try
            {
                await IOUtils.remove(file.fullPath);
                removed += 1;
            }
            catch (e)
            {
                // File might be in use, leave it for next cleanup pass
            }
        }

        this._emitProgress(onProgress, 'Push: cache cleanup removed ' + removed + ' local PDF files');
        return removed;
    }

    async ensureAttachmentLocal(item, onProgress = null)
    {
        if (!this.isRemotePDFModeEnabled())
        {
            Zotero.debug('ZotGit Recall: skipped – remote PDF mode is disabled');
            return null;
        }
        if (!item || !item.isFileAttachment || !item.isFileAttachment())
        {
            Zotero.debug('ZotGit Recall: skipped – item is not a file attachment');
            return null;
        }

        let config = null;
        try
        {
            config = this._getConfig();
        }
        catch (e)
        {
            Zotero.debug('ZotGit Recall: aborted – GitHub config missing: ' + e.message);
            return null;
        }

        let baseDir = '';
        try
        {
            baseDir = this._getLocalPDFBaseDir();
        }
        catch (e)
        {
            Zotero.debug('ZotGit Recall: aborted – cannot resolve local PDF dir: ' + e.message);
            return null;
        }

        const rawAttachmentPath = (item.attachmentPath || '').trim();
        const normalizedAttachmentPath = rawAttachmentPath.replace(/\//g, '\\');

        let targetLocalPath = null;
        if (rawAttachmentPath && this._isAbsolutePath(rawAttachmentPath))
        {
            targetLocalPath = normalizedAttachmentPath;
        }

        let relative = this._getAttachmentRemoteRelative(item, baseDir);
        if (!relative && targetLocalPath)
        {
            relative = this._normalizeRelativePath(this._getPathBasename(targetLocalPath));
        }
        if (!relative)
        {
            Zotero.debug('ZotGit Recall: aborted – cannot compute relative path. attachmentPath=' + rawAttachmentPath + ' baseDir=' + baseDir);
            return null;
        }

        const localPath = targetLocalPath || this._remoteRelativeToLocal(baseDir, relative);
        if (!localPath)
        {
            Zotero.debug('ZotGit Recall: aborted – cannot resolve local path for ' + relative);
            return null;
        }

        try
        {
            // File already in cache – return its path directly
            if (await IOUtils.exists(localPath))
            {
                Zotero.debug('ZotGit Recall: cache hit – ' + localPath);
                return localPath;
            }
        }
        catch (e)
        {
            // continue to download
        }

        Zotero.debug('ZotGit Recall: cache miss – need to download ' + relative + ' to ' + localPath);

        let remotePath = this._joinRemotePath(this._getPDFRootPath(), relative);
        this._emitProgress(onProgress, 'Recall: downloading ' + relative);

        let remoteFile = null;
        try
        {
            remoteFile = await this._requestJSON(this._buildRepoContentsUrl(config, remotePath, true), {
                method: 'GET',
                headers: this._getHeaders(config.token)
            }, onProgress);
        }
        catch (e)
        {
            Zotero.debug('ZotGit Recall: direct path fetch failed (HTTP ' + (e.status || '?') + ') for ' + remotePath + ' – ' + e.message);

            // For any fetch failure, try searching by filename as fallback
            const filename = this._getPathBasename(relative);
            this._emitProgress(onProgress, 'Recall: searching by filename ' + filename);
            let matchedRemotePath = null;
            try
            {
                matchedRemotePath = await this._findRemotePDFPathByFilename(config, filename, onProgress);
            }
            catch (searchErr)
            {
                Zotero.debug('ZotGit Recall: filename search also failed – ' + searchErr.message);
            }

            if (!matchedRemotePath)
            {
                Zotero.debug('ZotGit Recall: could not locate ' + filename + ' in remote repo');
                return null;
            }

            Zotero.debug('ZotGit Recall: found via filename search at ' + matchedRemotePath);
            remotePath = matchedRemotePath;
            try
            {
                remoteFile = await this._requestJSON(this._buildRepoContentsUrl(config, remotePath, true), {
                    method: 'GET',
                    headers: this._getHeaders(config.token)
                }, onProgress);
            }
            catch (e2)
            {
                Zotero.debug('ZotGit Recall: download of fallback path also failed – ' + e2.message);
                return null;
            }
        }

        if (!remoteFile || !remoteFile.content)
        {
            Zotero.debug('ZotGit Recall: remote file response empty for ' + remotePath);
            return null;
        }

        const bytes = this._base64ToUint8(remoteFile.content);
        const parentDir = PathUtils.parent(localPath);
        try
        {
            await IOUtils.makeDirectory(parentDir, { createAncestors: true });
        }
        catch (e)
        {
            // already exists
        }

        await IOUtils.write(localPath, bytes);
        Zotero.debug('ZotGit Recall: successfully wrote ' + bytes.length + ' bytes to ' + localPath);

        return localPath;
    }

    async _pullPDFFiles(config, onProgress = null)
    {
        if (!this._isPDFSyncEnabled())
        {
            this._emitProgress(onProgress, 'Pull: PDF sync disabled');
            return { downloaded: 0 };
        }

        const baseDir = this._getLocalPDFBaseDir();
        const pdfRoot = this._getPDFRootPath();

        this._emitProgress(onProgress, 'Pull: listing remote PDF files under ' + pdfRoot);
        const remoteFiles = await this._listRemoteFilesRecursive(config, pdfRoot, onProgress);
        const pdfFiles = remoteFiles.filter(path => path.toLowerCase().endsWith('.pdf'));
        this._emitProgress(onProgress, 'Pull: found ' + pdfFiles.length + ' remote PDF files');

        let downloaded = 0;
        for (let remotePath of pdfFiles)
        {
            const relative = remotePath.substring(pdfRoot.length).replace(/^\/+/, '');
            if (!relative) continue;

            this._emitProgress(onProgress, 'Pull: downloading PDF ' + relative);

            const remoteFile = await this._requestJSON(this._buildRepoContentsUrl(config, remotePath, true), {
                method: 'GET',
                headers: this._getHeaders(config.token)
            }, onProgress);

            if (!remoteFile || !remoteFile.content) continue;

            const bytes = this._base64ToUint8(remoteFile.content);
            const localPath = this._remoteRelativeToLocal(baseDir, relative);
            const parentDir = PathUtils.parent(localPath);

            try
            {
                await IOUtils.makeDirectory(parentDir, { createAncestors: true });
            }
            catch (e)
            {
                // Directory might already exist
            }
            await IOUtils.write(localPath, bytes);
            downloaded += 1;
        }

        this._emitProgress(onProgress, 'Pull: downloaded ' + downloaded + ' PDF files');
        return { downloaded };
    }

    _parseRepository(repository)
    {
        Zotero.debug('ZotGit Sync: parse repository input=' + (repository || '<empty>'));
        let segments = repository.split('/').map(e => e.trim()).filter(Boolean);
        if (segments.length != 2) throw new Error('Repository must be in the format owner/repo');

        return {
            owner: segments[0],
            repo: segments[1]
        };
    }

    _getConfig()
    {
        const repository = (this._getSyncPref('repository') || '').trim();
        const branch = (this._getSyncPref('branch') || '').trim() || 'main';
        const filepath = (this._getSyncPref('filepath') || '').trim() || 'zotgit-settings.json';
        const token = (this._getSyncPref('token') || '').trim();

        Zotero.debug('ZotGit Sync: config read repository=' + (repository || '<empty>')
            + ' branch=' + branch
            + ' filepath=' + filepath
            + ' tokenPresent=' + (!!token));

        if (!repository) throw new Error('Missing repository value');
        if (!token) throw new Error('Missing Personal Access Token');

        const { owner, repo } = this._parseRepository(repository);

        return {
            owner,
            repo,
            branch,
            filepath,
            token
        };
    }

    _getTokenConfig()
    {
        const token = (this._getSyncPref('token') || '').trim();
        if (!token) throw new Error('Missing Personal Access Token');
        return { token };
    }

    async checkGitHubAuth({ onProgress = null } = {})
    {
        Zotero.debug('ZotGit Sync: checkGitHubAuth called');
        try
        {
            const { token } = this._getTokenConfig();
            const user = await this._requestJSON('https://api.github.com/user', {
                method: 'GET',
                headers: this._getHeaders(token)
            }, onProgress);

            const login = user && user.login ? user.login : '';
            if (!login) throw new Error('Unable to determine authenticated user');

            return { ok: true, login, message: 'Authenticated as ' + login };
        }
        catch (e)
        {
            return { ok: false, message: e.message };
        }
    }

    async listGitHubRepositories({ onProgress = null } = {})
    {
        Zotero.debug('ZotGit Sync: listGitHubRepositories called');
        try
        {
            const { token } = this._getTokenConfig();
            const repos = await this._requestJSON('https://api.github.com/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', {
                method: 'GET',
                headers: this._getHeaders(token)
            }, onProgress);

            if (!Array.isArray(repos)) throw new Error('Invalid repository list response');

            const normalized = repos
                .filter(repo => repo && repo.full_name)
                .map(repo => ({
                    full_name: repo.full_name,
                    private: !!repo.private,
                    canPush: !!(repo.permissions && repo.permissions.push)
                }))
                .sort((a, b) => a.full_name.localeCompare(b.full_name));

            Zotero.debug('ZotGit Sync: listGitHubRepositories loaded count=' + normalized.length);

            return { ok: true, repositories: normalized, message: 'Loaded ' + normalized.length + ' repositories' };
        }
        catch (e)
        {
            Zotero.debug('ZotGit Sync: listGitHubRepositories failed: ' + e.message);
            return { ok: false, repositories: [], message: e.message };
        }
    }

    async createGitHubRepository({ name, privateRepo = true, onProgress = null } = {})
    {
        try
        {
            const repoName = (name || '').trim();
            if (!repoName) throw new Error('Repository name is required');

            const { token } = this._getTokenConfig();
            const created = await this._requestJSON('https://api.github.com/user/repos', {
                method: 'POST',
                headers: this._getHeaders(token),
                body: JSON.stringify({
                    name: repoName,
                    private: !!privateRepo,
                    auto_init: true
                })
            }, onProgress);

            if (!created || !created.full_name) throw new Error('Failed to create repository');

            this._setSyncPref('repository', created.full_name);
            this._setSyncPref('branch', (created.default_branch || 'main'));

            return {
                ok: true,
                repository: created.full_name,
                branch: created.default_branch || 'main',
                message: 'Created repository ' + created.full_name
            };
        }
        catch (e)
        {
            return { ok: false, message: e.message };
        }
    }

    _getAllZotMoovPrefKeys()
    {
        const prefBranch = Services.prefs.getBranch(this._prefPrefix);
        return prefBranch.getChildList('').map(pref => this._prefPrefix + pref);
    }

    _shouldExcludePref(pref)
    {
        if (this._excludedPrefKeys.has(pref)) return true;
        if (pref.startsWith(this._syncPrefix)) return true;

        return false;
    }

    _sanitizeObject(obj)
    {
        if (Array.isArray(obj)) return obj.map(e => this._sanitizeObject(e));

        if (obj && typeof obj == 'object')
        {
            let sanitizedObj = {};
            for (let [key, value] of Object.entries(obj))
            {
                sanitizedObj[key] = this._sanitizeObject(value);
            }

            return sanitizedObj;
        }

        return obj;
    }

    _sanitizePrefValue(pref, value)
    {
        if (!this._jsonPrefKeys.has(pref)) return value;

        try
        {
            let parsed = JSON.parse(value);
            let sanitized = this._sanitizeObject(parsed);
            return JSON.stringify(sanitized);
        }
        catch (e)
        {
            return value;
        }
    }

    _collectPrefsPayload()
    {
        let prefs = {};
        for (let pref of this._getAllZotMoovPrefKeys())
        {
            if (this._shouldExcludePref(pref)) continue;

            let value = Zotero.Prefs.get(pref, true);
            if (value == undefined) continue;

            value = this._sanitizePrefValue(pref, value);

            prefs[pref] = {
                type: typeof value,
                value: value
            };
        }

        return {
            schema_version: 1,
            updated_at: new Date().toISOString(),
            prefs
        };
    }

    _setPrefFromPayload(pref, entry)
    {
        if (entry == null || typeof entry != 'object') return;
        if (!Object.prototype.hasOwnProperty.call(entry, 'value')) return;

        if (entry.type == 'boolean')
        {
            Zotero.Prefs.set(pref, !!entry.value, true);
            return;
        }

        if (entry.type == 'number')
        {
            Zotero.Prefs.set(pref, Number(entry.value), true);
            return;
        }

        Zotero.Prefs.set(pref, String(entry.value), true);
    }

    _applyPayload(payload, refreshMenus = true)
    {
        if (!payload || typeof payload != 'object') throw new Error('Sync payload must be an object');
        if (!payload.prefs || typeof payload.prefs != 'object') throw new Error('Sync payload is missing prefs object');

        const payloadPrefKeys = new Set(Object.keys(payload.prefs));
        for (let pref of this._getAllZotMoovPrefKeys())
        {
            if (!pref.startsWith('extensions.zotmoov.keys.custom.')) continue;
            if (payloadPrefKeys.has(pref)) continue;

            Zotero.Prefs.clear(pref, true);
        }

        for (let [pref, entry] of Object.entries(payload.prefs))
        {
            if (!pref.startsWith(this._prefPrefix)) continue;
            if (this._shouldExcludePref(pref)) continue;

            this._setPrefFromPayload(pref, entry);
        }

        if (refreshMenus && this._zotmoovMenus && typeof this._zotmoovMenus.refreshFromPrefs == 'function')
        {
            this._zotmoovMenus.refreshFromPrefs();
        }
    }

    _toBase64(str)
    {
        let bytes = new TextEncoder().encode(str);
        let binary = '';

        for (let b of bytes)
        {
            binary += String.fromCharCode(b);
        }

        return btoa(binary);
    }

    _fromBase64(encoded)
    {
        let binary = atob((encoded || '').replace(/\n/g, ''));
        let bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        return new TextDecoder().decode(bytes);
    }

    _getHeaders(token)
    {
        return {
            'Accept': 'application/vnd.github+json',
            'Authorization': 'Bearer ' + token,
            'Content-Type': 'application/json'
        };
    }

    async _requestJSON(url, options, onProgress = null)
    {
        const hasAbortController = (typeof AbortController != 'undefined');
        const controller = hasAbortController ? new AbortController() : null;
        let hardTimeoutID = null;

        let response = null;
        let body = null;

        try
        {
            this._emitProgress(onProgress, 'Request: ' + (options.method || 'GET') + ' ' + url);

            const timeoutPromise = new Promise((_, reject) => {
                hardTimeoutID = setTimeout(() => {
                    if (controller) controller.abort();
                    reject(new Error('GitHub request timed out after 30 seconds'));
                }, this.constructor.REQUEST_TIMEOUT_MS);
            });

            const fetchOptions = {
                ...options
            };
            if (controller) fetchOptions.signal = controller.signal;

            response = await Promise.race([
                fetch(url, fetchOptions),
                timeoutPromise
            ]);

            this._emitProgress(onProgress, 'Response: HTTP ' + response.status);

            const text = await response.text();
            if (text)
            {
                try
                {
                    body = JSON.parse(text);
                }
                catch (e)
                {
                    body = null;
                }
            }
        }
        catch (e)
        {
            if (e && e.name == 'AbortError')
            {
                throw new Error('GitHub request timed out after 30 seconds');
            }

            throw e;
        }
        finally
        {
            if (hardTimeoutID) clearTimeout(hardTimeoutID);
        }

        if (!response.ok)
        {
            let message = 'GitHub request failed (' + response.status + ')';
            if (body && body.message) message += ': ' + body.message;

            const error = new Error(message);
            error.status = response.status;
            throw error;
        }

        return body;
    }

    _toGitHubContentPath(path)
    {
        return path.split('/').filter(Boolean).map(segment => encodeURIComponent(segment)).join('/');
    }

    _buildContentUrl(config, includeRef = true)
    {
        const owner = encodeURIComponent(config.owner);
        const repo = encodeURIComponent(config.repo);
        const path = this._toGitHubContentPath(config.filepath);

        let url = 'https://api.github.com/repos/' + owner + '/' + repo + '/contents/' + path;
        if (includeRef)
        {
            url += '?ref=' + encodeURIComponent(config.branch);
        }

        return url;
    }

    _markSyncSuccess(remoteSha = '')
    {
        this._setSyncPref('last_remote_sha', remoteSha);
        this._setSyncPref('last_sync_time', Date.now());
    }

    async pullFromGitHub({ refreshMenus = true, onProgress = null } = {})
    {
        try
        {
            this._emitProgress(onProgress, 'Pull: validating configuration');
            const config = this._getConfig();
            this._emitProgress(onProgress, 'Pull: configuration OK');

            const url = this._buildContentUrl(config, true);
            this._emitProgress(onProgress, 'Pull: downloading settings file');
            const result = await this._requestJSON(url, {
                method: 'GET',
                headers: this._getHeaders(config.token)
            }, onProgress);

            if (!result || !result.content) throw new Error('Remote settings file is empty or invalid');

            this._emitProgress(onProgress, 'Pull: decoding remote file content');
            const decoded = this._fromBase64(result.content);
            const payload = JSON.parse(decoded);

            this._emitProgress(onProgress, 'Pull: applying preferences locally');
            this._applyPayload(payload, refreshMenus);

            let pdfResult = { downloaded: 0 };
            if (this.isRemotePDFModeEnabled())
            {
                this._emitProgress(onProgress, 'Pull: remote PDF mode enabled, skipping bulk PDF download (on-demand recall only)');
            }
            else
            {
                this._emitProgress(onProgress, 'Pull: syncing PDF files');
                pdfResult = await this._pullPDFFiles(config, onProgress);
            }

            this._markSyncSuccess(result.sha || '');

            this._emitProgress(onProgress, 'Pull: completed');

            this._debugger.info('GitHub sync pull succeeded');
            return { ok: true, message: 'Pull succeeded (' + pdfResult.downloaded + ' PDFs downloaded)' };
        }
        catch (e)
        {
            this._emitProgress(onProgress, 'Pull error: ' + e.message);
            this._debugger.error('GitHub sync pull failed: ' + e.message);
            return { ok: false, message: e.message };
        }
    }

    async pushToGitHub({ onProgress = null } = {})
    {
        if (this._pushInProgress)
        {
            this._emitProgress(onProgress, 'Push already in progress, waiting for completion');
            return this._pushPromise || { ok: false, message: 'Push already in progress' };
        }

        this._pushInProgress = true;
        let resolvePushPromise = null;
        this._pushPromise = new Promise(resolve => {
            resolvePushPromise = resolve;
        });
        let result = null;

        try
        {
            this._emitProgress(onProgress, 'Push: validating configuration');
            const config = this._getConfig();
            this._emitProgress(onProgress, 'Push: configuration OK');

            this._emitProgress(onProgress, 'Push: collecting local preferences');
            const payload = this._collectPrefsPayload();
            const content = this._toBase64(JSON.stringify(payload, null, 2));

            const contentUrl = this._buildContentUrl(config, false);

            let existingSha = null;
            try
            {
                this._emitProgress(onProgress, 'Push: checking remote file state');
                const existing = await this._requestJSON(this._buildContentUrl(config, true), {
                    method: 'GET',
                    headers: this._getHeaders(config.token)
                }, onProgress);

                existingSha = existing.sha || null;
            }
            catch (e)
            {
                if (e.status != 404) throw e;
                this._emitProgress(onProgress, 'Push: remote file does not exist yet, creating new file');
            }

            const body = {
                message: 'ZotGit settings sync update',
                content: content,
                branch: config.branch
            };
            if (existingSha) body.sha = existingSha;

            this._emitProgress(onProgress, 'Push: uploading settings file');
            const uploadResult = await this._requestJSON(contentUrl, {
                method: 'PUT',
                headers: this._getHeaders(config.token),
                body: JSON.stringify(body)
            }, onProgress);

            const sha = uploadResult && uploadResult.content ? uploadResult.content.sha || '' : '';
            this._markSyncSuccess(sha);

            this._emitProgress(onProgress, 'Push: syncing PDF files');
            const pdfResult = await this._pushPDFFiles(config, onProgress);

            this._emitProgress(onProgress, 'Push: completed');

            this._debugger.info('GitHub sync push succeeded');
            result = { ok: true, message: 'Push succeeded (' + pdfResult.uploaded + ' PDFs uploaded)' };
        }
        catch (e)
        {
            this._emitProgress(onProgress, 'Push error: ' + e.message);
            this._debugger.error('GitHub sync push failed: ' + e.message);
            result = { ok: false, message: e.message };
        }
        finally
        {
            this._pushInProgress = false;
            this._scheduleAfterPushResult(result ? result.ok : false);
            if (resolvePushPromise) resolvePushPromise(result || { ok: false, message: 'Push failed' });
            this._pushPromise = null;
        }

        return result;
    }
}
