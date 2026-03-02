// ZotMoov
// bootstrap.js
// Author: Khodami Aaron

// Declare at top level
let zotmoov = null;
let zotmoovMenus = null;
let zotmoovBindings = null;
let zotmoovSync = null;
let chromeHandle = null;
let syncFinalized = false;
let syncFinalizePromise = null;

function log(msg)
{
    Zotero.debug('ZotMoov: ' + msg);
}

function getCacheDirCandidates()
{
    const dirs = new Set();
    try
    {
        const dataDir = (Zotero.DataDirectory && Zotero.DataDirectory.dir) ? Zotero.DataDirectory.dir : '';
        if (dataDir)
        {
            dirs.add(PathUtils.join(dataDir, 'zotgit-cache'));
            dirs.add(PathUtils.join(dataDir, 'zogit-cache'));
        }
    }
    catch (e) {}

    return Array.from(dirs).filter(Boolean);
}

function forceRemoveCacheDirsSync()
{
    const cacheDirs = getCacheDirCandidates();

    for (let dirPath of cacheDirs)
    {
        try
        {
            const file = Cc['@mozilla.org/file/local;1'].createInstance(Ci.nsIFile);
            file.initWithPath(dirPath);
            if (file.exists()) file.remove(true);
            Zotero.debug('ZotGit Shutdown: forced sync cache removal attempted for ' + dirPath);
        }
        catch (e)
        {
            Zotero.logError(e);
            Zotero.debug('ZotGit Shutdown: forced sync cache removal failed for ' + dirPath + ': ' + e.message);
        }
    }
}

async function install()
{
    log('ZotMoov: Installed');

    // Fix for old version parity
    let old_pref = Zotero.Prefs.get('extensions.zotmoov.dst_dir')
    if (old_pref)
    {
        Zotero.Prefs.set('extensions.zotmoov.dst_dir', old_pref, true);
        Zotero.Prefs.clear('extensions.zotmoov.dst_dir');
    }
}

async function startup({ id, version, resourceURI, rootURI = resourceURI.spec })
{
    Zotero.debug('ZotGit Bootstrap: startup begin id=' + id + ' version=' + version + ' rootURI=' + rootURI);

    // Only ones we need to load directly here
    Services.scriptloader.loadSubScript(rootURI + 'init/00-script-definitions.js');
    Services.scriptloader.loadSubScript(rootURI + 'init/01-script-loader.js');

    let scriptPaths = new ScriptDefinitions().getScriptPaths();
    let scriptLoader = new ScriptLoader(rootURI);

    await scriptLoader.loadScripts(scriptPaths);

    const currentTag = Zotero.Prefs.get('extensions.zotmoov.tag_str', true);
    if ((currentTag || '').trim().toLowerCase() == 'zotmoov')
    {
        Zotero.Prefs.set('extensions.zotmoov.tag_str', 'zotgit', true);
    }

    const directoryManager = new DirectoryManager();
    const outputManager = new OutputManager(directoryManager);
    const zotmoovDebugger = new ZotMoovDebugger('ZotMoov', outputManager);

    const sanitizer = new Sanitizer();
    const zotmoovWildcard = new ZotMoovWildcard(sanitizer, ZotMoovCWParser);

    zotmoov = new ZotMoov(id, version, rootURI, zotmoovWildcard, sanitizer, zotmoovDebugger);
    zotmoovBindings = new ZotMoovBindings(zotmoov);
    zotmoovMenus = new ZotMoovMenus(zotmoov, zotmoovBindings, ZotMoovCMUParser);
    zotmoovSync = new ZotMoovGitHubSync(zotmoov, zotmoovMenus, zotmoovDebugger);

    try
    {
        Zotero.debug('ZotGit Startup: cleaning leftover cache from previous session');
        await zotmoovSync.cleanupRemoteCacheOnShutdown();
        Zotero.debug('ZotGit Startup: leftover cache cleanup complete');
    }
    catch (e)
    {
        Zotero.logError(e);
        Zotero.debug('ZotGit Startup: leftover cache cleanup failed: ' + e.message);
    }

    Zotero.PreferencePanes.register(
        {
            id: 'zotmoov_basic',
            pluginID: 'zotgit@khodami.com',
            src: rootURI + 'preferences/prefs.xhtml',
            scripts: [rootURI + 'preferences/zotmoov-prefs.js'],
            helpURL: rootURI + 'docs/SETTINGS_INFO.md'
    });
    Zotero.debug('ZotGit Bootstrap: registered preference pane zotmoov_basic');

    Zotero.PreferencePanes.register(
        {
            id: 'zotmoov_advanced',
            pluginID: 'zotgit@khodami.com',
            parent: 'zotmoov_basic',
            src: rootURI + 'preferences/adv_prefs.xhtml',
            scripts: [rootURI + 'preferences/zotmoov-adv-prefs.js'],
            helpURL: rootURI + 'docs/SETTINGS_INFO.md'
    });
    Zotero.debug('ZotGit Bootstrap: registered preference pane zotmoov_advanced');

    Zotero.PreferencePanes.register(
        {
            id: 'zotmoov_keyboard',
            pluginID: 'zotgit@khodami.com',
            parent: 'zotmoov_basic',
            src: rootURI + 'preferences/keyboard_shortcuts.xhtml',
            scripts: [rootURI + 'preferences/zotmoov-keyboard-prefs.js']
    });
    Zotero.debug('ZotGit Bootstrap: registered preference pane zotmoov_keyboard');

    // Need to expose our addon to rest of Zotero
    Zotero.ZotMoov = zotmoov;
    Zotero.ZotMoov.Menus = zotmoovMenus;
    Zotero.ZotMoov.Sync = zotmoovSync;
    Zotero.ZotMoov.Menus.Custom = { 'Parser': ZotMoovCMUParser, 'Commands': ZotMoovCMUParser.Commands };
    Zotero.ZotMoov.Commands = { 'Parser': ZotMoovCWParser, 'Commands': ZotMoovCWParser.Commands };

    if (Zotero.Prefs.get('extensions.zotmoov.sync.github.enabled', true)
        && Zotero.Prefs.get('extensions.zotmoov.sync.github.auto_pull', true))
    {
        Zotero.debug('ZotGit Bootstrap: auto-pull on startup is enabled; pulling from GitHub');
        await zotmoovSync.pullFromGitHub({ refreshMenus: false });
    }

    zotmoovSync.configureAutoPushScheduler();

    zotmoovMenus.init();
    {
        let windows = Zotero.getMainWindows();
        for (let win of windows)
        {
            if (!win.ZoteroPane) continue;
            zotmoovBindings.patchWindow(win);
        }
    }
    zotmoovMenus.loadAll();

    let aomStartup = Cc['@mozilla.org/addons/addon-manager-startup;1'].getService(Ci.amIAddonManagerStartup);
    let manifestURI = Services.io.newURI(rootURI + 'manifest.json');
    chromeHandle = aomStartup.registerChrome(manifestURI, [
        ['content', 'zotmoov', 'chrome/content/']
    ]);

    Zotero.debug('ZotGit Bootstrap: startup complete');
}

