var React = require('react');
var ReactDOM = require('react-dom');
var VirtualizedTable = require('components/virtualized-table');

class ZotMoovPrefs {
    static get REPO_PREF() { return 'extensions.zotmoov.sync.github.repository'; }
    static get REPO_PREF_BACKUP() { return 'extensions.zotmoov.sync.github.repository_backup'; }

    // Needed to fix Zotero bug where on initial load all of the elements are not
    // loaded because of faulty race-condition when calculating div height
    static FixedVirtualizedTable = class extends VirtualizedTable {
        _getWindowedListOptions() {
            let v = super._getWindowedListOptions();
            v.overscanCount = 10;

            return v;
        }
    }

    constructor(zotmoovMenus)
    {
        this.zotmoovMenus = zotmoovMenus;
        this._initializedDocs = new WeakSet();
    }

    _getSyncElements()
    {
        return {
            repoInput: document.getElementById('zotmoov-settings-sync-repo-input'),
            tokenInput: document.getElementById('zotmoov-settings-sync-token-input'),
            repoPicker: document.getElementById('zotmoov-settings-sync-repo-picker'),
            branchEl: document.getElementById('zotmoov-settings-sync-branch-input'),
            filepathEl: document.getElementById('zotmoov-settings-sync-filepath-input')
        };
    }

    _setRepositoryPref(value)
    {
        const repo = (value || '').trim();
        this._appendSyncLog('Persist repository pref: ' + (repo || '<empty>'));
        Zotero.Prefs.set(this.constructor.REPO_PREF, repo, true);
        Zotero.Prefs.set(this.constructor.REPO_PREF_BACKUP, repo, true);
        this._ensurePickerShowsRepository(repo);
    }

    _getRepositoryPref()
    {
        const repo = (Zotero.Prefs.get(this.constructor.REPO_PREF, true) || '').trim();
        if (repo)
        {
            this._appendSyncLog('Read repository pref: ' + repo);
            return repo;
        }

        const backupRepo = (Zotero.Prefs.get(this.constructor.REPO_PREF_BACKUP, true) || '').trim();
        if (!backupRepo)
        {
            this._appendSyncLog('Read repository pref: <empty> (no backup)');
            return '';
        }

        Zotero.Prefs.set(this.constructor.REPO_PREF, backupRepo, true);
        this._appendSyncLog('Recovered repository pref from backup: ' + backupRepo);
        return backupRepo;
    }

