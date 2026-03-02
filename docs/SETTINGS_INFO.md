# ZotGit Settings Guide

This page is the help target opened from ZotGit settings.
It documents the current ZotGit behavior, including GitHub sync, remote PDF mode, repository setup, and shutdown push.

## Main Settings

### Directory to Move/Copy Files To

The local base directory for linked files in normal mode.

- **Normal mode**: ZotGit moves/copies files here.
- **Remote PDF Mode enabled**: this directory is ignored, because ZotGit uses a temporary cache directory.

### File Behavior

- **Move** (recommended): converts to linked files and keeps Zotero tracking predictable.
- **Copy**: creates external backup copies and does not keep those copied files tracked by Zotero.

### Automatically Move/Copy Files When Added

If enabled, ZotGit processes supported attachments when they are added to Zotero.

### Automatically Move/Copy Files to Subdirectory

If enabled, ZotGit applies the subdirectory pattern when files are processed automatically or via menu actions.

- Default pattern is `{%c}` (by collection).
- Pattern reference: [Wildcard Formatting](WILDCARD_INFO.md)

### Automatically Delete External Linked Files in the ZotGit Directory

If enabled, deleting a linked attachment in Zotero also deletes the linked file from disk (within ZotGit-managed paths), and prunes empty folders.

### Allowed File Extensions

The extensions table controls which file types are processed.

- Non-empty table: only listed extensions are processed.
- Empty table: all file extensions are allowed.

## Advanced Settings

### Search Folder for Attaching New Files

Enables the “Attach New File” menu action that links the latest modified matching file in the configured folder.

Optional: enable confirmation before attach.

### Custom Rules

- [Custom Wildcards](CUSTOM_WILDCARD_INFO.md)
- [Custom Menu Items](CUSTOM_MENUITEM_INFO.md)

### Strip Diacritics From File Names/Paths

When enabled, ZotGit removes diacritics in managed file names/paths for better cross-platform compatibility.

## GitHub Sync (Current Workflow)

GitHub sync is configured in the main ZotGit settings page.

### 1) Authenticate

1. Paste a GitHub Personal Access Token in **Personal Access Token**.
2. Click **Create Token** to open GitHub token setup.
3. Click **Check Auth** to verify token validity.

Recommended token capability: repository read/write access for the target repo.

### 2) Choose or Create Repository

You can do either flow directly in ZotGit:

- **Existing repo**
	1. Click **Load Repos**
	2. Select from the repo picker
	3. Click **Use Selected**

- **New repo**
	1. Click **Create Repo**
	2. Enter repository name
	3. Choose private/public when prompted

ZotGit stores the selected repo as `owner/repo` and uses its default branch unless you override it.

### 3) Sync Controls

- **Enable GitHub Sync**: enables sync operations.
- **Automatically Pull on Startup**: pulls settings on launch.
- **Automatically Push Every 10 Minutes**: scheduled push interval.
- **Pull Now**: pulls settings immediately.
- **Push Now**: pushes settings and PDFs immediately.

If auto-push is enabled and a push fails, ZotGit retries in 5 minutes.

### 4) Remote PDF Mode

Remote PDF Mode is GitHub-first storage with local temporary cache.

- Pull does **not** bulk-download all PDFs in this mode.
- PDFs are downloaded **on demand** when opening missing files.
- Missing-file open paths are intercepted and recalled automatically.
- On shutdown, ZotGit does a **push-first** pass, then deletes the temporary cache directory.

### Sync Coverage

- Settings sync includes ZotGit preference data.
- Transport/auth metadata is excluded from payload sync.
- Token is never included in pushed settings payload.

## Sync Status Meaning

The sync status line in settings indicates the latest action state:

- **idle**: no active operation
- **pulling/pushing**: operation in progress
- **success**: last operation finished successfully
- **failed**: last operation failed (hover for message details)

## Hidden Preferences

[Hidden preferences documentation](https://www.zotero.org/support/preferences/hidden_preferences)

Advanced compatibility keys still exist for users upgrading from earlier versions.
If you need these low-level options, open a support issue and include your exact use case so the correct key names can be provided safely.
