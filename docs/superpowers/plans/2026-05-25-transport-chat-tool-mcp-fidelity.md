# Transport Chat Tool/MCP Fidelity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Future `/transport-chat` and Cursor Sync import runs preserve tool-call and MCP-call UI in the Composer panel by round-tripping the native `cursorDiskKV` bubble layer (and keeping existing `store.db` byte copy when available).

**Architecture:** Extend ChatBundle to **schemaVersion 2** with an optional `diskKvSnapshot` (global `state.vscdb` rows: `composerData:<id>` + `bubbleId:<id>:*`). Export captures these rows from source; import merges them into destination global DB and remaps `workspaceIdentifier` to the destination workspace. When `diskKvSnapshot` is absent, keep today's text-only synthesis fallback unchanged. Phase B (`createComposer`) stays metadata-only; UI fidelity comes from Phase A disk restore.

**Tech Stack:** Python 3 (`cursor_chat_io.py`, `transport_chat.py`), TypeScript (`chat-persistence.ts`, `chat-bundle-format.ts`), SQLite (`state.vscdb` / `cursorDiskKV`), existing golden fixtures + `test_import_roundtrip.sh`.

---

## Problem summary (future runs)

| Layer | Tool/MCP today | After this plan |
|-------|----------------|-----------------|
| JSONL transcripts | Preserved | Preserved (unchanged) |
| `store.db` | Copied when present; else text-only synthesis | Unchanged (already best-effort) |
| `cursorDiskKV` bubbles | **Not exported; text-only resynthesis** | **Exported + imported with toolFormerData** |
| Phase B activation | Metadata only | Unchanged |

---

## File map

| File | Responsibility |
|------|----------------|
| `resources/transport-chat/scripts/cursor_chat_io.py` | Export/import `diskKvSnapshot`, import priority logic, verify checks |
| `resources/transport-chat/scripts/transport_chat.py` | Pass-through; update inspect output |
| `src/chat-bundle-format.ts` | Validate schema v2, optional `diskKvSnapshot` |
| `src/chat-persistence.ts` | TypeScript `ChatBundle` v2 type; export path alignment if TS builds bundles |
| `tests/test_disk_kv_snapshot.py` | Python unit + roundtrip tests (new) |
| `tests/chat-bundle-format.test.ts` | v2 validation |
| `tests/chat-import-v2.test.ts` | Extend verify expectations |
| `resources/transport-chat/tests/fixtures/disk-kv-tool-bubbles/` | Golden KV rows with `toolFormerData` |
| `docs/chat-import-activate.md` | Document 4th layer + v2 bundle |
| `resources/transport-chat/reference.md` | Update data model table |
| `CHANGELOG.md` | User-facing note on v2 bundle (on release) |

---

## ChatBundle schema v2

Add optional field; bump only when present on export:

```typescript
// schemaVersion: 2
diskKvSnapshot: {
  sourceStateDbPath: string;
  rows: Array<{
    key: string;           // composerData:<uuid> | bubbleId:<uuid>:<bubbleId>
    value: string;         // JSON string (bubble row)
    checksum: string;      // sha256 of UTF-8 value bytes
  }>;
  rowCount: number;
  toolBubbleCount: number; // bubbles where parsed value has non-empty toolFormerData
} | null;
```

**Backward compatibility:** `schemaVersion: 1` bundles import exactly as today. Importers accept v1 and v2; exporters write v2 when any `diskKvSnapshot` rows exist.

---

## Import priority (single function)

```
if bundle.diskKvSnapshot?.rows:
    merge_cursor_disk_kv(remapped rows)     # P0 — tool UI
elif bundle.storeSnapshot:
    write store.db bytes                    # existing
else:
    synthesize_store_db_from_bundle()       # existing text-only

if not bundle.diskKvSnapshot:
    build_cursor_disk_kv_rows_from_bundle() # existing fallback only
```

Never run text-only KV synthesis when `diskKvSnapshot` is present.

