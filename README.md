# ZotGit
A *simple* plugin for managing attachments in Zotero 7

ZotGit can:
- Automatically move/copy imported attachments into a custom directory
- Manually move/copy imported attachments to/from a custom directory via right-clicking
- Automatically delete linked attachments from your computer when you delete them in Zotero
- Easily attach the last modified file in a folder to a Zotero item

## Installation

[Download the latest release here](releases/latest)
- If using Firefox you have to right click the .xpi and save link as.

And set the ZotGit directory to the folder you want to move/copy files to.

<img src="docs/res/Image2.png" width="500"/>

It is highly recommended to
1. **[Make a local backup before mooving your library](https://www.zotero.org/support/zotero_data#backing_up_your_zotero_data)**
2. Give ZotGit its own folder that other applications will not alter
3. Uncheck "Sync attachment files in My Library" in the Sync settings if you do not plan to use Zotero's cloud file storage
4. If planning to sync across multiple devices, set the [Linked Attachment Base Directory](https://www.zotero.org/support/preferences/advanced#linked_attachment_base_directory) to the synced folder on each computer.

## Settings

[Click here for a complete description of the ZotGit settings](docs/SETTINGS_INFO.md)

## GitHub Settings Sync

ZotGit can sync settings and PDFs across devices through GitHub.

In `Settings -> ZotGit Settings -> GitHub Settings Sync`:

1. Authenticate
	- Paste `Personal Access Token`
	- Optional: click `Create Token`
	- Click `Check Auth`
2. Choose repository
	- Existing: `Load Repos` -> pick repo -> `Use Selected`
	- New: `Create Repo`
3. Configure sync
	- Enable `Enable GitHub Sync`
	- Set `Branch` and `File Path` (default `zotgit-settings.json`)
	- Use `Pull Now` / `Push Now`

`Automatically Pull on Startup` pulls settings on launch.
`Automatically Push Every 10 Minutes` pushes periodically; failed auto-push retries in 5 minutes.

With `Remote PDF Mode` enabled:
- GitHub is the persistent PDF source
- pull skips bulk PDF download
- PDFs are recalled on-demand when opening missing files
- ZotGit performs a final push on shutdown, then removes the temporary cache folder

For private repositories, the token must have repository content read/write permissions.
The token is never included in synced payloads.

## FAQ

### Move vs Copy

Most likely, you will want to ```move``` your items. ```move``` is for converting the internal Zotero stored attachments to linked attachments. Files that are moved can be freely converted between linked attachments and stored attachments. ```copy``` is primarily used for copying the attachment into a folder as a backup outside of Zotero. Once a file is copied it is **not** tracked by Zotero anymore and is not easily reimported.

### Migrating from ZotFile

ZotGit should not break any existing linked files from ZotFile. But to be sure, before updating to Zotero 7 [make a local backup of your library](https://www.zotero.org/support/zotero_data#backing_up_your_zotero_data) and of your ZotFile folder.

The ZotGit data directory can be the previous ZotFile directory if you don't mind new files being mixed with the old ones, or a brand new data directory if you like to keep things separate.

For any ZotFile tablet files, you can recover them using the official [ZotFile Recovery plugin](https://github.com/jlegewie/ZotFile-Recovery).

One problem that might arise is the [Linked Attachment Base Directory](https://www.zotero.org/support/preferences/advanced#linked_attachment_base_directory). If you were using this feature before (check in Settings > Advanced > Files and Folders > Linked Attachment Base Directory) you may need to change the base directory to a folder that contains both the ZotFile files and the ZotGit files.

The easiest way to accomplish this is to simply reuse the ZotFile folder or put the ZotGit folder inside the previous ZotFile one. For example, the ZotGit data folder will be `ZotFile/` or `ZotFile/ZotGit/` respectively.

### File Renaming

I recommend using the [automatic file renaming functionality included in Zotero 7](https://www.zotero.org/support/file_renaming). It has support for custom patterns.

### Moving Files in Group Libraries

[Zotero does not support linked files for group libraries](https://www.zotero.org/support/attaching_files#linked_files), so ZotGit can only move files in your personal library. Any linked files pointing to group libraries that are somehow created will be broken. The `copy` feature is unaffected by this limitation.

### Bugs/Feature Requests

Both can be filed [here](issues). Please keep feature requests tightly focused on the extension's core purpose of mooving attachments and linking them!