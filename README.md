# Cursor Sync (Community)

Community fork of [**Cursor Sync**](https://github.com/Marcelo-Barella/cursor-sync) by [Marcelo Barella](https://github.com/Marcelo-Barella). Maintained by **Vincenzo Fabiano** ([FaberVi/cursor-sync](https://github.com/FaberVi/cursor-sync)).

Sync user-level Cursor settings and selected `~/.cursor` assets to a **private GitHub repository** via a local `git` clone, with manual push/pull, optional scheduled sync, extension list sync, and a **Chats** sidebar for discovering, exporting, importing, and syncing Composer conversations across machines.

Current version: **2.0.0**. Development happens on the **`dev`** branch; **`main`** tracks stable releases. Requires **VS Code / Cursor 1.128+** (`engines.vscode`), **Git on PATH** (Git for Windows on Windows), and a GitHub PAT with **`repo`** scope (or fine-grained Contents access to the target repository).

## Upstream

| | |
|---|---|
| Original project | [Marcelo-Barella/cursor-sync](https://github.com/Marcelo-Barella/cursor-sync) |
| Original author | Marcelo Barella |
| This fork | [FaberVi/cursor-sync](https://github.com/FaberVi/cursor-sync) |
| Maintainer | Vincenzo Fabiano |

## Build and Install

### Prerequisites

- [Node.js](https://nodejs.org/) 20+ and [pnpm](https://pnpm.io/)
- [Git](https://git-scm.com/download/win) on PATH (Git for Windows on Windows)
- [Cursor](https://cursor.com/) or [VS Code](https://code.visualstudio.com/) with the `cursor` / `code` CLI on your `PATH`
- **Python 3** for chat disk import (auto-detected: `py -3` on Windows, `python3` elsewhere). Optional override: user-global `cursorSync.chatImport.pythonPath` in Cursor Settings

### 1. Install dependencies

```bash
git clone https://github.com/FaberVi/cursor-sync.git
cd cursor-sync
pnpm install
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

For example: `cursor-sync-2.0.0.vsix` in the repository root.

On macOS or Linux you can also run `./package-vsix.sh`.

### 3. Install the extension

**Cursor** (recommended):

```bash
cursor --install-extension ./cursor-sync-2.0.0.vsix --force
```

**VS Code**:

```bash
code --install-extension ./cursor-sync-2.0.0.vsix --force
```

Replace `1.0.0` with the version from `package.json`. Use `--force` to upgrade an existing install.

**Windows (PowerShell)**:

```powershell
cursor --install-extension "C:\path\to\cursor-sync\cursor-sync-2.0.0.vsix" --force
```

### 4. Reload the window

Run **Developer: Reload Window** from the Command Palette so Cursor loads the new build.

### Development workflow

| Command | Description |
|---------|-------------|
| `pnpm run build` | Compile `dist/extension.js` only |
| `pnpm run watch` | Rebuild on file changes |
| `pnpm run package` | Build + create `.vsix` |
| `pnpm run lint` | TypeScript check (`tsc --noEmit`) |
| `pnpm test` | Run Vitest |

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

When `cursorSync.chats.syncEnabled` is true (**default off**), Push/Pull/Sync Now also sync a single `cursor-chat.json` collection at the repository base path (native chat JSON payloads, optionally encrypted). Chat files stay under `~/.cursor/` (not in the Git project tree). Each chat is identified by the project folder (`~/path/to/repo`) plus conversation id, so the same id in two workspaces is kept as two chats. Pull restores into that project's `~/.cursor/chats/<md5(folder)>/` when the folder exists on this machine (otherwise you pick a folder). Composer activation (`composer.createNew`) runs only for chats that belong to the currently open workspace. The collection is packed newest-first and capped at `cursorSync.chats.maxCollectionSizeKB` (default 8192); skipped chats are listed by title and project in the Sync tab history and Output log.

## Setup

### 1. Create a GitHub Personal Access Token

Use a [classic PAT](https://github.com/settings/tokens) with **`repo`** scope, or a [fine-grained token](https://github.com/settings/personal-access-tokens/new) with Contents: Read and write on the target repository.

### 2. Configure the extension

1. Command Palette → **Cursor Sync: Configure GitHub**.
2. Paste your token (stored in VS Code SecretStorage). The PAT is passed to git only as `http.extraHeader`; it is never written into the remote URL or `.git/config`.
3. Enter `owner/name`. If the repository does not exist you can create it (private or public).

The local clone lives under the extension global storage folder (`sync-repo`), sparse-checked out to `cursorSync.destination.path` (default `cursor-sync`). Layout: `{path}/cursor-user/…`, `{path}/dot-cursor/…`, and `{path}/cursor-chat.json`.

### 3. Push and pull

- **Push Now** copies Cursor User + `~/.cursor` into the clone and `git push` (no force; Git refuses non-fast-forward). If origin is ahead, Push refuses until you Pull. If histories have diverged, Push refuses until **Reset to remote** or you fix the clone in a file manager.
- **Pull Now** fast-forwards the clone, then **replaces** synced Cursor folders from it (including deleting local-only synced files and replacing skill folders). A modal lists how many files will update/delete and how many skill folders will be replaced.
- **Reset to remote** discards local clone commits, matches origin, then copies into Cursor (same replace confirmation).
- **Open clone** reveals the clone directory in the OS file manager.
- **Sync Now** uses the same decision table as the scheduler: pull if origin is ahead or a never-synced machine already has nested clone files; otherwise push. Fast-forward only — no merge, no Keep Local/Remote.
- Scheduled sync **never** shows the pull replace modal: if a pull would be required it skips and records history `"pull required"`.
- **Stop Sync** aborts the in-flight run, restores local Cursor files that run changed, and can `git reset --hard` the clone to the SHA captured before copy.

Gist destination, one-shot Gist export/import, Mirror, and conflict Keep Local/Remote were removed in 2.0. Leftover `destination.type = gist` settings show a warning to connect a repository; there is no automatic Gist content migration.

Configure destination in the sidebar **Settings** tab or via `cursorSync.destination.repo` / `branch` / `path`.

## Commands

| Command | Description |
|---------|-------------|
| `Cursor Sync: Sync Now` | Fast-forward the clone, then push when origin is not ahead |
| `Cursor Sync: Stop Sync` | Abort in-flight push/pull/sync and undo local files from this run |
| `Cursor Sync: Configure GitHub` | Set or update PAT and repository |
| `Cursor Sync: Push Now` / `Pull Now` | Copy Cursor → clone → origin, or origin → clone → Cursor |
| `Cursor Sync: Reset to Remote` | Discard local clone commits and replace synced Cursor files from origin |
| `Cursor Sync: Open Sync Clone` | Reveal the local git clone in the file manager |
| `Cursor Sync: Show Status` | Show last sync metadata |
| `Cursor Sync: Reset Extension State` | Clear token, sync state, local clone, and reset core settings |
| `Cursor Sync: Save Chat Locally` / `Load Chat from Local Bundle` | Local `cursor-chat.json` (legacy `chat-persistence` still imports) |
| `Cursor Sync: Export Chat Bundle` / `Import Chat Bundle` | Workspace chat I/O (`cursor-chat.json`) |
| `Cursor Sync: Export Current Chat Bundle` | From open Composer tab |
| `Cursor Sync: Import Chat Bundle (Activate)` | Import with Phase B activation |
| `Cursor Sync: Verify Chat Import` | Post-import disk/activation checks |
| `Cursor Sync: Validate Chat Backups` | Inspect local backup tier coverage |
| `Cursor Sync: Set Chat Encryption Password` | Password for encrypted `cursor-chat.json` in the clone |

Sync failures (push, pull, Sync Now, scheduled) offer **Debug with Cursor** when available: a sanitized debug prompt with optional Composer prefill.

> **Transport-chat scripts** ship inside the extension (`resources/transport-chat/scripts/`). Chat import uses bundled `cursor_chat_io.py` via the extension — no separate `~/.cursor/skills/transport-chat` install is required (legacy skill workflow removed in v0.7.0).

## Sidebar

The **Cursor Sync** activity bar view has three tabs:

### Sync

- Status card (relative last sync, direction, file count). On first open the tab shows **Loading…** until sync metadata is hydrated — not a false “never synced” state.
- **Sync Now**, Push, Pull, Reset to remote, Open clone, Open Cursor folder
- Sync history: click a row to open files when recorded; delete one entry (trash icon) or **Clear** all via the control next to the History title (both ask for modal confirmation)
- Live progress with elapsed time and absolute percent on pull/push; large repo pushes upload Git trees in chunks to avoid GitHub timeouts

### Chats

- **Local chats by project** — conversations under `~/.cursor/projects/<project>/agent-transcripts/<uuid>/`, grouped by project with collapsible headers, pagination, backup tier badges (full / resume / partial / archive), **Open**, and **Files**
- **Imports & bundles** — import history, re-activate, reveal transcripts
- **Active operation** — Phase A (disk) / Phase B (activation) progress during import

Use this tab for chat transport across machines or repos (not the deprecated standalone transport-chat skill).

### Settings

Editable controls for schedule, repository (`owner/name`, branch, path), chat import defaults, chat pull policy, MCP sync, and UI language (English / Italian). `cursorSync.chatImport.pythonPath` is shown read-only — set it in Cursor Settings for security.

## Settings (highlights)

| Setting | Default | Description |
|---------|---------|-------------|
| `cursorSync.destination.repo` | `""` | GitHub repository as `owner/name` |
| `cursorSync.destination.branch` | `main` | Branch used for the clone |
| `cursorSync.destination.path` | `cursor-sync` | Directory inside the repository where sync files are stored |
| `cursorSync.schedule.enabled` | `true` | Periodic pull/push decision (pulls are skipped until confirmed) |
| `cursorSync.schedule.interval` | `30` | With `intervalUnit` (`seconds` or `minutes`) |
| `cursorSync.ui.language` | `en` | Sidebar UI: `en` or `it` |
| `cursorSync.chats.syncEnabled` | `false` | Include chat collection in sync |
| `cursorSync.chats.encrypt` | `true` | Encrypt `cursor-chat.json` in the clone (Argon2id + AES-GCM). Reads leftover `chatGist.encrypt` if unset |
| `cursorSync.mcp.syncEnabled` | `false` | Include `mcp.json` (may contain secrets) |
| `cursorSync.chats.pullUpdatePolicy` | `skip` | How pull handles existing local chats |
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

**Repository sync**: When `chats.syncEnabled` is on, Push writes `cursor-chat.json` at the repo base path (native `version: 1` document or `type: "cursor-chat-collection"`). Encrypted envelopes use kinds `cursor-chat` / `cursor-chat-collection`. Pull reads that clone file. Chat import does **not** prompt for Reload Window.

**From Composer**: Use editor title actions or **Export Current Chat Bundle** when `resourceScheme == cursor.composer`.

Details: [`docs/chat-import-activate.md`](docs/chat-import-activate.md).

## Agent transcripts

Local transcript discovery still backs chat bundles (`agent-transcripts/**/*.jsonl` and related store paths). One-shot Gist transcript export/import was removed in 2.0.

Fidelity notes: [`docs/transcript-fidelity-matrix.md`](docs/transcript-fidelity-matrix.md).

## Extension list sync

Push writes `extensions.json` (non-builtin extensions). **`syncExtensions.autoInstall` defaults on**: Pull and Sync Now prompt **Install / Skip** for missing extensions (never silent). Turn it off for zero prompts. When `syncExtensions.autoUninstall` is on, extras not in the synced list are uninstalled without a second prompt.

## Security

- PAT stored only in VS Code SecretStorage and passed to git as `http.extraHeader`.
- Sync targets the GitHub repository you configure. Prefer a **private** repo if you enable MCP or chat sync.
- `cursorSync.chatImport.pythonPath` and `transportChatScriptDir` honor **user-global** values only (workspace overrides are ignored).
- Optional client-side encryption for the cloned chat collection (`cursorSync.setChatEncryptionPassword`).
- Anonymous usage metrics may be sent without tokens, paths, or repository ids (see extension analytics implementation).

## Diverged clone

Push and Sync Now refuse when the local clone and origin have diverged (fast-forward only; no force-push). Use **Reset to remote** to discard local clone commits and replace Cursor files from origin, or **Open clone** and fix the git history yourself.

## Recovery

Failed pull/import rolls back partial file writes from automatic backups (last three snapshots retained).

## Reset

**Reset Extension State** clears the token, remote linkage, local git clone, cached extension list, and resets core sync settings to defaults (extension auto-install/uninstall settings are preserved).

## License

MIT — see upstream [Marcelo-Barella/cursor-sync](https://github.com/Marcelo-Barella/cursor-sync).