    _extractPickerRepositoryValue(picker)
    {
        if (!picker) return '';

        let value = (picker.value || '').trim();

        if (!value && picker.selectedItem)
        {
            value = (picker.selectedItem.getAttribute('value') || picker.selectedItem.value || '').trim();
        }

        if (!value && picker.selectedItem)
        {
            const label = (picker.selectedItem.getAttribute('label') || picker.selectedItem.label || '').trim();
            const match = label.match(/^[^\s\/]+\/[^(\s]+/);
            value = match ? match[0].trim() : '';
        }

        return value;
    }

    _ensurePickerShowsRepository(repo)
    {
        const picker = document.getElementById('zotmoov-settings-sync-repo-picker');
        const popup = document.getElementById('zotmoov-settings-sync-repo-picker-popup');
        if (!picker || !popup) return;

        const cleanRepo = (repo || '').trim();
        if (!cleanRepo)
        {
            picker.selectedIndex = -1;
            picker.value = '';
            return;
        }

        let existingIndex = -1;
        for (let i = 0; i < popup.childNodes.length; i++)
        {
            const item = popup.childNodes[i];
            const itemValue = ((item.getAttribute && item.getAttribute('value')) || item.value || '').trim();
            if (itemValue == cleanRepo)
            {
                existingIndex = i;
                break;
            }
        }

        if (existingIndex < 0)
        {
            const item = (typeof document.createXULElement == 'function')
                ? document.createXULElement('menuitem')
                : document.createElement('menuitem');
            item.setAttribute('label', cleanRepo);
            item.setAttribute('value', cleanRepo);
            popup.appendChild(item);
            existingIndex = popup.childNodes.length - 1;
        }

        picker.selectedIndex = existingIndex;
        picker.value = cleanRepo;
        this._appendSyncLog('Picker display synced to repository: ' + cleanRepo);
    }

    _persistSyncFields({ allowEmptyRepo = false } = {})
    {
        try
        {
            const repoInput = document.getElementById('zotmoov-settings-sync-repo-input');
            if (repoInput)
            {
                const repoValue = (repoInput.value || '').trim();
                if (repoValue || allowEmptyRepo) this._setRepositoryPref(repoValue);
            }

            const syncFields = [
                { id: 'zotmoov-settings-sync-token-input', pref: 'extensions.zotmoov.sync.github.token' },
            ];

            for (let { id, pref } of syncFields)
            {
                const el = document.getElementById(id);
                if (!el) continue;
                Zotero.Prefs.set(pref, (el.value || '').trim(), true);
            }

            const branchEl = document.getElementById('zotmoov-settings-sync-branch-input');
            if (branchEl) Zotero.Prefs.set('extensions.zotmoov.sync.github.branch', (branchEl.value || '').trim() || 'main', true);

            const filepathEl = document.getElementById('zotmoov-settings-sync-filepath-input');
            if (filepathEl) Zotero.Prefs.set('extensions.zotmoov.sync.github.filepath', (filepathEl.value || '').trim() || 'zotgit-settings.json', true);

            const persistedRepo = this._getRepositoryPref();
            const persistedBranch = (Zotero.Prefs.get('extensions.zotmoov.sync.github.branch', true) || '').trim();
            const persistedPath = (Zotero.Prefs.get('extensions.zotmoov.sync.github.filepath', true) || '').trim();
            this._appendSyncLog('Persist sync fields (allowEmptyRepo=' + allowEmptyRepo + '): repo=' + (persistedRepo || '<empty>') + ' branch=' + (persistedBranch || '<empty>') + ' filepath=' + (persistedPath || '<empty>'));
        }
        catch (e)
        {
            Zotero.logError(e);
            this._appendSyncLog('Persist sync fields failed: ' + e.message);
        }
    }

    _appendSyncLog(message)
    {
        Zotero.debug('ZotGit Sync: ' + message);
    }

    clearSyncLog()
    {
        // No-op: retained for compatibility with older UI builds
    }

    createFileExtTree()
    {
        let allowed = Zotero.Prefs.get('extensions.zotmoov.allowed_fileext', true);
        try
        {
            this._fileexts = JSON.parse(allowed);
            if (!Array.isArray(this._fileexts)) this._fileexts = [];
        }
        catch (e)
        {
            this._fileexts = [];
            Zotero.Prefs.set('extensions.zotmoov.allowed_fileext', JSON.stringify(this._fileexts), true);
        }

        const treeRoot = document.getElementById('zotmoov-settings-fileext-tree-2');
        if (!treeRoot) return;

        const columns = [
            {
                dataKey: 'fileext',
                label: 'fileext'
            }
        ];
        
        let renderItem = (index, selection, oldDiv=null, columns) => {
            const ext = this._fileexts[index];
            let div;

            if (oldDiv)
            {
                div = oldDiv;
                div.innerHTML = '';
            } else {
                div = document.createElement('div');
                div.className = 'row';
            }

            div.classList.toggle('selected', selection.isSelected(index));
            div.classList.toggle('focused', selection.focused == index);

            for (let column of columns)
            {
                div.appendChild(VirtualizedTable.renderCell(index, ext, column));
            }

            return div;
        };

        ReactDOM.createRoot(treeRoot).render(React.createElement(this.constructor.FixedVirtualizedTable, {
            getRowCount: () => this._fileexts.length,
            id: 'zotmoov-settings-fileext-tree-2-treechildren',
            ref: (ref) => { this._fileext_tree = ref; },
            renderItem: renderItem,
            onSelectionChange: (selection) => this.onFileExtTreeSelect(selection),
            showHeader: false,
            columns: columns,
            staticColumns: true,
            multiSelect: true,
            disableFontSizeScaling: true
        }));
    }

    init()
    {
        const paneDoc = document;
        if (this._initializedDocs.has(paneDoc))
        {
            this._appendSyncLog('Prefs init skipped for current pane (already initialized)');
            return;
        }

        const syncElements = this._getSyncElements();
        if (!syncElements.repoInput || !syncElements.branchEl || !syncElements.filepathEl)
        {
            this._appendSyncLog('Prefs init deferred: sync UI not ready yet');
            return;
        }

        this._initializedDocs.add(paneDoc);

        this._appendSyncLog('Prefs init started');

        try
        {
            let enable_subdir_move = Zotero.Prefs.get('extensions.zotmoov.enable_subdir_move', true);
            const subdirInput = document.getElementById('zotmoov-subdir-str');
            if (subdirInput) subdirInput.disabled = !enable_subdir_move;

            this._setSyncStatus('zotmoov-adv-settings-sync-status-idle');

            // Explicitly load all sync text fields — html:input elements do not reliably
            // pick up the 'preference' attribute value in Zotero 7 inline panes.
            const repoInput = syncElements.repoInput;
            if (repoInput) repoInput.value = this._getRepositoryPref();
            this._ensurePickerShowsRepository(repoInput ? repoInput.value : '');

            const syncFields = [
                { id: 'zotmoov-settings-sync-token-input', pref: 'extensions.zotmoov.sync.github.token' },
            ];
            for (let { id, pref } of syncFields)
            {
                const el = document.getElementById(id);
                if (el) el.value = Zotero.Prefs.get(pref, true) || '';
            }
            // branch and filepath don't have IDs so we query by preference attribute
            const branchEl = syncElements.branchEl;
            if (branchEl) branchEl.value = Zotero.Prefs.get('extensions.zotmoov.sync.github.branch', true) || 'main';
            const filepathEl = syncElements.filepathEl;
            if (filepathEl) filepathEl.value = Zotero.Prefs.get('extensions.zotmoov.sync.github.filepath', true) || 'zotgit-settings.json';

            this._appendSyncLog('Loaded sync fields: repo=' + ((repoInput && repoInput.value) ? repoInput.value : '<empty>')
                + ' branch=' + ((branchEl && branchEl.value) ? branchEl.value : '<empty>')
                + ' filepath=' + ((filepathEl && filepathEl.value) ? filepathEl.value : '<empty>'));

            const persistOnClose = () => this._persistSyncFields({ allowEmptyRepo: false });
            window.addEventListener('pagehide', persistOnClose, { once: true });
            window.addEventListener('unload', persistOnClose, { once: true });
            window.addEventListener('visibilitychange', () => {
                if (document.visibilityState == 'hidden')
                {
                    this._appendSyncLog('Visibility hidden, persisting sync fields');
                    this._persistSyncFields({ allowEmptyRepo: false });
                }
            });

            const repoInputEl = syncElements.repoInput;
            const tokenInput = syncElements.tokenInput;
            const repoPicker = syncElements.repoPicker;
            if (repoInputEl) repoInputEl.addEventListener('change', () => this._persistSyncFields({ allowEmptyRepo: true }));
            if (tokenInput) tokenInput.addEventListener('change', () => this._persistSyncFields({ allowEmptyRepo: true }));
            if (branchEl) branchEl.addEventListener('change', () => this._persistSyncFields({ allowEmptyRepo: true }));
            if (filepathEl) filepathEl.addEventListener('change', () => this._persistSyncFields({ allowEmptyRepo: true }));
            if (repoPicker) repoPicker.addEventListener('command', () => this.syncUseSelectedRepository());

            this.syncAutoPushToggled();
            this.syncRemoteModeToggled();
            this._appendSyncLog('Prefs init finished');
        }
        catch (e)
        {
            Zotero.logError(e);
            this._appendSyncLog('Prefs init failed: ' + e.message);
            this._initializedDocs.delete(paneDoc);
        }

        try
        {
            this.createFileExtTree();
        }
        catch (e)
        {
            Zotero.logError(e);
        }
    }

    syncRemoteModeToggled()
    {
        const remoteEnabled = Zotero.Prefs.get('extensions.zotmoov.sync.github.remote_pdf_mode', true);
        const dstInput = document.getElementById('zotmoov-dst-dir');
        const dstButton = document.getElementById('zotmoov-dst-dir-button');
        const remoteNote = document.getElementById('zotmoov-dst-dir-remote-note');

        if (dstInput) dstInput.disabled = !!remoteEnabled;
        if (dstButton) dstButton.disabled = !!remoteEnabled;
        if (remoteNote) remoteNote.hidden = !remoteEnabled;
    }

    _setSyncStatus(fluentID)
    {
        const status = document.getElementById('zotmoov-settings-sync-status');
        if (!status) return;

        status.setAttribute('data-l10n-id', fluentID);
    }

    _setSyncButtonsDisabled(disabled)
    {
        let pullButton = document.getElementById('zotmoov-settings-sync-pull');
        let pushButton = document.getElementById('zotmoov-settings-sync-push');

        if (pullButton) pullButton.disabled = disabled;
        if (pushButton) pushButton.disabled = disabled;
    }

    _setSyncSetupButtonsDisabled(disabled)
    {
        const ids = [
            'zotmoov-settings-sync-load-repos',
            'zotmoov-settings-sync-use-repo',
            'zotmoov-settings-sync-open-token-page',
            'zotmoov-settings-sync-check-auth',
            'zotmoov-settings-sync-create-repo'
        ];

        for (let id of ids)
        {
            const el = document.getElementById(id);
            if (el) el.disabled = disabled;
        }
    }

    syncOpenTokenSetup()
    {
        Zotero.launchURL('https://github.com/settings/tokens/new?scopes=repo&description=ZotGit%20Sync');
    }

    async syncCheckAuth()
    {
        if (!Zotero.ZotMoov.Sync || typeof Zotero.ZotMoov.Sync.checkGitHubAuth != 'function')
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            return;
        }

        try
        {
            this._setSyncSetupButtonsDisabled(true);
            const result = await Zotero.ZotMoov.Sync.checkGitHubAuth({
                onProgress: (msg) => this._appendSyncLog(msg)
            });

            this._setSyncStatus(result.ok ? 'zotmoov-adv-settings-sync-status-success' : 'zotmoov-adv-settings-sync-status-failed');
            const status = document.getElementById('zotmoov-settings-sync-status');
            if (status) status.setAttribute('tooltiptext', result.message || '');
        }
        catch (e)
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
        }
        finally
        {
            this._setSyncSetupButtonsDisabled(false);
        }
    }

    async syncLoadRepositories()
    {
        if (!Zotero.ZotMoov.Sync || typeof Zotero.ZotMoov.Sync.listGitHubRepositories != 'function')
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            return;
        }

        const popup = document.getElementById('zotmoov-settings-sync-repo-picker-popup');
        const picker = document.getElementById('zotmoov-settings-sync-repo-picker');
        if (!popup || !picker) return;

        this._appendSyncLog('Loading repositories from GitHub');

        try
        {
            this._setSyncSetupButtonsDisabled(true);
            const result = await Zotero.ZotMoov.Sync.listGitHubRepositories({
                onProgress: (msg) => this._appendSyncLog(msg)
            });

            while (popup.firstChild)
            {
                popup.removeChild(popup.firstChild);
            }

            if (!result.ok)
            {
                this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
                const status = document.getElementById('zotmoov-settings-sync-status');
                if (status) status.setAttribute('tooltiptext', result.message || '');
                return;
            }

            const savedRepo = this._getRepositoryPref();
            let savedRepoIndex = -1;

            for (let repo of result.repositories)
            {
                const item = (typeof document.createXULElement == 'function')
                    ? document.createXULElement('menuitem')
                    : document.createElement('menuitem');
                item.setAttribute('label', repo.full_name + (repo.private ? ' (private)' : ' (public)'));
                item.setAttribute('value', repo.full_name);
                if (!repo.canPush)
                {
                    item.setAttribute('disabled', true);
                }
                popup.appendChild(item);

                if (savedRepo && repo.full_name === savedRepo)
                {
                    savedRepoIndex = popup.childNodes.length - 1;
                }
            }

            if (result.repositories.length)
            {
                if (savedRepoIndex >= 0)
                {
                    picker.selectedIndex = savedRepoIndex;
                    picker.value = savedRepo;
                    const repoInput = document.getElementById('zotmoov-settings-sync-repo-input');
                    if (repoInput) repoInput.value = savedRepo;
                }
                else
                {
                    picker.selectedIndex = 0;
                    this.syncUseSelectedRepository();
                }
            }

            if (savedRepo) this._ensurePickerShowsRepository(savedRepo);

            this._appendSyncLog('Loaded repositories count: ' + result.repositories.length);

            this._setSyncStatus('zotmoov-adv-settings-sync-status-success');
            const status = document.getElementById('zotmoov-settings-sync-status');
            if (status) status.setAttribute('tooltiptext', result.message || '');
        }
        catch (e)
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            this._appendSyncLog('Load repositories failed: ' + e.message);
        }
        finally
        {
            this._setSyncSetupButtonsDisabled(false);
        }
    }

    syncUseSelectedRepository()
    {
        const picker = document.getElementById('zotmoov-settings-sync-repo-picker');
        const repoInput = document.getElementById('zotmoov-settings-sync-repo-input');
        if (!picker || !repoInput) return;

        const selectedValue = this._extractPickerRepositoryValue(picker);
        if (!selectedValue)
        {
            this._appendSyncLog('Use selected repository skipped: no picker value');
            return;
        }

        this._setRepositoryPref(selectedValue);
        repoInput.value = selectedValue;
        this._persistSyncFields({ allowEmptyRepo: true });
        this._setSyncStatus('zotmoov-adv-settings-sync-status-success');
        this._appendSyncLog('Use selected repository: ' + selectedValue);
    }

    syncRepositoryInputChanged(value)
    {
        this._setRepositoryPref(value || '');
    }

    async syncCreateRepository()
    {
        if (!Zotero.ZotMoov.Sync || typeof Zotero.ZotMoov.Sync.createGitHubRepository != 'function')
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            return;
        }

        const repoNamePrompt = window.prompt('Enter new repository name:', 'zotgit-library');
        const ok = repoNamePrompt !== null;
        if (!ok) return;

        const repoName = (repoNamePrompt || '').trim();
        if (!repoName) return;

        const privateRepo = window.confirm('Create this repository as private?\n(OK = Private, Cancel = Public)');

        try
        {
            this._setSyncSetupButtonsDisabled(true);
            const result = await Zotero.ZotMoov.Sync.createGitHubRepository({
                name: repoName,
                privateRepo,
                onProgress: (msg) => this._appendSyncLog(msg)
            });

            this._setSyncStatus(result.ok ? 'zotmoov-adv-settings-sync-status-success' : 'zotmoov-adv-settings-sync-status-failed');
            const status = document.getElementById('zotmoov-settings-sync-status');
            if (status) status.setAttribute('tooltiptext', result.message || '');

            if (result.ok)
            {
                const repoInput = document.getElementById('zotmoov-settings-sync-repo-input');
                if (repoInput) repoInput.value = result.repository;
                this._setRepositoryPref(result.repository);
                if (result.branch) Zotero.Prefs.set('extensions.zotmoov.sync.github.branch', result.branch, true);
                await this.syncLoadRepositories();
            }
        }
        catch (e)
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
        }
        finally
        {
            this._setSyncSetupButtonsDisabled(false);
        }
    }

    async syncPullFromGitHub()
    {
        if (!Zotero.ZotMoov.Sync)
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            this._appendSyncLog('Sync object is unavailable');
            return;
        }

        let result = null;
        try
        {
            this._setSyncButtonsDisabled(true);
            this._setSyncStatus('zotmoov-adv-settings-sync-status-pulling');
            this._appendSyncLog('Starting pull...');
            result = await Zotero.ZotMoov.Sync.pullFromGitHub({
                refreshMenus: true,
                onProgress: (msg) => this._appendSyncLog(msg)
            });

            this._setSyncStatus(result.ok ? 'zotmoov-adv-settings-sync-status-success' : 'zotmoov-adv-settings-sync-status-failed');
            this._appendSyncLog(result.ok ? 'Pull finished successfully' : 'Pull failed: ' + (result.message || 'Unknown error'));
            this.syncRemoteModeToggled();

            const status = document.getElementById('zotmoov-settings-sync-status');
            if (status) status.setAttribute('tooltiptext', result.message || '');
        }
        catch (e)
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            this._appendSyncLog('Unexpected pull exception: ' + e.message);
        }
        finally
        {
            this._setSyncButtonsDisabled(false);
        }
    }

    async syncPushToGitHub()
    {
        if (!Zotero.ZotMoov.Sync)
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            this._appendSyncLog('Sync object is unavailable');
            return;
        }

        let result = null;
        try
        {
            this._setSyncButtonsDisabled(true);
            this._setSyncStatus('zotmoov-adv-settings-sync-status-pushing');
            this._appendSyncLog('Starting push...');
            result = await Zotero.ZotMoov.Sync.pushToGitHub({
                onProgress: (msg) => this._appendSyncLog(msg)
            });

            this._setSyncStatus(result.ok ? 'zotmoov-adv-settings-sync-status-success' : 'zotmoov-adv-settings-sync-status-failed');
            this._appendSyncLog(result.ok ? 'Push finished successfully' : 'Push failed: ' + (result.message || 'Unknown error'));

            const status = document.getElementById('zotmoov-settings-sync-status');
            if (status) status.setAttribute('tooltiptext', result.message || '');
        }
        catch (e)
        {
            this._setSyncStatus('zotmoov-adv-settings-sync-status-failed');
            this._appendSyncLog('Unexpected push exception: ' + e.message);
        }
        finally
        {
            this._setSyncButtonsDisabled(false);
        }
    }

    syncAutoPushToggled()
    {
        if (!Zotero.ZotMoov.Sync) return;
        if (typeof Zotero.ZotMoov.Sync.configureAutoPushScheduler != 'function') return;

        Zotero.ZotMoov.Sync.configureAutoPushScheduler();
    }

    async pickDirectory()
    {
        if (Zotero.Prefs.get('extensions.zotmoov.sync.github.remote_pdf_mode', true))
        {
            return;
        }

        const { FilePicker } = ChromeUtils.importESModule('chrome://zotero/content/modules/filePicker.mjs');
        let fp = new FilePicker();

        fp.init(window, Zotero.getString('dataDir.selectDir'), fp.modeGetFolder);
        fp.appendFilters(fp.filterAll);
        
        let rv = await fp.show();
        if (rv != fp.returnOK) return '';

        Zotero.Prefs.set('extensions.zotmoov.dst_dir', fp.file, true);
        document.getElementById('zotmoov-dst-dir').value = fp.file;
    }


    onSubDirClick(cb)
    {
        document.getElementById('zotmoov-subdir-str').disabled = !cb.checked;
    }

    updateMenuItems(item)
    {
        let v = item.value;
        if(v == 'move')
        {
            this.zotmoovMenus.setMove();
        } else
        {
            this.zotmoovMenus.setCopy();
        }
    }

    createFileExtEntry(ext)
    {
        let len = this._fileexts.push(ext);
        this._fileext_tree.invalidate();

        let selection = this._fileext_tree.selection;
        for (let i of selection.selected)
        {
            selection.toggleSelect(i);
        }

        this._fileext_tree.invalidate();
        selection.toggleSelect(len - 1);

        Zotero.Prefs.set('extensions.zotmoov.allowed_fileext', JSON.stringify(this._fileexts), true);

    }

    spawnFileExtDialog()
    {
        window.openDialog('chrome://zotmoov/content/file-ext-dialog.xhtml', 'zotmoov-file-ext-dialog-window', 'chrome,centerscreen,resizable=no,modal');
    }

    removeFileExtEntries()
    {
        let selection = this._fileext_tree.selection;
        for (let index of Array.from(selection.selected).reverse())
        {
            this._fileexts.splice(index, 1);
        }

        this._fileext_tree.invalidate();

        const del_button = document.getElementById('zotmoov-fileext-table-delete');
        if (selection.focused > this._fileexts.length - 1)
        {
            del_button.disabled = true;
        }

        Zotero.Prefs.set('extensions.zotmoov.allowed_fileext', JSON.stringify(this._fileexts), true);
    }

    onFileExtTreeSelect(selection)
    {
        let remove_button = document.getElementById('zotmoov-fileext-table-delete');
        if (selection.count > 0)
        {
            remove_button.disabled = false;
            return;
        }

        remove_button.disabled = true;
    }
}

// Expose to Zotero
Zotero.ZotMoov.Prefs = new ZotMoovPrefs(Zotero.ZotMoov.Menus);

// Some Zotero inline preference panes do not fire element onload reliably.
// Ensure init runs once when the document is ready.
try
{
    if (document.readyState === 'complete' || document.readyState === 'interactive')
    {
        Zotero.ZotMoov.Prefs.init();
    }
    else
    {
        window.addEventListener('load', () => Zotero.ZotMoov.Prefs.init(), { once: true });
    }
}
catch (e) {}