function onMainWindowLoad({ window }) {
    Zotero.debug('ZotGit Bootstrap: onMainWindowLoad');
    if (zotmoovBindings && typeof zotmoovBindings.patchWindow == 'function')
    {
        zotmoovBindings.patchWindow(window);
    }
    zotmoovMenus.load(window);
}

function onMainWindowUnload({ window }) {
    Zotero.debug('ZotGit Bootstrap: onMainWindowUnload');
    zotmoovMenus.unload(window);

    if (!zotmoovSync || syncFinalized) return;

    try
    {
        const remainingWindows = Zotero.getMainWindows().filter(win => win && win !== window);
        if (remainingWindows.length > 0) return;

        if (!syncFinalizePromise)
        {
            Zotero.debug('ZotGit Shutdown: last main window unloading, running final sync + cache cleanup');

            try
            {
                if (zotmoovBindings)
                {
                    zotmoovBindings.destroy();
                    zotmoovBindings = null;
                }
            }
            catch (e)
            {
                Zotero.logError(e);
            }

            syncFinalizePromise = zotmoovSync.destroy({ pushOnShutdown: true, cleanupCacheOnShutdown: true })
                .catch((e) => {
                    Zotero.logError(e);
                })
                .finally(() => {
                    syncFinalized = true;
                });
        }
    }
    catch (e)
    {
        Zotero.logError(e);
    }
}

async function shutdown()
{
    log('ZotMoov: Shutting down');
    Zotero.debug('ZotGit Bootstrap: shutdown begin (syncFinalized=' + syncFinalized + ')');

    try
    {
        if (zotmoovSync)
        {
            if (syncFinalizePromise)
            {
                await syncFinalizePromise;
            }
            else if (!syncFinalized)
            {
                syncFinalizePromise = zotmoovSync.destroy({ pushOnShutdown: true, cleanupCacheOnShutdown: true })
                    .finally(() => {
                        syncFinalized = true;
                    });
                await syncFinalizePromise;
            }
        }
    }
    catch (e)
    {
        Zotero.logError(e);
    }

    try
    {
        if (zotmoovMenus) zotmoovMenus.destroy();
    }
    catch (e)
    {
        Zotero.logError(e);
    }

    // Final fallback in case async shutdown cleanup raced with app exit/locks.
    forceRemoveCacheDirsSync();

    try
    {
        if (zotmoovBindings) zotmoovBindings.destroy();
    }
    catch (e)
    {
        Zotero.logError(e);
    }

    try
    {
        if (chromeHandle) chromeHandle.destruct();
    }
    catch (e)
    {
        Zotero.logError(e);
    }
    chromeHandle = null;

    zotmoov = null;
    zotmoovMenus = null;
    zotmoovBindings = null;
    zotmoovSync = null;
    syncFinalized = false;
    syncFinalizePromise = null;
    Zotero.ZotMoov = null;

    Zotero.debug('ZotGit Bootstrap: shutdown complete');
}

function uninstall()
{
    log('ZotMoov: Uninstalled');
}