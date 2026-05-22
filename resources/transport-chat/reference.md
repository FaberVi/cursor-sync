# transport-chat reference

## Cursor Sync partnership

| Phase | Tooling |
|-------|---------|
| Disk (transcripts, `store.db`, **`state.vscdb` writes**) | This skill — `cursor_chat_io.py` / `transport_chat.py` |
| IDE (`composer.createComposer`, `result.json`) | **Cursor Sync** extension — `src/chat-import-activate.ts`, watcher |

Extension import commands spawn `cursor_chat_io.py import` for disk when the skill is installed; they never merge `state.vscdb` in TypeScript. Headless CLI uses `import --activate` to stage `pending.json`; the extension watcher completes activation.

## Scripts (skill-local)

| Path | Purpose |
|------|---------|
| `scripts/transport_chat.py` | Orchestrator: `pick`, `resolve`, `backup-global`, `run` |
| `scripts/cursor_chat_io.py` | `list`, `paths`, `resolve`, `export`, `import`, `verify`, `inspect` |
| `scripts/cursor_composer_bridge.py` | Activation staging / optional shell hook |
| `scripts/test_import_roundtrip.sh` | End-to-end CLI test |
| `scripts/test_extension_import_roundtrip.sh` | CLI + extension manual path |
| `scripts/build_golden_store.sh` | Build `resources/golden-chat-store.template.db` |
| `scripts/gen_*_golden.py` | Regenerate test fixture JSON from Python reference |

## transport_chat.py

| Command | Purpose |
|---------|---------|
| `pick --workspace-folder PATH` | Recent chats for that workspace’s `projectKey` |
| `pick --project-key NAME` | Filter by `~/.cursor/projects/<name>` |
| `pick -g KEYWORD` | Filter preview / project / UUID |
| `resolve --workspace-folder PATH` | JSON: `stateDb`, `projectKey`, `chatsWorkspaceKey` |
| `backup-global` | `state.vscdb` → `state.vscdb.sync.backup` |
| `run --source SRC --destination DEST --conversation-id UUID` | Full Gate 4 workflow |

### run flags

| Flag | Effect |
|------|--------|
| `--disk-only` | Phase A only (no `--activate`) |
| `--skip-backup` | Skip global backup |
| `--skip-phase-a` | Export only (unusual) |
| `--dry-run` | No disk writes |
| `--bridge-wait-result SECONDS` | Poll `result.json` after Phase B (default 30) |
| `--activate-strict` | Fail if activation not confirmed |
| `--allow-cursor-running` | Suppress Phase A warning |
| `-o PATH` | Bundle output path |

## cursor_chat_io.py commands

| Command | Purpose |
|---------|---------|
| `list` | All conversation UUIDs on this machine |
| `paths` | `projects_root`, `chats_root`, `state.vscdb` candidates |
| `resolve` | `chatsWorkspaceKey`, `workspaceStorageId` |
| `export <uuid> -o bundle.json` | Build ChatBundle |
| `import bundle.json --workspace-folder PATH` | Restore layers 1–3 (synthesizes `store.db` from golden template when bundle has no store snapshot) |
| `import ... --activate` | Disk + activation (layer 4) |
| `verify --conversation-id UUID --workspace-folder PATH` | Post-import disk checks |
| `verify ... --post-activate` | Disk + `pending.json` / `result.json` |
| `inspect bundle.json` | Bundle summary |

### Import flags

| Flag | Use |
|------|-----|
| `--workspace-folder PATH` | **Required.** md5 chats key + `workspaceIdentifier` |
| `--target-project NAME` | Remap transcript paths (`transport_chat resolve` → `projectKey`) |
| `--state-db PATH` | Workspace `state.vscdb` for sidebar merge |
| `--activate` | Stage/run IDE activation |
| `--activate-strict` | Fail if staged only |
| `--bridge-wait-result SECONDS` | Poll `~/.cursor/import-activation/result.json` |
| `--dry-run` | Print planned writes only |
| `--no-global-state` | Skip global merge (not recommended) |

## Two-phase workflow

| Phase | Cursor | Tooling | Writes `state.vscdb`? |
|-------|--------|---------|----------------------|
| A — Disk | Quit (recommended) | `run --disk-only` or `import` without `--activate` | **Yes (Python only)** |
| B — Activation | Open on **destination** | Cursor Sync extension, or staged `pending.json` + watcher | No |

## Activation (Phase B)

1. **Cursor Sync** (required in IDE) — `composer.createComposer`, `pending.json` watcher, `result.json`. Does not write `state.vscdb`.
2. **`import --activate`** — Python runs Phase A then stages `pending.json`; extension completes Phase B.
3. **`CURSOR_COMPOSER_BRIDGE_COMMAND`** — headless hook only when extension is absent; stdout `{"composerId":"<uuid>"}`.
4. **Manual** — `~/.cursor/import-activation/result.json`: `{"ok":true,"composerId":"<uuid>"}`.

See [docs/chat-import-activate.md](docs/chat-import-activate.md).

## Platform paths

| OS | Cursor User config |
|----|-------------------|
| Linux | `~/.config/Cursor/User/` |
| macOS | `~/Library/Application Support/Cursor/User/` |
| Windows | `%APPDATA%/Cursor/User/` |

Shared: `~/.cursor/projects/`, `~/.cursor/chats/`, `~/.cursor/import-activation/`.

Global backup: `globalStorage/state.vscdb.sync.backup`

## Upstream sync

**Source of truth for disk/`state.vscdb`:** this skill’s `scripts/`. When ChatBundle format changes, update Python here first, then align [cursor-sync](https://github.com/Marcelo-Barella/cursor-sync) TypeScript types and `src/chat-transport-scripts.ts`, then run `test_import_roundtrip.sh`.
