# Changelog

## v2.2.3

### Added
- Sync review (Pull / Sync Now) file rows open in the editor on click (local copy, or clone when the file is not on disk)
- Sync review tab summary chips filter the file list (update, delete, local-only, conflicts, kept deleted)
- On Windows, when a pull delete hits a locked path, Restart Manager registers every file under that path in batches of 500 (not the directory, and not junctions) and closes the processes that have them open, after checking the live process image. Cursor, VS Code, this extension host, and Windows session processes are left running. If only Cursor holds the folder, the dialog still offers retry or Reload Window

### Changed
- Remote-ahead notifications no longer offer Sync Now or Reset from the toast; use the sidebar review flow instead
- Sidebar view title keeps only the refresh control; overflow menu entries for reset, open clone, and Cursor folder were removed (still in the sidebar and Command Palette)
- Italian package strings for the view-title refresh tooltip (`package.nls.it.json`)
- Dev dependencies: `@types/node` 26.6.4, `@types/vscode` ^1.128.0, `@vscode/vsce` 4.0.0, `vitest` 5.0.3 (`@types/vscode` kept at the `engines.vscode` floor for vsce 4 packaging)

### Fixed
- On Windows, replacing a skill folder during pull clears its contents and writes the clone files back without removing the skill directory, so an open directory handle cannot leave the skill empty. A local-only skill whose empty directory cannot be removed is left in place and the pull continues
- Status preview file rows use the same colors as summary chips (modified, local-only, removed, incoming)
- Windows pull/skill folder deletes retry `EBUSY`/`EPERM` and can prompt for lock recovery instead of failing immediately
- VSIX remains installable on VS Code/Cursor `^1.128.0` (no raised engine minimum)
- Pull review “to delete” filter lists every `keysToDelete` path, not only the local-only subset
- Pull review “to update” lists the files the pull will write, and each file row shows the action (update, delete, keep, choose, or stays deleted)
- Sync history records every file the operation created, updated, or deleted, including files removed inside a replaced skill folder. Opening a history entry shows that action on each row
- Deleting a sync history entry updates the list as soon as the confirmation closes, instead of waiting for a full sidebar refresh
- A file that sits directly in `skills/` (such as `operations.json`) is synced as a file. Pull no longer scans it as a skill folder, which threw `ENOTDIR` and stopped after some skill folders had already been cleared. The skill-folder backup is recorded before that clear, so a later failure copies it back into the same directory
- Sync history shows localized failure labels (e.g. cancelled → Annullato) instead of raw English codes
- An empty skill folder is refilled from the clone before push or pull, so a vacant directory is not committed as a deletion of that skill. Removing the skill directory still records a real deletion. Skill-artifact merge no longer creates the destination folder when it copies no files

## v2.2.2

### Fixed
- Pull and Sync Now no longer restore skills, rules, or other synced files you deleted on this machine, and do not recreate an emptied sync folder when the clone has a new file inside it. The review tab lists them; the next push removes them from the repository. Reset to remote still mirrors the clone
- When origin is ahead, Sync Now commits local deletions in the clone and replays them onto origin before copying remote updates, then pushes. A pull that is cancelled rolls the clone back so those deletions are not left half-applied
- Sync lock can recover when stale (~10 minutes) so Push/Pull/scheduled sync are not blocked forever after an interrupted operation
- Sync Now force-clears a stuck in-memory latch and refreshes sidebar status when a concurrent sync is not actually running
- Reset Extension State cancels any in-flight sync, clears the latch, then wipes token and clone (no longer refuses while “sync in progress”)
- Sync Now does not steal the latch while Push/Pull abort scope is active
- An extension update is detected before the window reloads. Status, Sync Now, and push rebuild `extensions.json` from the installed extensions folder, which already has the new version while the running window still reports the previous one
- Extensions installed from the store stay an id and version and reinstall from the marketplace. Extensions installed from a local package (not on the store) are packed into `vsix/` and reinstalled from that file
- The sidebar shows a blurred overlay with a spinner and “Loading” until the first load finishes
- Clicking a sync history entry opens its file list in the file-list panel instead of the IDE quick pick
- Clicking a file in that panel opens it in the editor. If the local copy is missing, the clone copy opens instead
- Sidebar Push, Pull, and Reset stay in Actions. Open clone and Cursor folder are a separate Folders row

## v2.2.1

### Changed
- Sidebar title refresh button re-checks sync status (local vs clone and remote-ahead probe) instead of running Sync Now

### Fixed
- Windows push/pull copy no longer fails with `EPERM` on atomic rename when the destination file is briefly locked (retry + `copyFile` fallback)

## v2.2.0

### Added
- `cursorSync.excludeJsonKeys` omits top-level JSON keys from checksums, clone push, and pull merge (default `python.defaultInterpreterPath`) so machine-specific interpreter paths do not ping-pong `settings.json`

## v2.1.1

### Added
- Sync Now / Pull / Reset open an editor tab that lists incoming commits and files, local-only paths, and conflicts, with Proceed and Cancel instead of a single warning paragraph

