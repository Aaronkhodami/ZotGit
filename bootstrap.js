// ZotMoov
// bootstrap.js
// Author: Khodami Aaron

// Declare at top level
let zotmoov = null;
let zotmoovMenus = null;
let zotmoovBindings = null;
let zotmoovSync = null;
let chromeHandle = null;

function log(msg)
{
    Zotero.debug('ZotMoov: ' + msg);
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

    Zotero.PreferencePanes.register(
        {
            id: 'zotmoov_basic',
            pluginID: 'zotmoov@wileyy.com',
            src: rootURI + 'preferences/prefs.xhtml',
            scripts: [rootURI + 'preferences/zotmoov-prefs.js'],
            helpURL: rootURI + 'docs/SETTINGS_INFO.md'
    });

    Zotero.PreferencePanes.register(
        {
            id: 'zotmoov_advanced',
            pluginID: 'zotmoov@wileyy.com',
            parent: 'zotmoov_basic',
            src: rootURI + 'preferences/adv_prefs.xhtml',
            scripts: [rootURI + 'preferences/zotmoov-adv-prefs.js'],
            helpURL: rootURI + 'docs/SETTINGS_INFO.md'
    });

    Zotero.PreferencePanes.register(
        {
            id: 'zotmoov_keyboard',
            pluginID: 'zotmoov@wileyy.com',
            parent: 'zotmoov_basic',
            src: rootURI + 'preferences/keyboard_shortcuts.xhtml',
            scripts: [rootURI + 'preferences/zotmoov-keyboard-prefs.js']
    });

    // Need to expose our addon to rest of Zotero
    Zotero.ZotMoov = zotmoov;
    Zotero.ZotMoov.Menus = zotmoovMenus;
    Zotero.ZotMoov.Sync = zotmoovSync;
    Zotero.ZotMoov.Menus.Custom = { 'Parser': ZotMoovCMUParser, 'Commands': ZotMoovCMUParser.Commands };
    Zotero.ZotMoov.Commands = { 'Parser': ZotMoovCWParser, 'Commands': ZotMoovCWParser.Commands };

    if (Zotero.Prefs.get('extensions.zotmoov.sync.github.enabled', true)
        && Zotero.Prefs.get('extensions.zotmoov.sync.github.auto_pull', true))
    {
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
}

function onMainWindowLoad({ window }) {
    if (zotmoovBindings && typeof zotmoovBindings.patchWindow == 'function')
    {
        zotmoovBindings.patchWindow(window);
    }
    zotmoovMenus.load(window);
}

function onMainWindowUnload({ window }) {
    zotmoovMenus.unload(window);
}

async function shutdown()
{
    log('ZotMoov: Shutting down');

    try
    {
        if (zotmoovSync) await zotmoovSync.destroy({ pushOnShutdown: true, cleanupCacheOnShutdown: true });
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
    Zotero.ZotMoov = null;
}

function uninstall()
{
    log('ZotMoov: Uninstalled');
}