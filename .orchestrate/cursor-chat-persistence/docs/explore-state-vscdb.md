# Explore: `state.vscdb` composer / sidebar persistence

Research for cursor-chat-persistence. Describes VS Code / Cursor SQLite state databases that hold the **sidebar pointer layer** (composer list and metadata), distinct from message bodies in `~/.cursor/chats/.../store.db`.

**Live inspection on this worker VM:** No `~/.config/Cursor` tree or `state.vscdb` files present. Findings below are from extension source, bootstrap reference, tests/fixtures, and third-party Cursor storage docs (v0.50.5 era).

---

## Schema

### File locations

| Target | Path (Linux) |
|--------|----------------|
| Global | `~/.config/Cursor/User/globalStorage/state.vscdb` |
| Per-workspace | `~/.config/Cursor/User/workspaceStorage/<workspaceStorageFolderId>/state.vscdb` |
| Nightly | Same under `Cursor Nightly` instead of `Cursor` |
| macOS | `~/Library/Application Support/Cursor/User/...` |
| Windows | `%APPDATA%/Cursor/User/...` |

Sidecar files (WAL mode): `state.vscdb-wal`, `state.vscdb-shm` beside the main DB.

### SQLite layout (VS Code baseline + Cursor extensions)

**`ItemTable`** — primary key-value store used by the extension for composer sidebar state:

```sql
CREATE TABLE ItemTable (
  key TEXT PRIMARY KEY,
  value TEXT   -- typically a JSON document as UTF-8 text
);
```

**`cursorDiskKV`** — Cursor-specific KV table (queried during export evidence gathering; not written by this extension):

```sql
-- Observed in community reverse-engineering of global state.vscdb
-- key TEXT, value TEXT (large JSON blobs)
```

Community docs (Cursor ~0.50.5) describe **global** `cursorDiskKV` keys such as:

| Key pattern | Role |
|-------------|------|
| `composerData:{composerId}` | Full composer session: `fullConversationHeadersOnly[]`, `codeBlockData`, `usageData`, etc. |
| `bubbleId:{composerId}:{bubbleId}` | Individual chat bubbles (user/assistant text, tokens) |
| `codeBlockDiff:{composerId}:{diffId}` | Diff payloads for inline edits |
| Other prefixes | `agentKv`, `checkpointId`, `messageRequestContext`, … |

**Relationship (external model):** `ItemTable` `composer.composerData` / headers list `composerId` values that join to `cursorDiskKV` `composerData:{id}` and `bubbleId:{id}:…` rows in **global** DB. Newer Cursor builds also use `~/.cursor/chats/.../store.db` as a separate content layer (see store-db explore doc).

### WAL / journal

- SQLite runs in **WAL mode** when Cursor is open; uncheckpointed pages live in `-wal` / `-shm`.
- Extension **shadow copy** copies all three files when present (`copyStateDbTriple`).
- Before applying shadow to live DB, finalize flow **deletes** live `-wal` and `-shm`, then replaces main file from shadow.
- Shadow prep runs `PRAGMA wal_checkpoint(FULL);` on the **shadow** copy (not necessarily on live while Cursor holds locks).

---

## Composer / sidebar keys

### Primary `ItemTable` keys (extension read/write)

| Key | Purpose |
|-----|---------|
| `composer.composerHeaders` | Sidebar thread list (lightweight “headers”) |
| `composer.composerData` | Heavier per-composer state blob (optional on import) |

All extension SQL targets these two keys only (plus diagnostic `LIKE` scans).

### `composer.composerHeaders` structure

Top-level JSON object:

```json
{
  "allComposers": [
    {
      "type": "head",
      "composerId": "<uuid>",
      "name": "<title>",
      "subtitle": "<string>",
      "lastUpdatedAt": 1731539400000,
      "lastOpenedAt": 1731539400000,
      "createdAt": 1731539400000,
      "hasUnreadMessages": false,
      "isArchived": false,
      "isDraft": false,
      "unifiedMode": "agent",
      "forceMode": "edit",
      "workspaceIdentifier": {
        "id": "<md5 of workspace fsPath>",
        "uri": { "$mid": 1, "fsPath": "...", "scheme": "file", ... }
      }
    }
  ]
}
```