---

### Task 1: Spec fixture — tool bubble golden data

**Files:**
- Create: `resources/transport-chat/tests/fixtures/disk-kv-tool-bubbles/composerData.json`
- Create: `resources/transport-chat/tests/fixtures/disk-kv-tool-bubbles/bubble-tool.json`
- Create: `resources/transport-chat/tests/fixtures/disk-kv-tool-bubbles/bubble-text.json`

- [ ] **Step 1: Capture minimal native bubble shapes**

Create `bubble-tool.json` — one bubble row with:
- `capabilityType: 15`
- non-empty `toolFormerData` (`name`, `status`, `rawArgs` or `params`)
- empty `toolResults` (matches native pattern)

Create `bubble-text.json` — user/assistant text bubble (`type: 1` or `2`, `text` only).

Create `composerData.json` — `composerData:{conversationId}` with `fullConversationHeadersOnly` referencing both bubble IDs.

Use conversation ID `fixture-tool-mcp-00000000-0000-4000-8000-000000000001`.

- [ ] **Step 2: Commit fixture**

```bash
git add resources/transport-chat/tests/fixtures/disk-kv-tool-bubbles/
git commit -m "test: add disk-kv tool bubble fixtures for transport fidelity"
```

---

### Task 2: Python — export diskKvSnapshot

**Files:**
- Modify: `resources/transport-chat/scripts/cursor_chat_io.py`
- Create: `resources/transport-chat/tests/test_disk_kv_snapshot.py`
- Test: `resources/transport-chat/tests/test_disk_kv_snapshot.py`

- [ ] **Step 1: Write failing export test**

```python
# resources/transport-chat/tests/test_disk_kv_snapshot.py
import json
import sqlite3
import tempfile
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from cursor_chat_io import export_disk_kv_snapshot, build_bundle  # to be added

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "disk-kv-tool-bubbles"
CID = "fixture-tool-mcp-00000000-0000-4000-8000-000000000001"

def _seed_global_db(db_path: Path) -> None:
    composer = json.loads((FIXTURE / "composerData.json").read_text())
    bubble_tool = (FIXTURE / "bubble-tool.json").read_text()
    bubble_text = (FIXTURE / "bubble-text.json").read_text()
    headers = composer["fullConversationHeadersOnly"]
    bid_tool = headers[1]["bubbleId"]
    bid_text = headers[0]["bubbleId"]
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);"
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"composerData:{CID}", json.dumps(composer, separators=(",", ":"))),
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"bubbleId:{CID}:{bid_text}", bubble_text),
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"bubbleId:{CID}:{bid_tool}", bubble_tool),
    )
    conn.commit()
    conn.close()

def test_export_disk_kv_snapshot_includes_tool_bubbles(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_global_db(db)
    snap = export_disk_kv_snapshot(db, CID)
    assert snap is not None
    assert snap["rowCount"] == 3
    assert snap["toolBubbleCount"] >= 1
    keys = {r["key"] for r in snap["rows"]}
    assert f"composerData:{CID}" in keys
    assert any(k.startswith(f"bubbleId:{CID}:") for k in keys)
```

- [ ] **Step 2: Run test — expect FAIL**

```bash
cd /home/marcelo/dev/private/cursor-sync/resources/transport-chat
python3 -m pytest tests/test_disk_kv_snapshot.py::test_export_disk_kv_snapshot_includes_tool_bubbles -v
```

Expected: `ImportError: cannot import name 'export_disk_kv_snapshot'`

- [ ] **Step 3: Implement `export_disk_kv_snapshot`**

Add near `read_composer_rows` in `cursor_chat_io.py`:

```python
def export_disk_kv_snapshot(global_db: Path, conversation_id: str) -> dict[str, Any] | None:
    if not global_db.is_file():
        return None
    prefix_bubble = f"bubbleId:{conversation_id}:"
    key_composer = f"composerData:{conversation_id}"
    conn = sqlite3.connect(global_db)
    try:
        rows: list[dict[str, Any]] = []
        tool_count = 0
        cur = conn.execute(
            "SELECT key, value FROM cursorDiskKV WHERE key = ? OR key LIKE ?;",
            (key_composer, prefix_bubble + "%"),
        )
        for key, value in cur.fetchall():
            if not isinstance(value, str):
                continue
            rows.append({
                "key": key,
                "value": value,
                "checksum": sha256_hex(value.encode("utf-8")),
            })
            try:
                obj = json.loads(value)
                if obj.get("toolFormerData"):
                    tool_count += 1
            except json.JSONDecodeError:
                pass
        if not rows:
            return None
        return {
            "sourceStateDbPath": str(global_db),
            "rows": rows,
            "rowCount": len(rows),
            "toolBubbleCount": tool_count,
        }
    finally:
        conn.close()
```

- [ ] **Step 4: Wire into `build_bundle`**

After sidebar snapshot block (~line 1423), add:

```python
    disk_kv_snapshot = None
    global_db = global_state_db_path()
    try:
        disk_kv_snapshot = export_disk_kv_snapshot(global_db, conversation_id)
    except sqlite3.Error as e:
        warnings.append(f"diskKv export failed: {e}")
    if disk_kv_snapshot is None:
        warnings.append(
            f"No cursorDiskKV rows for {conversation_id}; "
            "import will synthesize text-only composer bubbles."
        )

    schema_version = SCHEMA_VERSION if disk_kv_snapshot is None else 2
    # in bundle dict:
    # "schemaVersion": schema_version,
    # "diskKvSnapshot": disk_kv_snapshot,
```

Bump `SCHEMA_VERSION` constant usage: keep `1` as minimum; write `2` when `diskKvSnapshot` present.

- [ ] **Step 5: Run test — expect PASS**

```bash
python3 -m pytest tests/test_disk_kv_snapshot.py::test_export_disk_kv_snapshot_includes_tool_bubbles -v
```

- [ ] **Step 6: Commit**

```bash
git add resources/transport-chat/scripts/cursor_chat_io.py resources/transport-chat/tests/
git commit -m "feat(transport): export cursorDiskKV snapshot for tool/MCP bubbles"
```

---

### Task 3: Python — import diskKvSnapshot with workspace remap

**Files:**
- Modify: `resources/transport-chat/scripts/cursor_chat_io.py`
- Test: `resources/transport-chat/tests/test_disk_kv_snapshot.py`

- [ ] **Step 1: Write failing import test**

```python
def test_import_disk_kv_snapshot_preserves_tool_former_data(tmp_path, monkeypatch):
  # seed bundle with diskKvSnapshot from Task 2 export
  # seed destination global db (empty cursorDiskKV table)
  # call import_disk_kv_snapshot_from_bundle(bundle, dest_ws_ctx)
  # assert destination has toolFormerData bubble
  # assert composerData.workspaceIdentifier.fsPath == dest folder
```

(Fill dest paths using `tmp_path` and monkeypatch `global_state_db_path` to point at temp DB.)

- [ ] **Step 2: Run test — expect FAIL**

- [ ] **Step 3: Implement import helpers**

```python
def remap_disk_kv_snapshot_for_destination(
    snapshot: dict[str, Any],
    conversation_id: str,
    workspace_identifier: dict[str, Any] | None,
) -> dict[str, str]:
    rows_out: dict[str, str] = {}
    for row in snapshot.get("rows") or []:
        key = str(row["key"])
        value = str(row["value"])
        if key == f"composerData:{conversation_id}" and workspace_identifier:
            try:
                obj = json.loads(value)
                obj["workspaceIdentifier"] = workspace_identifier
                value = json.dumps(obj, separators=(",", ":"), ensure_ascii=False)
            except json.JSONDecodeError:
                pass
        rows_out[key] = value
    return rows_out
```

