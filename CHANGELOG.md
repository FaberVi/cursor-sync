# Changelog

## Unreleased

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

## v0.12.2

### Fixed
- Sync-tab conflict panel: Keep Local/Remote highlights and keeps rows visible; push/pull/Sync Now wait for sidebar decisions; banner and toast prompt Sync Now after all keep* choices
- Sync Now progress no longer alternates between Pulling… and Fetching n/m when a nested pull runs
- Repo push builds Git trees in chunks (100 entries) chained with `base_tree` so large backups avoid GitHub POST /git/trees timeouts

## v0.12.1

### Changed
- Raise `engines.vscode` to `^1.128.0` (Cursor 3.18+ / VS Code 1.128 base) and `@types/vscode` to `^1.125.0` (latest npm typings at or below that base; vsce-compatible)

## v0.12.0

### Added
- Default sync globs for Cursor CLI/user extras: `cli-config.json`, `hooks.json`, and `tasks.json` (scanned under both Cursor User and `~/.cursor`)
- Opt-in `cursorSync.mcp.syncEnabled` (default off) to sync `mcp.json`. Enabling uploads MCP server URLs, tokens, and headers — use only a **private** Gist or repository. Turning the toggle off does not delete a remote `mcp.json` already uploaded. If you previously listed `mcp.json` in `enabledPaths`, you must also enable this toggle
- **Stop Sync** (sidebar progress Stop, Command Palette `Cursor Sync: Stop Sync`, status bar while syncing). Cancels in-flight GitHub requests and restores local files written or deleted in that run (not remote commits/Gists, not chat/composer databases)
- Per-project chat identity: synced chats carry `sourceFolderTilde` (`~/path/to/repo`) plus conversation id so the same id in two workspaces is not merged. Pull restores into that folder's `~/.cursor/chats/<md5>/` when it exists (QuickPick otherwise). `composer.createNew` / openComposer run only for chats that belong to the currently open window
- Incremental **Pull** (sidebar + palette) vs explicit **Mirror from Remote**. Pull no longer deletes local-only synced files
- Sync-tab conflict panel (Keep Local / Keep Remote / Skip) with a single multi QuickPick fallback when the sidebar is hidden
- Manual chat save/export/Gist uses native `cursor-chat.json` (legacy `chat-bundle.json` / `chat-bundles.json` still import)