**Field notes (from extension behavior):**

| Field | Requirement |
|-------|----------------|
| `type` | Must be `"head"` for Cursor to show the entry; extension backfills `type: "head"` when missing |
| `composerId` | UUID string; join key to `conversation_id` / `store.db` folder / `meta.agentId` |
| `lastUpdatedAt`, `lastOpenedAt`, `createdAt` | Extension prefers **epoch milliseconds as number** when synthesizing from sidebar snapshots; manifest/import paths may use **ISO strings** |
| `workspaceIdentifier` | Stamped on import from open workspace (`md5(fsPath)` + VS Code URI shape) when absent |

Typed subset in repo: `src/types/composer-state.ts` (`ComposerHeaderRow`, `ComposerHeadersPayload`) — does not include `type`, `workspaceIdentifier`, or numeric timestamps.

### `composer.composerData` structure

**Two shapes** appear in code and fixtures:

1. **Per-composer map (extension tests / sidebar sidecar):** top-level keys are UUIDs (or stable non-UUID keys preserved by filter):

```json
{
  "conversation-123": {
    "composerId": "conversation-123",
    "selected": true,
    "lastOpenedAt": "2026-03-30T12:00:00.000Z"
  },
  "stableMeta": { "version": 1 }
}
```

2. **Aggregate list (community / older Cursor docs):** `{ "allComposers": [ { "composerId", "lastUpdatedAt", ... } ] }` — `filterComposerDataPayload` keeps matching `allComposers` entries by `composerId`.

Export filters `composerData` to rows whose key is in the conversation’s composer ID set (conversation UUID + transcript basename IDs).

### Conversation-linked discovery

`extractSidebarStateEvidence` (export) additionally runs:

```sql
SELECT key, value FROM ItemTable
  WHERE value LIKE '%<conversationId>%' LIMIT 10;

SELECT key, value FROM cursorDiskKV
  WHERE key LIKE '%<conversationId>%' OR value LIKE '%<conversationId>%' LIMIT 10;
```

Any matching keys are stored in sidebar metadata as `matchedItemTableRows` / `matchedCursorDiskRows` (values truncated for display via `coerceSqliteValue`, max 4000 chars + `...`).

### Sidecar JSON (not in `state.vscdb`)

Path: `~/.cursor/projects/<project>/agent-transcripts/<conversationId>/cursor-sidebar-metadata.json`

Schema fields include `composerHeaders`, `composerHeadersRestore`, `composerData`, `composerDataRestore`, `stateDbPath`, `matchedItemTableRows`, `extraction`, etc. (`buildSidebarMetadataSnapshot` in `src/transcripts.ts`). Import merges from this file into `state.vscdb` when payloads exist.

### Merge semantics

**Headers — `mergeComposerHeadersChain` / `mergeComposerHeadersAdditive`:**

- Parse existing `composer.composerHeaders` JSON (or start empty).
- For each imported payload, merge `allComposers` **by `composerId`**:
  - Existing + imported: shallow merge `{ ...existing, ...imported }` per id.
  - New id: insert row.
- After merge, ensure every row has `type: "head"` if missing.

**Data — `mergeComposerDataAdditive`:**

- Parse existing blob as JSON object.
- For each top-level key in imported payload:
  - If key absent in base → copy value.
  - If both values are arrays → merge array elements **by `composerId`** (same shallow merge rule as headers).
  - Otherwise leave base value unchanged (import does not overwrite scalar conflicts).

**SQL write pattern:** `BEGIN IMMEDIATE;` then `UPDATE ItemTable SET value = '...' WHERE key = '...';` and `INSERT ... WHERE NOT EXISTS` for upsert. String values are escaped with `escapeSqlLiteral` (single-quote doubling).