- [ ] **Step 4: Change `import_bundle` KV branch**

Replace unconditional `build_cursor_disk_kv_rows_from_bundle` call (~line 2249) with:

```python
    disk_kv = bundle.get("diskKvSnapshot")
    if disk_kv and isinstance(disk_kv, dict) and disk_kv.get("rows"):
        kv_rows = remap_disk_kv_snapshot_for_destination(
            disk_kv, cid, ws_identifier
        )
        warnings.append(
            f"Restored {len(kv_rows)} cursorDiskKV rows from bundle "
            f"(toolBubbleCount={disk_kv.get('toolBubbleCount', 0)})."
        )
    else:
        kv_rows = build_cursor_disk_kv_rows_from_bundle(bundle, cid, ws_identifier)
```

- [ ] **Step 5: Run import test — expect PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "feat(transport): import diskKvSnapshot with workspace remap"
```

---

### Task 4: Python — verify tool bubble fidelity

**Files:**
- Modify: `resources/transport-chat/scripts/cursor_chat_io.py`
- Test: `resources/transport-chat/tests/test_disk_kv_snapshot.py`

- [ ] **Step 1: Write failing verify test**

Add check function test: after import, `verify_import_visibility` includes:

```python
VerifyCheck(
    name="global.diskKv.toolBubbles",
    status="OK" if tool_count >= expected else "FAIL",
    detail=f"toolFormerData bubbles={tool_count} expected>={expected}",
)
```

- [ ] **Step 2: Implement `count_tool_bubbles_in_global_db(conversation_id)`**

Query `cursorDiskKV` for `bubbleId:{cid}:%`, parse JSON, count non-empty `toolFormerData`.

- [ ] **Step 3: Wire into verify when bundle has `diskKvSnapshot.toolBubbleCount > 0`**

- [ ] **Step 4: Run tests + roundtrip script**

```bash
python3 -m pytest resources/transport-chat/tests/test_disk_kv_snapshot.py -v
WORKSPACE=/tmp/cursor-transport-test \
  resources/transport-chat/scripts/test_import_roundtrip.sh --no-activate
```

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(transport): verify tool bubble count after diskKv import"
```

---

### Task 5: TypeScript bundle format v2

**Files:**
- Modify: `src/chat-bundle-format.ts`
- Modify: `src/chat-persistence.ts`
- Test: `tests/chat-bundle-format.test.ts`

- [ ] **Step 1: Write failing v2 validation test**

```typescript
it("accepts schemaVersion 2 with diskKvSnapshot", () => {
  const bundle = {
    ...minimalV1Bundle,
    schemaVersion: 2 as const,
    diskKvSnapshot: {
      sourceStateDbPath: "/tmp/state.vscdb",
      rows: [{ key: "composerData:abc", value: "{}", checksum: "a".repeat(64) }],
      rowCount: 1,
      toolBubbleCount: 0,
    },
  };
  expect(() => parseChatBundle(bundle, "test")).not.toThrow();
});
```

- [ ] **Step 2: Extend types and parser**

- `ChatBundle.schemaVersion: 1 | 2`
- Optional `diskKvSnapshot` on v2
- `parseChatBundle`: accept `schemaVersion === 2`; validate row checksums when strict mode used

- [ ] **Step 3: Run tests**

```bash
npm test -- tests/chat-bundle-format.test.ts
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat: accept ChatBundle schemaVersion 2 with diskKvSnapshot"
```

---

### Task 6: CLI inspect + transport docs

**Files:**
- Modify: `resources/transport-chat/scripts/cursor_chat_io.py` (`cmd_inspect`)
- Modify: `docs/chat-import-activate.md`
- Modify: `resources/transport-chat/reference.md`

- [ ] **Step 1: Extend `inspect` output**

Print when present:

```
diskKvSnapshot: 37 rows, 12 tool bubbles (source: .../globalStorage/state.vscdb)
```