### Changed
- Sync Now continues with a nested push after a successful pull when this machine still differs from the clone
- Closing or cancelling the review or conflict tab stops the in-flight sync the same way Stop Sync does (journal rollback)

### Fixed
- Sync Now, Push, Pull, and Reset stay disabled while the review or conflict tab is open, and re-enable when the tab is applied or closed

## v2.1.0

### Added
- Status-card warning phrases (**local changes**, remote updates, local-only files, diverged histories) are links: each opens a file-list editor panel with an immediate loading state, a Refresh button, and counts for changed, local-only, and missing-locally files so you can inspect before Sync Now, Pull, or Reset
- Sync tab **Not synced** state when local Cursor files (or an unpushed clone) are not in the repository

### Changed
- Remote-ahead, diverged, and local-drift warnings sit inside the existing status card and reuse the single Sync Now button (no extra banner or second button)
- Status bar no longer shows OK when the clone is ahead of origin or local files differ from the clone
- Extra clicks on the same status warning only reveal the open file-list panel

### Fixed
- Sidebar no longer claims **Synced** solely because a previous push/pull recorded sync state
- History delete icon is a filled trash SVG, spaced farther from the timestamp (`codicon-trash` has no glyph in the Cursor webview font)

## v2.0.1

### Added
- Persistent Sync-tab banner, status bar, and one toast per episode when origin is ahead or histories have diverged, with a 5-minute check independent of auto-sync
- Sync Now fast-forwards like git and keeps files that exist only on this machine; Pull and Reset to remote stay a full mirror, with a confirmation that names incoming commits and local-only files
- Sync Now opens an editor tab to choose Keep Local or Keep Remote for each conflicting file

### Fixed
- Push no longer passes `git push --ff-only` (that flag is only for merge/pull). Default `git push` already refuses non-fast-forward updates
- Push, pull, Sync Now, and the scheduler share one lock so they cannot run on the same clone at once
- Failed push/pull rolls back the file journal and resets the clone (previously only Stop Sync did)
- Turning `mcp.syncEnabled` off no longer deletes or pulls a remote `mcp.json`; chat collection in the clone is left in place when chat sync is off
- Chat sync fingerprint is stored only after a successful push, not after packaging
- Timed-out git processes are killed (including the Windows process tree)
- Creating a missing clone branch tracks `origin/<branch>` instead of resetting from the current HEAD
- Reset Extension State refuses while a sync is in progress so it cannot delete the clone mid-push
- After a successful `git push`, a later failure no longer `reset --hard` the clone behind origin
- Pull now stores the chat collection checksum in sync state so Sync Now / scheduler do not immediately push again
- Pull fails (and rolls back) if chat import throws; it no longer records success when decrypt/import fails
- Sync Now / scheduler report `not_configured` when `destination.repo` is missing instead of attempting a push
- `cursorSync.configured` requires both a PAT and `owner/name`
- Debug-with-Cursor prompt inspects clone/git modules, not the removed Gist backend
- Chat-only pull uses a dedicated confirm message; Sync Now history uses trigger `syncNow`
- Dead transcript Gist settings (`transcripts.enabled` / `maxFileSizeKB` / `importFallbackToCurrentWorkspace`) removed from contributes
- Reset Extension State also clears `chats.*` and `mcp.syncEnabled`
- Leftover conflict-panel CSS/JS and Gist destination badge styles removed from the sidebar webview

## v2.0.0

### Breaking
- Push/pull use a system-git clone under extension global storage (`sync-repo`), then copy into Cursor folders. GitHub Gist destination, Git Data API writes, one-shot Gist export/import (settings, chats, transcripts), Mirror, and Keep Local/Remote conflicts are removed
- Destination is repository-only (`cursorSync.destination.repo` / `branch` / `path`). Leftover `destination.type = gist` shows a connect-repository warning; Gist content is not migrated
- Fast-forward only: no merge, no force-push. Diverged clone → Push refused until **Reset to remote** or a manual git fix. Origin ahead → Pull first
- Pull replace is confirmed with a modal (file update/delete counts and skill folders). Scheduled sync never shows that modal: it skips pull and records history `"pull required"`
- Chat encryption setting is `cursorSync.chats.encrypt` (still reads leftover `chatGist.encrypt`; default true). PAT requires **`repo`** scope (or fine-grained Contents access). Git must be on PATH

### Added
- **Reset to remote** and **Open clone** (OS file manager). Stop Sync can `git reset --hard` the clone to the SHA captured before copy
- Skill-folder replace on pull uses an empty Keep Local set (full folder wipe/replace from the clone)

## v1.0.1

### Changed
- Default sync destination is now a classic GitHub repository instead of a private Gist (`cursorSync.destination.type` default `repo`)

## v1.0.0

### Added
- Sync tab history: delete a single entry (trash icon per row) or clear all entries via the control to the right of the History title; both actions require modal confirmation