**Import DB selection order:** `resolveImportMergeStateDbCandidates` → `[global state paths..., workspace state paths...]`; first accessible DB wins unless `stateDbPath` in sidecar points to a valid file.

**Delayed write-back:** Optional second identical SQL merge 5s later (`DELAYED_WRITEBACK_MS`) to survive Cursor overwriting state shortly after import.

**State reconciliation / sync engine:** Only merges **headers** into shadow via `mergeComposerHeadersIntoDb` (not `composerData` unless supplied via `metadata_overrides.state_vscdb_sql`).

---

## Global vs workspace targets

### Manifest fields

| Schema | Field | Values |
|--------|-------|--------|
| `chats-manifest` v1 | `stateTarget` | `"global"` \| `"workspace"` |
| | `workspaceStorageFolderId` | Required when `stateTarget === "workspace"` — directory name under `User/workspaceStorage/` |
| `sync-manifest` v1 | `state_target` | same |
| | `workspace_storage_folder_id` | same |

`workspaceKey` / `workspace_key` in those manifests refers to **`~/.cursor/chats/<workspaceKey>/`**, not the workspaceStorage folder id.

### Resolution

```text
stateTarget === "global"
  → listGlobalStateVscdbPaths()[0]
     (Cursor, then Cursor Nightly)

stateTarget === "workspace"
  → workspaceStorage/<workspaceStorageFolderId>/state.vscdb
```

`resolveLiveStateDbPath` (`src/sync-engine-ops.ts`) implements the above for prepare/finalize and sync engine shadow copies.

### Candidate ordering elsewhere

| API | Order | Use |
|-----|-------|-----|
| `resolveStateDbCandidates` | workspace DBs first, then global | Save chat bundle sidebar read |
| `resolveImportMergeStateDbCandidates` | global first, then workspace | Sidebar import merge |

**Implication:** Ad-hoc save/load may read **workspace** state while manifest-driven import targets **global** unless the user sets `stateTarget` consistently. Operators should pick one target and record `workspaceStorageFolderId` when using workspace scope.

### Global vs workspace content split (external)

Community analysis: **workspace** `state.vscdb` often holds `ItemTable` `composer.composerData` with `allComposers[]`; **global** `state.vscdb` holds large `cursorDiskKV` message/composer payloads. This extension does not replicate `cursorDiskKV` on import—only `ItemTable` composer keys.

---

## Join keys

| Layer | Identifier |
|-------|------------|
| Sidebar header row | `composerId` (UUID) |
| Chats manifest / sync | `chat_id` / `conversation_id` (UUID) |
| `store.db` folder | Parent directory name = conversation UUID |
| `store.db` meta | `agentId` aligned with composer id |
| Transcript paths | `agent-transcripts/<conversationId>/*.jsonl` |
| Workspace scope | `workspaceIdentifier.id` = MD5(workspace folder fsPath) on import |
| Workspace storage folder | Opaque hash under `workspaceStorage/` (separate from `~/.cursor/chats` workspace key) |

**Invariant (extension):** `composer.composerHeaders[].composerId` must equal `conversation_id` and the `store.db` path segment for chats to appear with correct content (`src/chat-id-sync.ts`).

---

## Encrypted vs plaintext

| Location | Format in extension |
|----------|---------------------|
| `ItemTable.value` for `composer.*` | **Plaintext JSON** stored as TEXT; read via `JSON.parse`, written via escaped SQL string literals |
| `cursorDiskKV` (read-only in export) | Treated as JSON text in evidence; extension does not decrypt |
| `store.db` blobs | Separate layer; template hydration uses plaintext JSON in BLOB columns (not `state.vscdb`) |

No encryption, compression, or `Buffer`/base64 handling for `composer.composerHeaders` / `composer.composerData` in merge code. If Cursor ever stores binary or encrypted values, current merge logic would fail or corrupt rows.