- [ ] **Step 2: Update docs — four layers**

Add layer 4 to data model:

| Layer | Path | Required for tool/MCP UI |
|-------|------|--------------------------|
| 4. Composer bubbles | `globalStorage/state.vscdb` → `cursorDiskKV` | **Yes** |

Document v2 bundle field and fallback behavior.

- [ ] **Step 3: Commit**

```bash
git commit -m "docs: document diskKvSnapshot layer for transport tool fidelity"
```

---

### Task 7: End-to-end manual acceptance (future runs)

**Files:** none (checklist only)

- [ ] **Step 1: Pick a bergamota chat that used tools in the UI**

Run in bergamota workspace after the chat has completed at least one tool call visible in Composer.

- [ ] **Step 2: Export and inspect**

```bash
python3 resources/transport-chat/scripts/cursor_chat_io.py export <UUID> -o /tmp/test-v2.json
python3 resources/transport-chat/scripts/cursor_chat_io.py inspect /tmp/test-v2.json
```

Expect: `schemaVersion: 2`, `diskKvSnapshot` with `toolBubbleCount >= 1`.

- [ ] **Step 3: Transport to cursor-sync**

```bash
python3 resources/transport-chat/scripts/transport_chat.py run \
  --source /home/marcelo/dev/private/bergamota \
  --destination /home/marcelo/dev/private/cursor-sync \
  --conversation-id <UUID> \
  --allow-cursor-running \
  --bridge-wait-result 30
```

- [ ] **Step 4: Verify + UI check**

```bash
python3 resources/transport-chat/scripts/cursor_chat_io.py verify \
  --conversation-id <UUID> \
  --workspace-folder /home/marcelo/dev/private/cursor-sync \
  --post-activate
```

Reload Window; open chat; confirm tool/MCP cards render.

---

## Out of scope (follow-up plan)

| Item | Reason |
|------|--------|
| Re-repair already-transported chats | User excluded past runs |
| JSONL `tool_use` → synthetic `toolFormerData` mapping | High complexity; only needed when source never wrote KV (chat never opened in UI) |
| Exporting encrypted native `store.db` protobuf internals | Already byte-copied when file exists; decryption not needed for UI |
| Phase B payload changes | UI reads disk state; `createComposer` metadata sufficient |

If Phase 7 shows chats exported before bubbles exist on source (warning: no KV rows), a **separate plan** can add JSONL→bubble synthesis as a degraded fallback.

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Cursor changes bubble JSON schema | Version gate; fixture tests; inspect warns on `toolBubbleCount` mismatch |
| Global DB locked while Cursor running | Keep `--allow-cursor-running` warning; recommend quit for Phase A |
| Large bundles (many bubbles) | Row count in inspect; optional `--no-global-state` unchanged |
| `workspaceIdentifier` stale after import | Always remap in `remap_disk_kv_snapshot_for_destination` |
| v1/v2 mixed Gist exports | Parser accepts both; v1 behavior unchanged |

---

## Self-review

| Spec requirement | Task |
|------------------|------|
| Export native tool/MCP UI layer | Task 2 |
| Import without text-only overwrite | Task 3 |
| Destination workspace remap | Task 3 |
| Backward compatible v1 bundles | Tasks 2–3 (schema gate) |
| Verify future runs | Task 4, 7 |
| TS/extension alignment | Task 5 |
| Documentation | Task 6 |

No TBD placeholders. Types consistent: `diskKvSnapshot.rows[].checksum` uses same `sha256_hex` as transcripts.

---

## Verification commands (full suite)

```bash
cd /home/marcelo/dev/private/cursor-sync
python3 -m pytest resources/transport-chat/tests/test_disk_kv_snapshot.py -v
npm test
WORKSPACE=/tmp/cursor-transport-test \
  resources/transport-chat/scripts/test_import_roundtrip.sh --no-activate
```

Expected: all green; new tests cover export/import/verify of `toolFormerData` bubbles.