### Changed
- Community fork branding: extension display name **Cursor Sync (Community)**, publisher **FaberVi**, maintainer **Vincenzo Fabiano**. Upstream [Marcelo-Barella/cursor-sync](https://github.com/Marcelo-Barella/cursor-sync) remains credited; existing Gist descriptions from upstream are still discovered
- Dev dependencies: `@types/node` ^26.4.1, `@types/vscode` ^1.74.0, `esbuild` ^0.28.2, `typescript` ^7.0.2, `vitest` ^4.1.11; runtime `minimatch` ^10.2.6. `engines.vscode` remains `^1.74.0` (Cursor-compatible minimum; `@types/vscode` aligned for vsce packaging)
- `cursorSync.chats.syncEnabled` now defaults to **false**. Existing user settings keep their stored value; new installs and users who never set the key no longer sync chats until they turn it on
- If you customized `cursorSync.enabledPaths` before this release, add `cli-config.json`, `hooks.json`, and `tasks.json` manually — VS Code does not merge new defaults
- Chat collection packing is newest-first (store/transcript mtime). Skips over `chats.maxCollectionSizeKB` (default 8192) are named with title, project path, and short id in the Sync history and Output log. Chat sync fingerprint includes store.db size and mtime so a new message can trigger a re-pack
- Successful Pull/Push/Sync Now outcomes go to the Sync tab (history + status); IDE toasts are reserved for errors and required actions
- `syncExtensions.autoInstall` defaults **on** (prompt Install/Skip on pull; never silent). Off means no prompt and no install. `autoUninstall` stays off: on means uninstall extras without a second prompt
- Chat import uses `chatImport.activateDefault` without an extra activation picker; pull no longer asks “Activate in Composer now?”
- Removed Command Palette contribution `cursorSync.installSkillTransportChat`

### Fixed
- Union of remote+local chat collections re-applies the size cap after merge
- A remote chat with folder tilde A is not treated as already local when this machine only has the same id with no tilde or a different tilde
- Windows chat folder keys hash Cursor’s `workspace.json` path (case-insensitive folder match)
- Sidebar Open/Reactivate resolves the workspace from `projectKey` / `workspaceKey` instead of always using the first open folder

## v0.11.3

### Changed
- Repo destination stores backup files as real directories under `destination.path` (for example `cursor-sync/cursor-user/settings.json`) instead of Gist-style `--` flattened names. The next repo push migrates leftover dashed files in one GitHub rename commit. Gist layout is unchanged.
- Refactored chat, pull/push, transcript, and sidebar code into smaller modules for maintainability and test coverage
- Split the sidebar webview into shell, chats, settings, handlers, and progress assets with refreshed styling
- Split bundled `cursor_chat_io` Python into per-domain modules (import, verify, disk KV, workspace, activation, and related helpers)
- Sidebar UI strings available in English and Italian (`cursorSync.ui.language`)

### Fixed
- Sidebar pull/push progress no longer rebuilds the bar on every elapsed-timer tick (the fill reset and slid forward once a second)
- Pull reports real `Fetching n/total` and `Writing n/total` progress with an absolute percent, matching repo push uploads
- Chat transport and composer-bridge Python on Windows uses `py -3` (not the Microsoft Store `python3` stub); workspace `chatImport.pythonPath` is ignored — only the user-global setting applies
- Windows `~/.cursor/projects/<key>` folder names encode drive letters without a colon so chat import can create transcript directories reliably
- Project picker labels show tilde paths (for example `~/dev/app`) when workspace storage mapping resolves the folder
- First push to a completely empty GitHub repository (HTTP 409 Git Repository is empty) creates the initial commit and branch instead of failing
- Sync history and the conflict failure toast wait until the user closes the conflict QuickPick; a full Keep Local/Remote resolution no longer writes an Unresolved conflicts failure row

## v0.11.2

### Fixed
- Repo push no longer syncs `node_modules` or `.git` path segments (and skips walking those directories). A stuck-looking sidebar at ~40% while “Uploading N changed file(s)…” was uploading thousands of skill `node_modules` blobs one-by-one with a fake progress bar.
- Repo Git Data blob uploads use concurrency 5 with per-blob retry. A late blob failure no longer restarts the entire write. Sidebar progress shows `Uploading n/total` with an absolute percent during the upload phase.

## v0.11.1

### Fixed
- Pull downloads only files whose remote checksum changed (plus `extensions.json` when present) instead of re-fetching the entire Gist/repo snapshot. Unchanged chat backups are skipped. A single pull reuses one Gist `GET /gists/{id}` for the two-phase fetch.
- Sidebar sync progress shows a live elapsed timer (`12s`, `1m 08s`) on pull and push.
- Missing-extension **Install / Skip** prompt on pull/sync is shown again (awaited warning, not a toast covered by “Pull complete”). After upgrading, run **Pull Now** once so later Sync Now / no-op pulls can re-prompt from the cached remote list.
- Pull no longer appears stuck on **Saving sync state…** while waiting for extension prompts: sync state is saved first, the sidebar shows **Checking extensions…**, and Install/Skip (and Remove extras) use a modal dialog.
- Sidebar status badge reads the installed extension version from `package.json` on disk (stays in sync after upgrade).
- Sidebar opens instantly with a shell UI instead of staying blank while chat discovery and remote gist/repo fetches complete.
- Clicking a file in sync history opens it in the editor (when it still exists on disk).
- Settings tab stacks label above field when the sidebar is narrower than ~380px, so destination/interval controls are no longer cramped or truncated.

### Changed
- Expanded Italian UI strings across the sidebar webview: chat actions, relative times, bundle/import lists, backup tier labels, pull policy options, and toast messages.

## v0.11.0

### Added
- Sync user-level subagents (`~/.cursor/agents/*.md`) on push/pull. If you customized `cursorSync.enabledPaths` before this change, add `agents/*.md` manually — VS Code does not merge new defaults into existing settings.
- `.gitattributes` with `* text=auto eol=lf` to avoid CRLF-only noise on Windows.

### Fixed
- `extensions.json` no longer lists Cursor/VS Code built-in extensions (via `packageJSON.isBuiltin` / `isUserBuiltin`, path under `resources/app/extensions`, and known product id patterns such as `anysphere.cursor-*`). Writes are skipped when regenerated content is unchanged. Pull skips product/builtin ids still present on older remotes instead of attempting marketplace install.
- Sidebar `settings:set` only accepts keys rendered in the Settings tab, with type validation. `chatImport.pythonPath` is read-only in the sidebar (set via Cursor Settings only) to block webview-driven RCE via a crafted Python path.
- Chat webview messages validate `conversationId` (UUID) and workspace/project path segments at the message boundary before open/reveal/reactivate.
- Chat transcript reveal/open rejects unsafe ids and keeps resolved paths under `agent-transcripts` / chats roots.
- GitHub `Retry-After` sleeps are clamped to 120 seconds (gist + repo API clients).
- Sidebar webview Content-Security-Policy meta tag; unknown sidebar commands are ignored.
- Break circular import `chat-partial-state` → `transcripts` (import `querySqliteRows` from `transcripts-sqlite` directly).
- **Critical:** `runSqliteScript` no longer uses `sqlite3 … .read` (CLI meta-commands like `.shell` could RCE). Scripts run only via Python `executescript`, and lines starting with `.` are rejected.
- Extension auto-install on pull defaults to **off**; marketplace id shape is validated; optional `syncExtensions.allowedPublishers` allowlist; even when auto-install is on, the user must confirm before install.
- Native chat collection `createdAt` is derived from chat payloads (not `Date.now()`), so sync checksums stay stable across repeated packaging.
- Sync manifest `conversation_id` must be a UUID (blocks path traversal into `~/.cursor/chats`); SyncEngine also refuses store paths that escape the chats root. Gist transcript import skips unsafe conversation/project path segments.

### Changed
- `dot-cursor` sync globs are routed generically: any `enabledPaths` entry that is not a Cursor User config glob (`settings.json`, `keybindings.json`, `extensions.json`, `snippets/**`, `vsix/**`) is scanned under `~/.cursor`. Custom paths such as `mcp.json` now work without code changes — do not add `mcp.json` unless you accept syncing MCP server secrets to the remote.
- Removed stale `skills-cursor/**/SKILL.md` from code/README/mock fallbacks (already absent from `package.json` defaults since v0.1.6; Cursor-managed built-in skills stay local).

### Docs
- Import scoped security audit reports from upstream `cursor/vulnerability-findings-management-ae89` (Marcelo-Barella/cursor-sync PR #33) under `docs/security/`. Audited baseline commit `7713dc7`.

## v0.10.4

### Changed
- **Pull Now** fully mirrors the remote for synced paths (`settings`, skills, rules, commands, …): after conflict resolution it shows a confirmation with counts of files to update/delete, then overwrites remote files and removes local-only synced files (Keep Local preserved). `safeMode` multi-select does not apply to mirror Pull.
- **Sync Now / scheduler** soft-pull still merges remote updates, and now also deletes local files that were **removed on the remote** (based on the last known remote checksums). Brand-new local-only files are kept and pushed. Keep Local always wins over a remote delete.
- Pull/Sync delete paths are backed up before removal; empty parent directories under the sync roots are pruned.

## v0.10.3

### Fixed
- Stop syncing skill-creator / skill-forge workspace artifacts (`skill-snapshot/`, `skill-*-backup/`, `iteration-*` / `eval-*` under `*-workspace/`). Cursor names skills after the parent folder of `SKILL.md`, so restoring those snapshots registered bogus skills named `skill-snapshot`. Pull and import also skip these keys if they are still present on the remote. Legitimate skills whose folder name ends with `-workspace` remain synced.
- **Automatic migration (safe recovery)**: on activate (and after push/pull/import), merge-missing from artifact sources into the live skill (never overwrite, never delete a rich snapshot because a minimal `SKILL.md` already exists), preserve active skill-forge workspaces (`iteration-*` / root files), always strip `skill-snapshot` / `skill-*-backup` from those workspaces so Cursor no longer lists bogus `skill-snapshot` skills, relocate top-level `skills/skill-snapshot/` under `skills/_orphaned-snapshots/recovered-<ts>/`, and publish recovered skill files in the **same** remote write that deletes artifact keys (never a full settings push, never purge-before-publish).

## v0.10.2

### Fixed
- Sync conflict resolutions (Keep Local / Keep Remote) now persist across reloads and are respected by Sync Now, so the conflict dialog no longer loops after a choice.
- Push honors Keep Remote (preserves remote file, applies it locally, and skips uploading the local version).
- Sync History records pull with zero file changes, unresolved-conflict blocks, and push auth failures.
- After resolving all conflicts, sync continues automatically without a second manual click.

## v0.10.1

### Added
- Sync sidebar shows live Push/Pull progress under History (below the pager) instead of the IDE notification processing indicator.
- Sync Now / Push / Pull buttons stay disabled while a sync operation is running (including nested Sync Now → Pull → Push).
- Sync History shows `changed / total files` (e.g. `2 / 579 files`) for new push/pull entries.

### Changed
- **Incremental Push**: uploads only new/changed files (plus an updated `manifest.json` and remote deletes). Unchanged files are skipped; if nothing changed, Push reports already in sync without calling the remote write API.
- Push fetches only `manifest.json` for the remote baseline (full chat/settings bodies are downloaded only when needed).
- Push skips rebuilding the chat collection when the local chat fingerprint and remote chat checksum are unchanged — no-op pushes are much faster.
- Scheduler treats chat as unchanged when the stored fingerprint still matches, avoiding unnecessary auto-pushes.
- Scheduled auto-sync/push still runs **only** when `cursorSync.schedule.enabled` is on; each tick re-checks the flag and stops the timer if it was turned off.
- Sync History shows at most 5 entries per page with Prev/Next pagination.
- Sidebar Settings: language selector (English / Italiano) via `cursorSync.ui.language`.
- Removed redundant **Configure GitHub** button under Sync History (connect remains under Destination in Settings).

## v0.10.0

### Added
- **Dual remote destination**: sync Push/Pull/Sync Now/scheduler to a private **GitHub Gist** (default) or a classic **GitHub repository** (`cursorSync.destination.type`). Repo mode uses the Git Data API for atomic multi-file commits under `destination.path` (default `cursor-sync/`), avoiding the Gist ~300-file limit. Requires a PAT with `repo` scope (or fine-grained access to that repository).
- **Sidebar Settings**: Auto-sync enable toggle, interval + unit (seconds/minutes, minimum 30s), and destination controls (type, `owner/name`, branch, path).
- Settings: `cursorSync.schedule.interval`, `cursorSync.schedule.intervalUnit`, `cursorSync.destination.type|repo|branch|path`.

### Changed
- Scheduler reads the new interval settings; deprecated `schedule.intervalMin` still migrates when the new interval is unset.
- Sync status / sidebar show the active remote label (Gist id or `owner/repo@branch`).

### Deprecated
- `cursorSync.schedule.intervalMin` — use `schedule.interval` + `schedule.intervalUnit`.

## v0.9.1

### Added
- **Sync History file list**: clicking a History entry in the Sync sidebar opens a QuickPick with the sync keys involved in that push/pull (stored as optional `files` on each history entry).

### Fixed
- Push/export skip empty and whitespace-only files so GitHub Gist no longer fails with HTTP 422 Validation Failed.
- Gist API errors now include field-level details; 422 on `files` notes empty/whitespace content as a common cause.
- Sync denylist excludes `__pycache__` path segments and `*.pyc` files.

## v0.9.0

### Added
- **Native chat JSON transport** (`src/native-chat-json/`): `cursor-chat.json` / `cursor-chat-collection` with `conversationState`, `blobs`, optional `storeDb`, `diskKv`, and transcripts; bundle ↔ native bridge and `restoreNativeChatsBatch` / `restoreNativeChatJson`.
- **Chat sync v0.9**: Push writes `cursor-chat.json` (`dot-cursor/cursor-chat.json`); pull accepts native format with fallback to legacy `chat-bundles.json`; encryption kind `cursor-chat-collection`.
- **Backup fidelity tiers** (`full` / `resume` / `partial` / `archive`) with sidebar badges, pre-push warnings, and optional `chats.syncOnlyFullBackups`.
- **`cursorSync.validateChatBackups`**: local backup checklist (tier, store.db path, diskKv probe) with Output report.
- **Pull chat updates**: `chats.pullUpdates` and `chats.pullUpdatePolicy` (skip / remoteWins / newerWins / ask).
- **Import settings**: `chatImport.useProtobufHydration`, `useIdeHydration`, `strictDiskGates`; protobuf hydration from bundle diskKv before IDE activation.
- **Layer 4 repair**: `repairDiskKvAfterActivation` after composer activation and sidebar writeback flush.
- **`syncImportedComposerSidebar`**, **`parseComposerDataKvJson`**, **`ensureNativeChatStoreDb`** (golden store alias).
- **Import verify Layer 4** checks (`layer4.composerData`, `bubbles`, `toolBubbles`); `activateStrict` fails on missing tool bubbles when bundle expects them.
- **`docs/transcript-fidelity-matrix.md`**; tests for native bridge, single-chat sync, diskKv repair, and strict Layer 4.

### Changed
- `enrichBundleWithLiveDiskKv`: retry on locked global `state.vscdb`, schema v2 promotion, warning when many diskKv rows have zero tool bubbles.
- Discovery counts **subagent** JSONL files under `agent-transcripts/<id>/subagents/`.
- Sidebar Chats: backup-eligible filter, tier badges on expand, Open warning for archive/partial tiers.
- Post-pull activation prompt when `activateDefault` is off (`chat-pull-activation.ts`).

### Fixed
- Sidebar chat pagination **Next** no longer intercepted by row action handler.
- **Files** reveal works for `~/.cursor/` paths (OS reveal + Windows `explorer.exe` fallback).
- `hasStore` enrichment from disk when chats exist under alternate workspace keys.

## v0.8.0

### Added
- **Inline chat activation** via `composer.createNew` with disk-hydrated `partialState` when the manifest is empty (`enrichManifestPartialStateFromDisk`, `partialStateForCreateNewCommand`).
- **`repairComposerDataAfterActivation`** re-persists hydrated `conversationMap`, headers, `conversationState`, encryption keys, and `status: completed` when the IDE clobbers `composerData` after activation.
- **`chat-import-disk-probe.ts`**: shared post-import and post-reload Composer sidebar disk probes (global and workspace `state.vscdb`).
- **Composer export titles** from `composer.composerHeaders` / `allComposers[].name` via `resolveComposerConversationTitle` (snapshot header name wins over transcript snippet).
- **`clearSessionBindingInTree`**: strips `requestId`, `workspaceUris`, and session-only fields from imported composer records and partial state.
- **`readRichComposerDataEntryFromStateDb`** and **`applyRichComposerEntryToPartialState`** for protobuf-backed conversation hydration before `createNew`.
- Tests: `chat-bundle-title.test.ts`; expanded activation, merge, partial-state, and gist-import coverage.

### Changed
- Import rebind stamps destination `workspaceIdentifier` and fresh timestamps on sidebar headers and `composerData` blobs (`rebindComposerRecord`).
- `headersPayloadForImport` preserves snapshot `name` when non-empty instead of overwriting with `bundle.title`.
- Activation partial state keeps destination `workspaceIdentifier`, header `name`, and timestamps after rich disk hydration.
- Post-import UX records last-import probe ids in `globalState` and probes disk state before optional reload; extension activate replays probe after pending sidebar writeback flush.
- Python disk import: `persist_disk_kv_rows_to_db` with integrity-check skip path; optional purge gate for `cursorDiskKV` rows.
- `chat-persistence-restore.ts` delegates sidebar disk probing to the shared probe module.

### Fixed
- Empty `partialState` passed to `composer.createNew` no longer wipes disk-restored chats.
- Imported Composer chats no longer retain source `requestId` or `workspaceUris` bindings.
- Gist import tests mock `extensionContext.globalState` for post-import history and probe paths.
- Chat-import-merge golden fixtures align with timestamp stamping on header and composer-data rebind.

## v0.7.6

### Added
- **Export into Bundle (GIST)** on the Composer editor tab (`cursorSync.exportCurrentChatBundleToGist`) for single-conversation private Gist upload.
- **Batch chat bundle import** from local `chat-bundles.json` and Gist collections (multi-select picker, continue-on-failure summary via `restoreChatBundlesBatch`).
- **Composer conversation titles** from `composer.composerHeaders` / `allComposers[].name` in export and import pickers (`composer-title.ts`).
- **Sidebar writeback queue** after disk import: immediate `state.vscdb` merge plus deferred flush on extension activate (`chat-import-sidebar-writeback.ts`).
- **`fetchGistFileContent`** downloads full gist payloads when the GitHub API marks files truncated.

### Changed
- Import rebind clears session bindings (`requestId`, `workspaceUris`) on sidebar ItemTable and Layer 4 composer rows (TypeScript + bundled Python).
- Chat bundle and Gist import outcomes use batch summaries for multi-chat imports; README notes window reload is optional when the UI is stale.
- Python transport: destination workspace rebind on `cursorDiskKV`, pin imported composer in `allComposers`, ItemTable `composerData` workspace stamp, SQLite busy timeouts; optional debug logging when `CURSOR_SYNC_DEBUG_LOG` is set.

### Fixed
- Gist collection import restores all selected conversations without aborting on the first failure.
- `restoreChatBundle` tolerates extension contexts without `globalState` (integration tests).

## v0.7.5

### Added
- **Chat gist encryption**: optional client-side encryption for `chat-bundle.json` and `chat-bundles.json` Gist uploads (`cursorSync.chatGist.encrypt`, default on) using Argon2id + AES-256-GCM (`hash-wasm`).
- **`cursorSync.setChatEncryptionPassword`**: stores the chat encryption password in VS Code `SecretStorage` for export/import.
- Encrypted gist envelope (`cursorSyncEncrypted` v1) with per-export KDF salt and bound KDF parameters in the ciphertext metadata.

### Changed
- Chat gist export encrypts bundle JSON before `createGist` when encryption is enabled; import decrypts encrypted payloads before disk restore.
- Import verifies the encryption password (trial decrypt) before persisting it to `SecretStorage`.

### Fixed
- Decryption uses envelope-stored Argon2id parameters instead of hardcoded defaults.
- Single password prompt on import when the gist is encrypted (no duplicate prompts).
- Import does not save a wrong password when verification fails.

## v0.7.4

### Added
- **Chat tab export**: `Cursor Sync: Export into Bundle` on chat editor tab title and context menus (`cursorSync.exportCurrentChatBundle`) exports the clicked tab's conversation without the multi-chat picker.
- **Layer 4 in extension export**: `buildChatBundle` writes ChatBundle schema v2 with `diskKvSnapshot` from global `state.vscdb` when `cursorDiskKV` rows exist; warns when tool bubbles are missing on disk.
- **`chat-disk-kv-export.ts`**: per-key `cursorDiskKV` reads (avoids malformed-image errors on bulk SELECT under Cursor lock); `enrichBundleWithLiveDiskKv` fills missing snapshots via bundled Python on export/import.
- **`runPythonExportDiskKvSnapshot`**: Python fallback when TS sqlite reads fail on large or locked global `state.vscdb`.

### Changed
- Import restore enriches bundles with live Layer 4 before disk import; verify/activation use the enriched bundle.
- Bundled Python `export_disk_kv_snapshot` and tool-bubble counting use per-key reads with `busy_timeout` on live global DBs.
- SQLite helpers prefer Python for global `state.vscdb` at or above 256 MiB; import verify passes retry options for header reads.

### Fixed
- **Editor tab export**: resolves workspace when `~/.cursor/chats` has no store row but `agent-transcripts/<id>` exists on disk.

## v0.7.3

### Added
- **Debug with Cursor** on sync failure toasts (push, pull, Sync Now, scheduled sync): opens Composer with a sanitized debug prompt, or copies the prompt to the clipboard when Composer prefill is unavailable.
- `sync-debug.ts`: builds failure context for debugging (tokens, gist IDs, and paths redacted in prompts).

### Changed
- `executeSyncNow` exported; conflict/error/exception paths show a single debug toast without duplicating push/pull failure notifications.
- Scheduled sync surfaces debug toasts for conflict/error/exception; skips routine outcomes (`none`, in-progress, mocked `false` from push/pull).

### Fixed
- Sync failure debug toasts are fire-and-forget so push/pull locks and Sync Now / scheduled sync are not blocked while a notification is open.
- Cached extension version read and sanitized `category` in debug prompts.

## v0.7.2

### Added
- **ChatBundle schema v2** (`diskKvSnapshot`): Python `cursor_chat_io.py export` captures native `cursorDiskKV` rows (`composerData`, `bubbleId`) so tool/MCP Composer cards can round-trip across machines.
- **Transport fidelity UX**: import outcomes and the Chats sidebar show schema version, tool-bubble counts, and a warning when Layer 4 falls back to text-only synthesis (schema v1 or v2 without `diskKvSnapshot`).

### Changed
- Python disk import prefers native `diskKvSnapshot` remap over `build_cursor_disk_kv_rows_from_bundle` when rows are present.
- Bundled transport-chat reference documents Layer 4 export/import and inspect output.

### Fixed
- Gist chat import tests mock `showWarningMessage` for text-only Layer 4 fidelity warnings.
- **Security**: `diskKvSnapshot` import validates and filters `cursorDiskKV` keys to `composerData:{conversationId}` and `bubbleId:{conversationId}:*` (TS + Python). `transportChatScriptDir` honors user-global settings only (workspace overrides cannot redirect Python).

## v0.7.1

### Fixed
- **Chats tab Open / Re-activate**: `activateExistingChat` now syncs disk layers (Python transport), merges sidebar state into `state.vscdb`, and picks the right bundle mode (export bundle, header-only, minimal stub, or existing rich composer data) before IDE activation.
- **Composer activation**: prefers `composer.openComposer` / `composer.focusComposer` with handle polling; sidebar Open can skip staging `pending.json` and accept open-without-handle when `store.db` is already on disk.
- **store.db meta**: `decodeStoreDbIndex` parses hex-encoded JSON meta values; `storeMetaRecord` helper for activation decisions.
- **Sidebar webview**: client script moved to bundled `resources/sidebar/webview.js`; sync tab refreshes via `postMessage` instead of resetting full HTML (preserves Chats/Settings tab state).
- **Open fallback**: when native chat UI activation fails, opens the agent transcript `.jsonl` when available and surfaces actionable reload/re-import hints.

### Changed
- VSIX packaging ships `resources/sidebar/webview.js` instead of `golden-chat-store.template.db` (template remains in repo for tests only).

## v0.7.0

### Added
- Sidebar webview is now tab-based: **Sync** (existing), **Chats** (new), and **Settings** (surfaces `cursorSync.chatImport.*` knobs).
- **Chats tab** with three sections: Recent in this workspace (driven by `listConversationsForWorkspace`), Imports & bundles (backed by a new `cursorSync.chatImports` history in `globalState`, capped at 200), and live progress for in-flight imports.
- `src/chat-progress-events.ts`: `EventEmitter`-based channel (`onChatImportProgress`) that the sidebar subscribes to for Phase A / Phase B telemetry.
- `src/chat-activate-existing.ts`: `activateExistingChat` helper that re-runs Phase B (`composer.createComposer`) without re-writing disk; powers the "Re-activate" sidebar action.
- `cursorSync.chatImport.pythonPath` and `cursorSync.chatImport.transportChatScriptDir` settings.
- `ensurePythonReady()` pre-flight that probes `python3 --version` (or the configured interpreter) once per session.

### Changed
- **Python transport-chat scripts are now bundled in the VSIX** under `resources/transport-chat/scripts/`. Script resolver (`resolveTransportChatScript`, `resolveComposerBridgeScript`) prefers `<extensionPath>/resources/transport-chat/scripts/` and accepts `cursorSync.chatImport.transportChatScriptDir` as an override.
- Disk import now **requires** the bundled Python scripts; the legacy TypeScript fallback in `restoreChatBundle` (`!diskHandledByPython` branches) is removed. Missing Python or missing scripts now throw a clear, actionable error instead of silently degrading sidebar merge.
- Sidebar refactored from a single `src/sidebar.ts` into `src/sidebar/{index,html,messages,sync-tab,chats-tab,settings-tab,import-history,bundle-discovery}.ts`. Public API (`initializeSidebar`, `refreshSidebar`) is unchanged.

### Removed
- `cursorSync.installSkillTransportChat` command and the Linux-only skill-install path. The Python scripts no longer need to be copied to `~/.cursor/skills/transport-chat/`.
- `cursorSync.transcriptBrowser` tree view ("Imported Transcripts"). The three commands (`refreshImportedTranscripts`, `openImportedTranscript`, `revealImportedTranscriptInExplorer`) remain registered for one release as deprecation stubs that point users at the new Chats tab.
- `~/.cursor/skills/transport-chat/scripts/*` lookup paths from the script resolvers.

### Deprecated
- `src/chat-import-merge.ts:mergeTargetsForImport` and `mergeSidebarIntoStateDb` (JSDoc `@deprecated`). They are no longer called by `restoreChatBundle`; retained briefly for tests.

## v0.6.0

### Added
- Chat export QuickPick: select workspace and multiple conversations from disk instead of typing IDs; human-readable workspace and conversation labels.
- Batch chat export/import via `chat-bundles.json` / `ChatBundlesCollection` wrapper (gist and local save/load).
- `Cursor Sync: Install Skill - Transport Chat` command (Linux only): copies bundled `resources/transport-chat` into `~/.cursor/skills/transport-chat/`.
- Golden store template v2 (`PRAGMA user_version = 2`): `blobs(id, data)` and content-addressed hydration from manifest or `ChatBundle` transcripts.

### Changed
- import-v2 disk restore (`store.db`, `state.vscdb`) runs through bundled transport-chat Python scripts when the skill is installed; extension retains IDE activation (`composer.createComposer`, pending.json watcher).
- Composer activation: `composer.getComposerHandleById` fallback, pending-manifest fingerprint matching, and optional `skipPythonBridge` for extension-only activation.

## v0.5.0

- feat: import-v2 `ChatBundle` restore with modular merge, partial state, workspace context, and disk/activation verification.
- feat: `composer.createComposer` activation via pending.json watcher and Python bridge fallback (`docs/chat-import-activate.md`).
- feat: export/import single-conversation chat bundles to private Gists (`chat-bundle.json`) using the same pipeline as local save/load.
- fix: run SQLite scripts through a temp file and `sqlite3 .read` so hydration and store updates work reliably on Linux (stdin piping to `sqlite3` was timing out).

## v0.4.9

- feat: add default sync glob `vsix/**` under the Cursor `User` directory so packaged `.vsix` files are backed up with settings; each `.vsix` may be up to 50 MiB regardless of `cursorSync.maxFileSizeKB`.
- feat: add `Cursor Sync: Save Chat Locally` and `Cursor Sync: Load Chat from Local Bundle` using a bundled golden SQLite template and manifest-driven hydration.
- feat: add `Cursor Sync: Export Chat to Private Gist` and `Cursor Sync: Import Chat from Private Gist` for single-conversation `ChatBundle` sharing via private Gists (`chat-bundle.json`), reusing the same build/restore pipeline as local save/load.
- feat: add transcript import from a gist URL, state reconciliation commands for `chats.json`, and landing-zone preparation for sync.
- feat: add sync manifest/engine layer, chat ID alignment, and composer payload merge helpers to support the above flows.

## v0.4.6

- fix: replace fake `workspaceIdentifier` in gist import with `stampWorkspaceIdentifierOnPayload` so imported chats match the real open workspace and appear in the sidebar.
- chore: remove debug logging (`ultraDebugLog`) from gist import flow.

## v0.4.4

- fix: implement deterministic transcript bundle v2 restore mapping with preflight validation for artifact integrity and store workspace resolution.
- fix: restore store artifacts to canonical `~/.cursor/chats/<workspace>/<conversation>/store.db` targets and extend import reporting with per-artifact restore breakdown.
- fix: add best-effort sidebar state restoration by merging `composer.composerHeaders` into `state.vscdb` while preserving rollback-backed file writes.
- test: expand transcript fidelity coverage for v2 preflight failures, store mapping behavior, and full restore outcome messaging while preserving v1 compatibility.
- docs: align transcript fidelity and simulation verification docs with full-restore semantics and degraded-path warnings.
- docs: clarify GitHub token setup in `README.md` to specify using Personal access tokens > Fine-grained tokens with Account permission `Gists: Read and write` (see [GitHub issue #7](https://github.com/Marcelo-Barella/cursor-sync/issues/7) for details).

## v0.4.3

- fix: harden transcript export/import by introducing a checksum-validated bundle manifest that supports richer artifact mapping and safer restore behavior.
- fix: improve import safety with conflict preview/selection plus rollback-backed writes for existing transcript targets.
- test: add transcript export/import fidelity coverage for checksum-backed export, exact JSONL byte preservation, `schemaVersion: 1` backward compatibility, and tolerant import of v2-style manifests with ignored extra artifacts.
- docs: add a transcript simulation verification playbook and clarify in `README.md` that current transcript export/import preserves JSONL files only, not `store.db` payloads or sidebar metadata.

## v0.4.2

- feat: agent transcript export/import with mandatory project targeting on import. Export discovers `~/.cursor/projects/*/agent-transcripts/*.jsonl`, builds a private Gist with a manifest, and import maps each source project to a local project folder before writing. Anyone with the gist URL can open it.
- feat: commands `Cursor Sync: Export Agent Transcripts` and `Cursor Sync: Import Agent Transcripts` (see `cursorSync.transcripts.enabled`, default off; `cursorSync.transcripts.maxFileSizeKB`).
- change: settings export/import gists are private; gist URLs remain accessible to anyone who receives them. Command titles now say Private Gist instead of Public Gist.

## v0.4.1

- feat: broaden default skills sync path from `skills/**/SKILL.md` to `skills/**` so all files under the skills directory are synced, not just SKILL.md files.

## v0.4.0

- feat: replace the TreeView sidebar with a Webview-based panel featuring a rich HTML/CSS interface that adapts to any VS Code theme.
- feat: add an always-visible status card at the top of the sidebar showing sync state, last sync time (relative), sync direction, and tracked file count.
- feat: add a history panel listing up to 50 past sync operations with direction, trigger type, file count, success/failure indicator, and relative timestamps.
- feat: add `Cursor Sync: Sync Now` command that automatically determines whether to push, pull, or both based on local and remote changes.
- feat: Sync Now is available as a sidebar button, a view title toolbar icon, and a Command Palette entry.
- feat: action grid in sidebar provides quick access to Push, Pull, Export, and Import.

## v0.3.2

- feat: scheduled auto-sync now performs pull-push instead of push-only. The scheduler fetches the remote Gist manifest and compares file checksums against local state to determine whether to pull, push, both, or skip.
- feat: `executePull` accepts a `trigger` option; scheduled pulls bypass safe mode confirmation.
- feat: sync is skipped when no changes are detected on either side, and conflicts on the same file block the scheduled sync with a logged warning.

## v0.3.1

- feat: add `cursorSync.syncExtensions.autoInstall` (default `true`) to automatically install extensions from the synced list on pull.
- feat: add `cursorSync.syncExtensions.autoUninstall` (default `false`) and optional confirmation to uninstall extensions that are not in the synced list on pull.

## v0.3.0

- feat: change `cursorSync.schedule.enabled` default to `true`.
- feat: add `Cursor Sync: Export Settings to Public Gist` command to selectively share settings via public Gists.
- feat: add `Cursor Sync: Import Settings from Public Gist` command to import settings from a public Gist URL or ID without requiring a GitHub token.

## v0.2.1

- feat: add `Cursor Sync: Reset Extension State` command to easily clear the GitHub token, sync state, and reset configuration to defaults.

## v0.2.0

- feat: anonymous usage metrics are collected to help improve the extension. No sensitive data (tokens, gist IDs, file paths, or error messages) is ever sent.

## v0.1.6

- feat: add sidebar view and status bar item for Cursor Sync.
- feat: add icons to push and pull commands.
- fix: remove `skills-cursor/**/SKILL.md` from default sync paths.

## v0.1.5

- docs: added changelogs for previous versions.

## v0.1.4

- chore: update package version to 0.1.4 in package.json.
- Save sync state when an existing Gist is found.

## v0.1.3

- feat: enhance Gist management and update package metadata.
- Find existing Gists in GistClient; pull and push use existing Gist when not configured.
- Package version set to 0.1.3; icon path added; assets/icon.png included; .vscodeignore updated for packaging.

## v0.1.1

- chore: update package metadata and add prepublish script.
- Publisher name set to Marcelo Barella; repository URL added in package.json.
- Prepublish script runs build before publishing.
- .cursor added to .gitignore.

## v0.1.0

Initial release.

- Manual push and pull of Cursor user-level settings to a private GitHub Gist.
- Cross-platform support: Windows, macOS, Linux.
- Syncs settings.json, keybindings.json, snippets, rules, skills, and commands.
- Auto-generated extensions.json listing installed extensions.
- Conflict detection and resolution when both local and remote have changed.
- Optional scheduled auto-sync with configurable interval.
- Safe mode: confirmation prompt before pull overwrites.
- Automatic rollback on failed pull operations.
- Retry with exponential backoff for transient API errors.
- Output channel logging for all sync operations.
- PAT stored securely in VS Code SecretStorage.