**Truncation boundary:** `coerceSqliteValue` (evidence / UI only) truncates strings >4000 chars; export restore uses `parseFullJsonValue` on dedicated `SELECT value FROM ItemTable WHERE key = 'composer...'` to avoid truncation.

---

## Unknowns

1. **Authoritative target for a given workspace** — Whether Cursor reads sidebar state from global, workspace, or both at runtime; extension uses configurable `stateTarget` but save vs import use different candidate orders.
2. **Full `composer.composerData` canonical schema** — Map-by-UUID vs `allComposers` array; which shape current Cursor versions write.
3. **`cursorDiskKV` vs `ItemTable` vs `store.db`** — Division of message history across Cursor versions; extension does not sync `cursorDiskKV` or `bubbleId:*` keys.
4. **Whether workspace `state.vscdb` contains `cursorDiskKV`** — Extension queries it if present; community docs emphasize global DB for `bubbleId` / `composerData:{id}`.
5. **Encryption at rest** — Not observed in extension; possible OS-level or future Cursor changes.
6. **Other `ItemTable` keys** — Only `composer.composerHeaders` / `composer.composerData` are merged; other keys referencing a conversation may remain stale after import.
7. **Timestamp type coercion** — Cursor may expect numbers vs ISO strings in headers; mixed usage in extension paths.
8. **Live schema version** — No `PRAGMA user_version` or migration handling in extension for `state.vscdb`.

---

## Sources

### Repo (primary)

| Path | Topics |
|------|--------|
| `.orchestrate/cursor-chat-persistence/bootstrap-reference.md` | Paths, ItemTable keys, WAL, stateTarget |
| `src/sync-engine-ops.ts` | `resolveLiveStateDbPath`, `copyStateDbTriple`, `runWalCheckpointFull`, `mergeComposerHeadersIntoDb` |
| `src/composer-merge.ts` | Header/data merge, `type: "head"`, `workspaceIdentifier` stamping helpers |
| `src/transcripts.ts` | Evidence queries, sidebar snapshot, import merge, `coerceSqliteValue`, candidate ordering |
| `src/chats-manifest.ts` | `stateTarget`, `workspaceStorageFolderId`, header payload builder |
| `src/sync-manifest.ts` | `state_target`, `metadata_overrides.state_vscdb_sql` |
| `src/state-reconciliation.ts` | Shadow copy, WAL delete on finalize, header-only shadow merge |
| `src/chat-persistence.ts` | Bundle save/load sidebar read/merge |
| `src/chat-id-sync.ts` | composerId / workspace_key invariant |
| `src/types/composer-state.ts` | Header row TypeScript shape |
| `tests/transcripts.test.ts` | `composerData` map merge behavior |
| `tests/fixtures/transcripts-bundle-v2/sidebar-snapshot.json` | Example sidecar payloads |

### External (secondary; version drift possible)

| Reference | Topics |
|-----------|--------|
| [cursor-efficiency `vscdbRelation.md`](https://github.com/pppp606/cursor-efficiency/blob/main/docs/vscdbRelation.md) | ItemTable vs cursorDiskKV, key prefixes, bubble graph |
| [vibe-replay: Cursor local storage](https://vibe-replay.com/blog/cursor-local-storage/) | Storage layout overview |
| VS Code `state.vscdb` / `ItemTable` | Standard extension global state pattern |

### Live paths (not inspected here)

- `~/.config/Cursor/User/globalStorage/state.vscdb`
- `~/.config/Cursor/User/workspaceStorage/*/state.vscdb`

Recommended verifier commands on a machine with Cursor installed:

```bash
sqlite3 ~/.config/Cursor/User/globalStorage/state.vscdb \
  ".tables"
sqlite3 ~/.config/Cursor/User/globalStorage/state.vscdb \
  "SELECT key, length(value) FROM ItemTable WHERE key LIKE 'composer.%';"
sqlite3 ~/.config/Cursor/User/globalStorage/state.vscdb \
  "SELECT key FROM cursorDiskKV LIMIT 20;"
```
