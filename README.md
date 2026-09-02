# Cursor Sync (Community)

Community fork of [**Cursor Sync**](https://github.com/Marcelo-Barella/cursor-sync) by [Marcelo Barella](https://github.com/Marcelo-Barella). Maintained by **Vincenzo Fabiano** ([FaberVi/cursor-sync](https://github.com/FaberVi/cursor-sync)).

Sync user-level Cursor settings and selected `~/.cursor` assets to a **private GitHub Gist** or a **GitHub repository**, with manual push/pull, optional scheduled sync, one-shot Gist export/import, extension list sync, and a **Chats** sidebar for discovering, exporting, importing, and syncing Composer conversations across machines.

Current version: **0.12.1**. Development happens on the **`dev`** branch; **`main`** tracks stable releases. Requires **VS Code / Cursor 1.128+** (`engines.vscode`).

## Upstream

| | |
|---|---|
| Original project | [Marcelo-Barella/cursor-sync](https://github.com/Marcelo-Barella/cursor-sync) |
| Original author | Marcelo Barella |
| This fork | [FaberVi/cursor-sync](https://github.com/FaberVi/cursor-sync) |
| Maintainer | Vincenzo Fabiano |

## Build and Install

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ and npm
- [Cursor](https://cursor.com/) or [VS Code](https://code.visualstudio.com/) with the `cursor` / `code` CLI on your `PATH`
- **Python 3** for chat disk import (auto-detected: `py -3` on Windows, `python3` elsewhere). Optional override: user-global `cursorSync.chatImport.pythonPath` in Cursor Settings

### 1. Install dependencies

```bash
git clone https://github.com/FaberVi/cursor-sync.git
cd cursor-sync
npm ci
```

Upstream repository: `git clone https://github.com/Marcelo-Barella/cursor-sync.git`

### 2. Build the VSIX package

```bash
npm run package
```

This runs the production build (`esbuild`) and packages with `@vscode/vsce`. Output:

```
cursor-sync-<version>.vsix
```

For example: `cursor-sync-0.12.1.vsix` in the repository root.

On macOS or Linux you can also run `./package-vsix.sh`.

### 3. Install the extension

**Cursor** (recommended):

```bash
cursor --install-extension ./cursor-sync-0.12.1.vsix --force
```

**VS Code**:

```bash
code --install-extension ./cursor-sync-0.12.1.vsix --force
```

Replace `0.12.1` with the version from `package.json`. Use `--force` to upgrade an existing install.

**Windows (PowerShell)**:

```powershell
cursor --install-extension "C:\path\to\cursor-sync\cursor-sync-0.12.1.vsix" --force
```

### 4. Reload the window

Run **Developer: Reload Window** from the Command Palette so Cursor loads the new build.

### Development workflow

| Command | Description |
|---------|-------------|
| `npm run build` | Compile `dist/extension.js` only |
| `npm run watch` | Rebuild on file changes |
| `npm run package` | Build + create `.vsix` |
| `npm run lint` | TypeScript check (`tsc --noEmit`) |
| `npm test` | Run Vitest (`618` tests) |

For day-to-day development, open this folder in Cursor and press **F5** (Extension Development Host) instead of packaging a VSIX each time.

## What Is Synced

### Cursor User Config

| Platform | Path |
|----------|------|
| Windows  | `%APPDATA%\Cursor\User\` |
| macOS    | `~/Library/Application Support/Cursor/User/` |
| Linux    | `~/.config/Cursor/User/` |

Default `cursorSync.enabledPaths` includes `settings.json`, `keybindings.json`, `snippets/**`, `extensions.json`, `vsix/**`, `skills/**`, `commands/**/*.md`, `rules/*.mdc`, `agents/*.md`, `cli-config.json`, `hooks.json`, and `tasks.json`. Each glob is matched under **both** Cursor User and `~/.cursor`.

### Cursor user data (`~/.cursor`)

Skill-creator / skill-forge eval artifacts (`skill-snapshot/`, `skill-*-backup/`, and `iteration-*` / `eval-*` / `outputs` under eval workspaces) are **never** synced. On activate and after push/pull/import, Cursor Sync can merge missing files from snapshots into live skills, relocate orphan snapshots, and publish recovered skills without a full settings push.

### Optional MCP servers

When `cursorSync.mcp.syncEnabled` is true, Push/Pull also include `mcp.json`. That file can contain MCP server URLs, tokens, and headers — keep the destination private. The toggle overrides a glob in `enabledPaths`. Turning it off does not delete a remote `mcp.json`.

### Always excluded

Extension caches, logs, databases, cookies, `node_modules`, `.git`, and other denylisted paths are skipped. Skill-creator artifact folders under `.cursor/skills/` are excluded. Files above `cursorSync.maxFileSizeKB` (default 512 KB) are skipped.

### Optional chat collection

When `cursorSync.chats.syncEnabled` is true (**default off**), Push/Pull/Sync Now also sync a single `cursor-chat.json` collection to your settings Gist or repo (native chat JSON payloads, optionally encrypted). Chat files stay under `~/.cursor/` (not in the Git project tree). Each chat is identified by the project folder (`~/path/to/repo`) plus conversation id, so the same id in two workspaces is kept as two chats. Pull restores into that project's `~/.cursor/chats/<md5(folder)>/` when the folder exists on this machine (otherwise you pick a folder). Composer activation (`composer.createNew`) runs only for chats that belong to the currently open workspace. The collection is packed newest-first and capped at `cursorSync.chats.maxCollectionSizeKB` (default 8192); skipped chats are listed by title and project in the Sync tab history and Output log.

## Setup

### 1. Create a GitHub Personal Access Token

1. [Fine-grained token](https://github.com/settings/personal-access-tokens/new) or classic PAT with appropriate scopes.
2. **Gist** destination: account permission **Gists: Read and write**.
3. **Repository** destination: **Contents: Read and write** on the target repo.

### 2. Configure the extension

1. Command Palette → **Cursor Sync: Configure GitHub**.
2. Paste your token (stored in VS Code SecretStorage).

### 3. Push and pull

- **Push Now** uploads to your configured Gist or repo folder.
- **Pull Now** applies remote changes without deleting files that exist only on this machine.
- **Mirror from Remote** (Command Palette or secondary sidebar button) aligns this machine to the remote and can delete local-only synced files after a confirmation.
- **Sync Now** merges both directions. Conflicts show in the Sync tab (Keep Local / Keep Remote / Skip); scheduled sync uses a badge instead of a success toast.
- **Stop Sync** (progress Stop button, Command Palette, or status bar while syncing) aborts the in-flight run and restores local files that run changed. Remote GitHub writes already completed and chat/composer databases are not reverted.

Configure destination in the sidebar **Settings** tab or via `cursorSync.destination.*` (`gist` or `repo`).

## Commands

| Command | Description |
|---------|-------------|
| `Cursor Sync: Sync Now` | Bidirectional sync; conflicts block until resolved |
| `Cursor Sync: Stop Sync` | Abort in-flight push/pull/sync and undo local files from this run |
| `Cursor Sync: Configure GitHub` | Set or update PAT |
| `Cursor Sync: Push Now` / `Pull Now` | One-way sync (Pull is incremental; it does not delete local-only files) |
| `Cursor Sync: Mirror from Remote` | Align this machine to the remote; may delete local-only synced files |
| `Cursor Sync: Show Status` | Show last sync metadata |
| `Cursor Sync: Resolve Conflicts` | Focus the Sync-tab conflict panel, or one multi QuickPick if the sidebar is hidden |
| `Cursor Sync: Reset Extension State` | Clear token, sync state, and reset core settings |
| `Cursor Sync: Export Settings to Private Gist` | One-shot settings export |
| `Cursor Sync: Import Settings from Private Gist` | One-shot settings import |
| `Cursor Sync: Export Agent Transcripts to Private Gist` | Transcript manifest v2 export |
| `Cursor Sync: Import Agent Transcripts from Private Gist` | Map projects and restore transcripts/store/sidebar |
| `Cursor Sync: Save Chat Locally` / `Load Chat from Local Bundle` | Local `cursor-chat.json` (legacy `chat-persistence` still imports) |
| `Cursor Sync: Export Chat Bundle` / `Import Chat Bundle` | Workspace chat I/O (`cursor-chat.json`) |
| `Cursor Sync: Export Current Chat Bundle` | From open Composer tab |
| `Cursor Sync: Export Chat to Private Gist` / `Import Chat from Private Gist` | Native `cursor-chat.json` Gist (legacy `chat-bundle.json` / `chat-bundles.json` still import) |
| `Cursor Sync: Export Current Chat Bundle to Gist` | Gist export from Composer tab |
| `Cursor Sync: Import Chat Bundle (Activate)` | Import with Phase B activation |
| `Cursor Sync: Verify Chat Import` | Post-import disk/activation checks |
| `Cursor Sync: Validate Chat Backups` | Inspect local backup tier coverage |
| `Cursor Sync: Set Chat Encryption Password` | Password for encrypted chat Gist files |

Sync failures (push, pull, Sync Now, scheduled) offer **Debug with Cursor** when available: a sanitized debug prompt with optional Composer prefill.

> **Transport-chat scripts** ship inside the extension (`resources/transport-chat/scripts/`). Chat import uses bundled `cursor_chat_io.py` via the extension — no separate `~/.cursor/skills/transport-chat` install is required (legacy skill workflow removed in v0.7.0).

## Sidebar

The **Cursor Sync** activity bar view has three tabs:

### Sync

- Status card (relative last sync, direction, file count)
- **Sync Now**, Push, Pull (incremental), Mirror, Export, Import
- Pending conflicts with Keep Local / Keep Remote / Skip (badge on the Sync tab)
- Sync history (click a row to open the file when it still exists on disk)
- Live progress with elapsed time and absolute percent on pull/push

### Chats

- **Local chats by project** — conversations under `~/.cursor/projects/<project>/agent-transcripts/<uuid>/`, grouped by project with collapsible headers, pagination, backup tier badges (full / resume / partial / archive), **Open**, and **Files**
- **Imports & bundles** — import history, re-activate, reveal transcripts
- **Active operation** — Phase A (disk) / Phase B (activation) progress during import

Use this tab for chat transport across machines or repos (not the deprecated standalone transport-chat skill).

### Settings

Editable controls for schedule, destination (Gist vs repo), chat import defaults, chat Gist encryption, chat pull policy, extension sync options, and UI language (English / Italian). `cursorSync.chatImport.pythonPath` is shown read-only — set it in Cursor Settings for security.

## Settings (highlights)

| Setting | Default | Description |
|---------|---------|-------------|
| `cursorSync.destination.type` | `gist` | `gist` or `repo` |
| `cursorSync.destination.repo` | `""` | `owner/name` for repo sync |
| `cursorSync.schedule.enabled` | `true` | Periodic pull + push |
| `cursorSync.schedule.interval` | `30` | With `intervalUnit` (`seconds` or `minutes`) |
| `cursorSync.safeMode` | `true` | Confirm before overwriting on soft pull |
| `cursorSync.ui.language` | `en` | Sidebar UI: `en` or `it` |
| `cursorSync.chats.syncEnabled` | `false` | Include chat collection in sync |
| `cursorSync.mcp.syncEnabled` | `false` | Include `mcp.json` (may contain secrets) |
| `cursorSync.chats.pullUpdatePolicy` | `skip` | How pull handles existing local chats |
| `cursorSync.chatGist.encrypt` | `true` | Encrypt chat Gist payloads (Argon2id + AES-GCM) |
| `cursorSync.chatImport.activateDefault` | `false` | Offer activation after import |
| `cursorSync.chatImport.useProtobufHydration` | `true` | TS protobuf hydration for native import |
| `cursorSync.chatImport.pythonPath` | `""` | User-global Python path (workspace values ignored) |
| `cursorSync.syncExtensions.autoInstall` | `true` | Prompt to install missing extensions on pull (never silent) |

See `package.json` `contributes.configuration` for the full list.

## Chat export and import

Chat bundles use `type: chat-persistence` with `schemaVersion` 1 or 2:

- Transcript JSONL under `~/.cursor/projects/.../agent-transcripts/`
- Optional `store.db` under `~/.cursor/chats/<md5(workspace)>/<conversationId>/`
- Sidebar snapshots and optional Layer 4 `diskKvSnapshot` (global `state.vscdb` rows) for tool/MCP fidelity

**Local**: Save/Load commands store bundles under extension global storage.

**Private Gist**: Export always writes `cursor-chat.json` (one chat = native `version: 1` document; several chats = `type: "cursor-chat-collection"`). Encrypted envelopes use kinds `cursor-chat` / `cursor-chat-collection`. Import prefers `cursor-chat.json`, then still accepts legacy `chat-bundle.json` / `chat-bundles.json`. Chat import does **not** prompt for Reload Window; transcript import may still offer reload when configured.

**From Composer**: Use editor title actions or **Export Current Chat Bundle** when `resourceScheme == cursor.composer`.

**Gist collection**: Manual export and settings sync both use `cursor-chat.json` (per-project identity, newest-first 8 MB cap) when `chats.syncEnabled` is on.

Details: [`docs/chat-import-activate.md`](docs/chat-import-activate.md).

## Agent transcript export and import

Export selected `agent-transcripts/**/*.jsonl` (and related artifacts) to a `transcript-manifest.json` (`schemaVersion: 2`) on a private Gist. Import maps source projects to local Cursor projects, validates checksums, restores store paths under `~/.cursor/chats/`, and merges composer headers into `state.vscdb` when possible. May offer **Reload Window** after state merge.

Fidelity notes: [`docs/transcript-fidelity-matrix.md`](docs/transcript-fidelity-matrix.md).

## Extension list sync

Push writes `extensions.json` (non-builtin extensions). **`syncExtensions.autoInstall` defaults on**: Pull and Sync Now prompt **Install / Skip** for missing extensions (never silent). Turn it off for zero prompts. When `syncExtensions.autoUninstall` is on, extras not in the synced list are uninstalled without a second prompt.

## Security

- PAT stored only in VS Code SecretStorage.
- Sync targets a private settings Gist or a repo path you configure. One-shot export Gists are private but shareable via URL.
- `cursorSync.chatImport.pythonPath` and `transportChatScriptDir` honor **user-global** values only (workspace overrides are ignored).
- Optional client-side encryption for chat Gist files (`cursorSync.setChatEncryptionPassword`).
- Anonymous usage metrics may be sent without tokens, paths, or gist IDs (see extension analytics implementation).

## Conflict resolution

If the same file changed locally and remotely, push/pull is blocked until you resolve the files in the **Sync** tab (Keep Local / Keep Remote / Skip) or run **Resolve Conflicts** (focuses that panel; falls back to one QuickPick for all files if the sidebar is hidden). After a full resolution, run **Sync Now** once.

## Recovery

Failed pull/import rolls back partial file writes from automatic backups (last three snapshots retained).

## Reset

**Reset Extension State** clears the token, remote linkage, cached extension list, and resets core sync settings to defaults (extension auto-install/uninstall settings are preserved).

## License

MIT — see upstream [Marcelo-Barella/cursor-sync](https://github.com/Marcelo-Barella/cursor-sync).
