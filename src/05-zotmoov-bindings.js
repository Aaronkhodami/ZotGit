var ZotMoovBindings = class {
    constructor(zotmoov)
    {
        this._zotmoov = zotmoov;
        this._callback = new ZotMoovNotifyCallback(zotmoov);
        this._del_queue = new ZotMoovDeleteQueue(zotmoov);

        this._patcher = new ZotMoovPatcher();

        this._notifierID = Zotero.Notifier.registerObserver(this._callback, ['item'], 'zotmoov', 100);
        
        this._orig_funcs = [];
        this._del_ignore = [];
        this._windowPatched = new WeakSet();
        this._recallScopeDepth = 0;
        this._allowedRecallItemIDs = new Set();

        this.lock = this._callback.lock.bind(this._callback);

        let self = this;
        this._patcher.monkey_patch(Zotero.Attachments, 'convertLinkedFileToStoredFile', function (orig) {
            return async function(...args)
            {
                let ret = null;
                await self._callback.lock(async () =>
                {
                    ret = await orig.apply(this, args);
                    self.ignoreAdd([ret.key]);
                });

                return ret;
            };
        });

        this._patcher.monkey_patch(Zotero.Item.prototype, '_eraseData', function (orig) {
            return async function(...args) {
                let val = await orig.apply(this, args);

                // If file in the ignore list skip the deletion
                if (self._del_ignore.includes(this.key)) return val;

                if (Zotero.Prefs.get('extensions.zotmoov.delete_files', true))
                {
                    self._del_queue.add([this]);
                }

                return val;
            };
        });

        // We do not want to delete the linked files upon sync
        // So we have to do this complicated stuff to preprocess the deleted files
        this._patcher.monkey_patch(Zotero.Sync.APIClient.prototype, 'getDeleted', function (orig) {
            return async function(libraryType, ...other) {
                let results = await orig.apply(this, [libraryType, ...other]);

                // Sometimes when syncing _eraseData can be called twice
                // Once when the parent item is deleted, and another time when the child attachment is deleted
                self._del_ignore = [];

                // Linked files only exist in user library
                if (libraryType != 'user') return results;
                if (!Zotero.Prefs.get('extensions.zotmoov.delete_files', true)) return results;
                if (Zotero.Prefs.get('extensions.zotmoov.process_synced_files', true)) return results;

                for (let key of results.deleted['items'])
                {
                    let obj = Zotero.Items.getByLibraryAndKey(Zotero.Libraries.userLibraryID, key);
                    if (!obj || !obj.isFileAttachment() || obj.attachmentLinkMode != Zotero.Attachments.LINK_MODE_LINKED_FILE) continue;

                    // Add to ignore list
                    self._del_ignore.push(key);
                }


                return results;
            };
        });

        // Don't process new files that are added
        this._patcher.monkey_patch(Zotero.Sync.Data.Local, '_saveObjectFromJSON', function (orig) {
            return async function(...args) {
                let results = await orig.apply(this, [...args]);

                // ...unless the user wants it
                if (Zotero.Prefs.get('extensions.zotmoov.process_synced_files', true)) return results;

                if(results.processed) self._callback.addKeysToIgnore([results.key]);

                return results;
            };
        });

        if (Zotero.Item && Zotero.Item.prototype && Zotero.Item.prototype.getFilePathAsync)
        {
            this._patcher.monkey_patch(Zotero.Item.prototype, 'getFilePathAsync', function(orig) {
                return async function(...args) {
                    let path = await orig.apply(this, args);
                    try
                    {
                        if (path && await IOUtils.exists(path)) return path;

                        if (!this.isFileAttachment || !this.isFileAttachment()) return path;

                        if (self._recallScopeDepth <= 0) return path;
                        if (!self._allowedRecallItemIDs.has(this.id)) return path;

                        const sync = Zotero.ZotMoov && Zotero.ZotMoov.Sync ? Zotero.ZotMoov.Sync : null;
                        if (!sync || typeof sync.ensureAttachmentLocal != 'function') return path;
                        if (typeof sync.isRemotePDFModeEnabled == 'function' && !sync.isRemotePDFModeEnabled()) return path;

                        let restoredPath = null;
                        try
                        {
                            restoredPath = await sync.ensureAttachmentLocal(this);
                        }
                        catch (e)
                        {
                            Zotero.logError(e);
                            return path;
                        }

                        if (!restoredPath) return path;

                        // ensureAttachmentLocal returns the path it wrote to — use it directly
                        if (await IOUtils.exists(restoredPath)) return restoredPath;

                        // Fallback: try the stored attachment path
                        const attachmentPath = (this.attachmentPath || '').trim().replace(/\//g, '\\');
                        if (attachmentPath && await IOUtils.exists(attachmentPath)) return attachmentPath;

                        return path;
                    }
                    catch (e)
                    {
                        Zotero.logError(e);
                        return path;
                    }
                }
            });
        }
    }

    async _withRecallScope(allowedItems, func)
    {
        this._recallScopeDepth += 1;
        let previousAllowed = this._allowedRecallItemIDs;
        this._allowedRecallItemIDs = new Set(previousAllowed);

        for (let item of allowedItems)
        {
            if (item && item.id) this._allowedRecallItemIDs.add(item.id);
        }

        try
        {
            return await func();
        }
        finally
        {
            this._allowedRecallItemIDs = previousAllowed;
            this._recallScopeDepth = Math.max(0, this._recallScopeDepth - 1);
        }
    }

    async _resolveAttachmentItems(input, collector)
    {
        if (!input) return;

        if (Array.isArray(input))
        {
            for (let item of input)
            {
                await this._resolveAttachmentItems(item, collector);
            }
            return;
        }

        if (typeof input == 'number' || typeof input == 'string')
        {
            const obj = await Zotero.Items.getAsync(input);
            await this._resolveAttachmentItems(obj, collector);
            return;
        }

        if (input.isFileAttachment && input.isFileAttachment())
        {
            collector.push(input);
            return;
        }

        // Do not expand parent items into all attachments here.
        // Strict recall must only prefetch explicitly requested attachment items.
    }

    async _prefetchAttachmentsForOpen(args, openContext = null)
    {
        const sync = Zotero.ZotMoov && Zotero.ZotMoov.Sync ? Zotero.ZotMoov.Sync : null;
        if (!sync || typeof sync.ensureAttachmentLocal != 'function') return;
        if (typeof sync.isRemotePDFModeEnabled == 'function' && !sync.isRemotePDFModeEnabled()) return;

        const items = [];
        for (let arg of args)
        {
            await this._resolveAttachmentItems(arg, items);
        }

        if (!items.length)
        {
            try
            {
                const pane = (openContext && typeof openContext.getSelectedItems == 'function')
                    ? openContext
                    : (Zotero.getActiveZoteroPane ? Zotero.getActiveZoteroPane() : null);

                if (pane && typeof pane.getSelectedItems == 'function')
                {
                    const selectedItems = pane.getSelectedItems();
                    await this._resolveAttachmentItems(selectedItems, items);
                }
            }
            catch (e)
            {
                Zotero.logError(e);
            }
        }

        if (!items.length) return;

        const seen = new Set();
        const uniqueItems = [];
        for (let item of items)
        {
            if (!item || !item.id) continue;
            if (seen.has(item.id)) continue;
            seen.add(item.id);
            uniqueItems.push(item);
        }

        for (let item of uniqueItems)
        {
            try
            {
                await sync.ensureAttachmentLocal(item);
            }
            catch (e)
            {
                Zotero.logError(e);
            }
        }

        return uniqueItems;
    }

    patchWindow(window)
    {
        if (!window || this._windowPatched.has(window)) return;

        const candidates = [
            window.ZoteroPane_Local,
            window.ZoteroPane
        ];

        for (let target of candidates)
        {
            if (!target) continue;

            for (let method of ['viewAttachment', 'openAttachment', 'viewSelectedAttachment', 'openSelectedAttachment'])
            {
                if (typeof target[method] != 'function') continue;

                this._patcher.monkey_patch(target, method, (orig) => {
                    let self = this;
                    return async function(...args)
                    {
                        const allowedItems = await self._prefetchAttachmentsForOpen(args, this) || [];
                        return await self._withRecallScope(allowedItems, async () => {
                            return await orig.apply(this, args);
                        });
                    };
                });
            }
        }

        this._windowPatched.add(window);
    }

    ignoreAdd(keys)
    {
        this._callback.addKeysToIgnore(keys);
    }

    destroy()
    {
        Zotero.Notifier.unregisterObserver(this._notifierID);
        this._callback.destroy();
        this._del_queue.destroy();
        this._patcher.disable();
    }
}
