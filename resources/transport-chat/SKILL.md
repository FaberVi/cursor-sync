---
name: transport-chat
description: Exports and imports Cursor agent chats between workspaces using offline ChatBundle scripts. Use when the user wants to move, copy, backup, or restore a conversation, transport chat between repos, export/import chat transcripts, or mentions transport-chat.
---

# Transport chat

Move a single Cursor conversation between workspaces: **transcripts**, **`store.db`**, **sidebar state** (`state.vscdb`), and **IDE activation** (`composer.createComposer`).

**Works with [Cursor Sync](https://github.com/Marcelo-Barella/cursor-sync):** disk and SQLite writes stay in this skill’s Python scripts; the extension only talks to the IDE (commands, `pending.json` / `result.json` watcher).

**Requirements:** Python 3. **Cursor Sync** on the destination workspace for Phase B. Each workspace opened in Cursor at least once (`~/.cursor/projects/`, `workspaceStorage/`).

## Responsibility split (mandatory)

| Concern | Owner | Must not |
|---------|--------|----------|
| **Disk restore** — transcripts, `store.db`, **`state.vscdb` merge** | **transport-chat** (`cursor_chat_io.py`, `transport_chat.py`) | Cursor Sync must not write `state.vscdb` on import (it delegates to these scripts) |
| **IDE activation** — `composer.createComposer`, `pending.json`, `result.json` | **Cursor Sync** extension | Python must not call `executeCommand`; bridge only **stages** `pending.json` for headless CLI |
| **Export bundle build (read-only)** | Agent runs `cursor_chat_io.py export` or Cursor Sync export commands (read `state.vscdb` only) | — |

```text
Phase A (disk)     →  transport-chat Python  →  transcripts + store.db + state.vscdb
Phase B (IDE)      →  Cursor Sync extension  →  createComposer + result.json
```

Headless `import --activate` still runs Phase A in Python and **stages** activation; with Cursor Sync installed, the extension watcher completes Phase B without the Python bridge calling the IDE.

**All disk tooling lives under this skill** (no `cursor-sync` repo `scripts/` copies):

```bash
SKILL="${HOME}/.cursor/skills/transport-chat"
SCRIPTS="${SKILL}/scripts"
CHAT_IO="${SCRIPTS}/cursor_chat_io.py"
BRIDGE="${SCRIPTS}/cursor_composer_bridge.py"
TRANSPORT="${SCRIPTS}/transport_chat.py"
```

| Script | Role |
|--------|------|
| `transport_chat.py` | **Full workflow** — `pick`, `resolve`, `backup-global`, `run` |
| `cursor_chat_io.py` | Low-level `list`, `export`, `import`, `verify`, `inspect` — **only writer for `state.vscdb` on import** |
| `cursor_composer_bridge.py` | Stages `pending.json` / optional hook (headless); does **not** replace Cursor Sync IDE bridge |
| `test_import_roundtrip.sh` | Integration test (fixture or live export) |
| `test_extension_import_roundtrip.sh` | CLI + extension manual checklist |
| `build_golden_store.sh` | Rebuild `resources/golden-chat-store.template.db` |

**Docs:** [reference.md](reference.md), [docs/chat-import-activate.md](docs/chat-import-activate.md). Extension: [cursor-sync `docs/chat-import-activate.md`](https://github.com/Marcelo-Barella/cursor-sync/blob/main/docs/chat-import-activate.md).

## Data layers (four)

| Layer | What | Owner | Required for |
|-------|------|--------|--------------|
| 1. Transcripts | `~/.cursor/projects/<project>/agent-transcripts/<uuid>/*.jsonl` | Python | History on disk |
| 2. Store | `~/.cursor/chats/<md5(workspace-path)>/<uuid>/store.db` | Python | Composer runtime blobs |
| 3. Sidebar | `state.vscdb` → `composer.composerHeaders` / `composer.composerData` | **Python only** | Row in chat list |
| 4. Activation | `composer.createComposer` via **Cursor Sync** | Extension | **Content loads in IDE** |

Layers 1–3 = `import` (no `--activate`). Layer 4 = extension or staged `pending.json` + `result.json`.

## Prerequisites (tell user when relevant)

- **Cursor Sync** on the destination workspace for reliable Phase B (Command Palette: **Import Chat Bundle (Activate)**).
- Extension import commands call **`cursor_chat_io.py import`** for disk (including `state.vscdb`); activation is in-process in the extension (`skipPythonBridge`).
- **`CURSOR_COMPOSER_BRIDGE_COMMAND`** — only for headless `import --activate` without Cursor Sync; stdout `{"composerId":"<uuid>"}`. Not needed when the extension is active.
- Stock Cursor CLI cannot run `executeCommand`; the Python bridge **stages only** (exit 2) unless the extension or hook writes `result.json`.
- **Export quality:** if `export` warns the UUID is **not in `composer.composerHeaders`**, activation may be weak; re-export after the chat appears in the source sidebar.
- **Cross-workspace `store.db`:** copied as-is (v1); see [docs/chat-import-activate.md](docs/chat-import-activate.md).

## Mandatory agent workflow

When `/transport-chat` is invoked, follow Gates 1–3 **before** export/import. Use **`transport_chat.py`** for gates and the full run; use **`cursor_chat_io.py`** only when you need a single low-level step.

**Default goal:** user can **open and read** the chat in the destination IDE → **import-v2** (Phase A + Phase B), not disk-only.

### Gate 1 — Source workspace

- If the user gave an absolute **source** path, use it.
- Otherwise ask: *Which workspace folder should we export the chat from?*
- Require an **absolute path**; do not guess.

```bash
python3 "$TRANSPORT" resolve --workspace-folder <SRC_WS>
```

Save `SRC_STATE` and `SRC_PROJECT` from JSON (`stateDb`, `projectKey`).

### Gate 2 — Which conversation

```bash
python3 "$TRANSPORT" pick --workspace-folder <SRC_WS> --limit 15
# optional filter:
python3 "$TRANSPORT" pick --workspace-folder <SRC_WS> -g <keyword>
```

Show the picker output. **Ask which UUID** to export; do not pick unless the user named one.

### Gate 3 — Destination workspace

- If the user gave an absolute **destination** path, use it.
- Otherwise ask: *Which workspace folder should receive this chat?*
- Use the folder Cursor actually has open (worktree vs main repo matters).

```bash
python3 "$TRANSPORT" resolve --workspace-folder <DEST_WS>
```

Save `DEST_STATE`, `DEST_PROJECT`, `DEST_WS` (`folderFsPath`).

### Gate 4 — Two-phase import

Track progress:

```
- [x] Source path confirmed
- [x] Conversation UUID chosen
- [x] Destination path confirmed
- [ ] Backup global state.vscdb
- [ ] Export bundle + inspect
- [ ] Phase A: disk import (Cursor quit recommended) — Python only
- [ ] Phase A: disk verify (all [OK])
- [ ] Phase B: activation (Cursor open on DEST) — Cursor Sync extension
- [ ] Phase B: post-activate verify (activation.result OK)
- [ ] User: Reload Window on destination
```

#### One command (preferred after gates)

Phase A prefers **Cursor quit**; Phase B requires **Cursor open on `DEST_WS`**.

```bash
# Phase A only (Cursor quit recommended):
python3 "$TRANSPORT" run \
  --source <SRC_WS> \
  --destination <DEST_WS> \
  --conversation-id <UUID> \
  --disk-only

# Full import-v2 (Phase A Python + Phase B extension via --activate staging):
python3 "$TRANSPORT" run \
  --source <SRC_WS> \
  --destination <DEST_WS> \
  --conversation-id <UUID> \
  --bridge-wait-result 30
```

Bundle default: `/tmp/chat-transport-<uuid>.json`. Flags: `--skip-backup`, `--dry-run`, `--activate-strict`, `--allow-cursor-running`.

**Or use Cursor Sync after Phase A:** **Import Chat Bundle (Activate)** with the same bundle path (extension runs Phase B only if disk was already imported via Python).

#### Manual steps (same as `run`, for debugging)

**Backup:**

```bash
python3 "$TRANSPORT" backup-global
```

**Export + inspect:**

```bash
BUNDLE="/tmp/chat-transport-<uuid>.json"
python3 "$CHAT_IO" export <UUID> -o "$BUNDLE" --state-db "$SRC_STATE"
python3 "$CHAT_IO" inspect "$BUNDLE"
```

**Phase A** (disk, Cursor quit recommended — **do not use extension Import for `state.vscdb`**):

```bash
python3 "$CHAT_IO" import "$BUNDLE" \
  --workspace-folder "$DEST_WS" \
  --target-project "$DEST_PROJECT" \
  --state-db "$DEST_STATE"
python3 "$CHAT_IO" verify \
  --conversation-id <UUID> \
  --workspace-folder "$DEST_WS" \
  --state-db "$DEST_STATE"
```

**Phase B** (activation, Cursor open on dest — **extension or staged pending**):

```bash
# Stages pending.json; Cursor Sync watcher should write result.json:
python3 "$CHAT_IO" import "$BUNDLE" \
  --workspace-folder "$DEST_WS" \
  --target-project "$DEST_PROJECT" \
  --state-db "$DEST_STATE" \
  --activate \
  --bridge-wait-result 30
python3 "$CHAT_IO" verify ... --post-activate
```

If `activation.result` is **PENDING**: Reload Window on dest → **Cursor Sync: Import Chat Bundle (Activate)** with the same bundle path.

#### After both phases

1. Destination folder open: **`DEST_WS`**
2. **Developer: Reload Window**
3. Open the chat from the sidebar

**Disk-only:** `run --disk-only` or skip Phase B; tell the user content may not load in the composer UI.

## Rules for the agent

| Rule | Detail |
|------|--------|
| Ask first | No export/import without confirmed source, UUID, and destination |
| Use skill scripts only | `${SCRIPTS}/` — never `cursor-sync` repo scripts for disk/`state.vscdb` |
| Backup first | `transport_chat.py backup-global` or Gate 4 checklist |
| Default import-v2 | Unless user wants files only, run Phase A + B |
| **Disk vs IDE** | Phase A: Python only. Phase B: Cursor Sync (or staged `pending.json` + extension watcher) |
| Quit vs open | Phase A: Cursor **quit** when possible; Phase B: Cursor **open** on dest |
| No assumed chat | Do not reuse an old `/tmp` bundle unless the user chose it again |
| Exact paths | `--workspace-folder` must match `resolve` `folderFsPath` |
| `--target-project` | Use `projectKey` from `transport_chat resolve` on the **destination** |
| Verify activation | Do not claim complete if `activation.result` is PENDING when readable chat is required |

## Common fixes

| Issue | Action |
|-------|--------|
| Sidebar OK, **content never loads** | Phase B + Cursor Sync Activate on dest |
| `activation.result` PENDING | Reload dest; **Import Chat Bundle (Activate)**; extension writes `result.json` |
| Chat not in sidebar | Phase A with Cursor quit; Reload; re-run Python `import` (not extension disk path) |
| Global verify FAIL while Cursor running | Quit Cursor, `run --disk-only` then activation again |
| Export: not in `composer.composerHeaders` | Re-export after chat visible in source sidebar |
| Export: no `store.db` in bundle | `import` synthesizes from `resources/golden-chat-store.template.db` + transcript JSONL |
| `Could not resolve workspace` | Open folder in Cursor once, then `resolve` again |
| Extension import without skill | Install transport-chat skill; extension falls back to legacy TS merge with warning |

## Maintainer / tests

```bash
# Fixture roundtrip (no live chat required):
WORKSPACE=/tmp/cursor-transport-test \
  "${SCRIPTS}/test_import_roundtrip.sh" --no-activate

# Regenerate golden store DB after editing resources/golden-store-template.sql:
"${SCRIPTS}/build_golden_store.sh"
```

When ChatBundle format changes: update `cursor_chat_io.py` / `cursor_composer_bridge.py` in this skill first, then align TypeScript types in [cursor-sync](https://github.com/Marcelo-Barella/cursor-sync) (`src/chat-persistence.ts`, `src/chat-partial-state.ts`), then re-run tests in both places.
