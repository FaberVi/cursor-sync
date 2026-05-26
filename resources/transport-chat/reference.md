# transport-chat reference

## Cursor Sync partnership

| Phase | Tooling |
|-------|---------|
| Disk (transcripts, `store.db`, **`state.vscdb` writes**) | This skill — `cursor_chat_io.py` / `transport_chat.py` |
| IDE (`composer.createComposer`, `result.json`) | **Cursor Sync** extension — `src/chat-import-activate.ts`, watcher |

Extension import commands spawn `cursor_chat_io.py import` for disk when the skill is installed; they never merge `state.vscdb` in TypeScript. Headless CLI uses `import --activate` to stage `pending.json`; the extension watcher completes activation.

Full import-v2 + activation contract: [docs/chat-import-activate.md](../../docs/chat-import-activate.md).

## Four storage layers

| Layer | Path | Tool/MCP UI |
|-------|------|-------------|
| 1 — Transcripts | `~/.cursor/projects/<project>/agent-transcripts/<uuid>/**/*.jsonl` | No |
| 2 — Store | `~/.cursor/chats/<ws-key>/<uuid>/store.db` | Partial (native bytes or text synthesis) |
| 3 — Sidebar | `state.vscdb` `ItemTable` (`composer.composerHeaders`, `composer.composerData`) | No |
| 4 — Composer bubbles | Global `state.vscdb` → `cursorDiskKV` (`composerData:`, `bubbleId:`) | **Yes** |

Layer 4 is **required** for tool/MCP cards in the Composer panel. JSONL and Phase B `createComposer` alone do not restore `toolFormerData`.

## ChatBundle schema

| `schemaVersion` | Layer 4 in bundle | Typical export |
|-----------------|-------------------|----------------|
| `1` | Absent — import synthesizes text-only `cursorDiskKV` | TS extension export; Python when no KV on source |
| `2` | Optional `diskKvSnapshot` | Python `export` / `transport_chat.py run` when source has `cursorDiskKV` rows |

### `diskKvSnapshot` (v2 only)

```json
{
  "sourceStateDbPath": "/home/user/.config/Cursor/User/globalStorage/state.vscdb",
  "rows": [
    { "key": "composerData:<uuid>", "value": "{...}", "checksum": "<sha256>" },
    { "key": "bubbleId:<uuid>:<bubbleId>", "value": "{...}", "checksum": "<sha256>" }
  ],
  "rowCount": 37,
  "toolBubbleCount": 12
}
```

- `toolBubbleCount`: bubbles with non-empty `toolFormerData` in parsed `value`.
- Importers accept v1 and v2; reject unknown `schemaVersion`.

## Layer 4 import priority (Phase A)

```text
if bundle.diskKvSnapshot?.rows:
    remap_disk_kv_snapshot_for_destination → merge_cursor_disk_kv   # P0 — native tool UI
else:
    build_cursor_disk_kv_rows_from_bundle()                         # text-only fallback

if bundle.storeSnapshot (checksum OK):
    write store.db bytes
else:
    synthesize_store_db_from_bundle()                               # golden + JSONL text

merge sidebarSnapshot → ItemTable (layers 3)
```

Never call text-only KV synthesis when `diskKvSnapshot.rows` is present.

## Fidelity failure modes (quick)

| Symptom | Cause |
|---------|--------|
| No tool/MCP cards | v1 bundle or v2 without `diskKvSnapshot` |
| `toolBubbleCount: 0` at export | Chat never materialized bubbles on source global DB |
| Plain bubbles, “No request ID” | Text-only synthesis path |
| Store missing | Checksum mismatch or export without `store.db` |

See [docs/chat-import-activate.md](../../docs/chat-import-activate.md#transport-fidelity--failure-modes) for full table. Gap matrix: `docs/superpowers/specs/transport-chat-gap-matrix.md`.

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
| `export <uuid> -o bundle.json` | Build ChatBundle (v2 + `diskKvSnapshot` when Layer 4 exists on source) |
| `import bundle.json --workspace-folder PATH` | Restore layers 1–4 (native KV or text synthesis; golden `store.db` when no store snapshot) |
| `import ... --activate` | Disk + Phase B activation (`createComposer`) |
| `verify --conversation-id UUID --workspace-folder PATH` | Post-import disk checks |
| `verify ... --post-activate` | Disk + `pending.json` / `result.json` |
| `inspect bundle.json` | Bundle summary (`schemaVersion`, `diskKvSnapshot` row/tool counts when v2) |

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

| Phase | Cursor | Tooling | Layers restored |
|-------|--------|---------|-----------------|
| A — Disk | Quit (recommended) | `run --disk-only` or `import` without `--activate` | 1–4 (`state.vscdb` + `cursorDiskKV` via Python) |
| B — Activation | Open on **destination** | Cursor Sync extension, or staged `pending.json` + watcher | Metadata only (`createComposer`) — not bubble UI |

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
