# Cursor chat persistence — bootstrap reference (root discovery)

Read-only research for parallel workers. Do not modify `src/` unless explicitly tasked.

## Live paths (Linux)

| Layer | Path |
|-------|------|
| Per-chat store | `~/.cursor/chats/<workspaceKey>/<conversationId>/store.db` |
| Chats root | `~/.cursor/chats/` |
| Global VS Code state | `~/.config/Cursor/User/globalStorage/state.vscdb` |
| Per-workspace VS Code state | `~/.config/Cursor/User/workspaceStorage/<folderId>/state.vscdb` |
| Agent transcripts | `~/.cursor/projects/<project>/agent-transcripts/<conversationId>/*.jsonl` |

Hypothesis under test: **sidebar/composer state in state.vscdb** is the pointer layer; **store.db** holds message blobs; both must agree on `composerId` / `conversation_id` and `workspaceKey`.

## store.db schema (from repo prior art)

Source: `resources/golden-store-template.sql`, `src/store-template-hydrate.ts`

```sql
PRAGMA user_version = 1;
CREATE TABLE meta (key TEXT PRIMARY KEY, value BLOB NOT NULL);
CREATE TABLE blobs (id TEXT PRIMARY KEY, value BLOB NOT NULL);
```

- `meta` key `'0'`: JSON blob with `{ agentId, latestRootBlobId, name, mode, createdAt }`
- `blobs` id `'root'`: JSON array of message objects `[{ role, content: [{ type, text }] }]`
- BLOB values are **plaintext JSON cast to BLOB** in template hydration (not encrypted in extension code)
- `agentId` in meta aligns with `chat_id` / `composerId` / conversation folder name

Layout discovery: scan live `store.db` with `sqlite3` if available; compare `PRAGMA table_info`, `PRAGMA user_version`, sample `meta`/`blobs` keys.

## state.vscdb schema (VS Code SQLite)

Extension queries `ItemTable`:

| Key | Role |
|-----|------|
| `composer.composerHeaders` | Sidebar list: `{ allComposers: [{ composerId, name, subtitle, lastUpdatedAt, ... }] }` |
| `composer.composerData` | Heavier composer payload (merged additively on import) |

Values are **JSON strings** in ItemTable (plaintext in extension merge code). Also search ItemTable with `value LIKE '%<conversationId>%'` for related keys.

Global vs workspace targets (`src/chats-manifest.ts`, `src/sync-engine-ops.ts`):

- `stateTarget: "global"` → `globalStorage/state.vscdb`
- `stateTarget: "workspace"` → `workspaceStorage/<workspaceStorageFolderId>/state.vscdb`

Copy semantics: main + `-wal` + `-shm` triple; `PRAGMA wal_checkpoint(FULL)` before replace.

## workspaceKey vs workspaceStorage mapping

- **workspaceKey**: directory name under `~/.cursor/chats/` (NOT necessarily same string as workspaceStorage folder id)
- **workspaceStorageFolderId**: opaque hash folder under `User/workspaceStorage/` containing `workspace.json` + `state.vscdb`
- Extension validates import keys against existing `~/.cursor/chats/*` dirs (`src/chat-id-sync.ts`)
- Import prompts user to map source workspaceKey → local chats subdirectory (`deriveStoreWorkspaceMapping` in `src/transcripts.ts`)
- Join key across layers: **`composerId` === conversation UUID === `store.db` parent folder name === `meta.agentId`**

Investigate whether workspaceKey equals workspaceStorage hash, projects path hash, or independent — check `workspace.json` inside workspaceStorage folders and any Cursor docs.

## Backup / restore / overwrite (extension behavior)

Key modules:

- `src/chat-persistence.ts` — local JSON bundle (store snapshot base64, sidebar snapshot, transcript jsonl)
- `src/state-reconciliation.ts` — shadow copy → pending bundle → finalize replaces live files after Cursor quit
- `src/rollback.ts` — backups before overwrite
- `src/store-template-hydrate.ts` — golden template path when no store snapshot

Risks called out in code:

- Cursor file locks while running (state.vscdb, store.db)
- WAL/journal sidecars must be copied or checkpointed
- Schema/version drift (`GOLDEN_STORE_TEMPLATE_VERSION`, template regeneration)
- `composer.composerHeaders` entries need `type: "head"` or Cursor ignores them
- workspace_key mismatch → chats invisible in sidebar
- Full-file replace may work across Cursor versions **if** ID schemes and table layouts stay compatible

## Repo files to mine

| File | Focus |
|------|-------|
| `src/chat-persistence.ts` | Save/load bundle format |
| `src/transcripts.ts` | SQLite helpers, findStoreDb, sidebar merge, state DB candidates |
| `src/state-reconciliation.ts` | Pending bundle, shadow replace |
| `src/sync-engine-ops.ts` | resolveLiveStateDbPath, mergeComposerHeadersIntoDb |
| `src/composer-merge.ts` | Header/data merge semantics |
| `src/chats-manifest.ts` | Manifest schema |
| `src/chat-id-sync.ts` | workspaceKey validation |
| `src/store-template-hydrate.ts` | store.db hydration |
| `resources/golden-store-template.sql` | Minimal store layout |
| `tests/chat-persistence.test.ts` | Bundle round-trip expectations |

## Worker output contract

Each explore worker writes **one markdown file** under `.orchestrate/cursor-chat-persistence/docs/`:

1. `explore-store-db.md`
2. `explore-state-vscdb.md`
3. `explore-workspace-mapping.md`
4. `explore-restore-risks.md`

Sections required per file: Schema, Join keys, Encrypted vs plaintext, Unknowns, Sources (file:line or path).

Merge task combines into `docs/cursor-chat-persistence.md` with safe sync/restore constraints.

## Constraints

- **Read-only research** — no edits to extension source
- Use `composer-2.5-fast`
- Web search allowed for Cursor internals not in repo
- If no live DBs on VM, rely on repo + fixtures + document gaps explicitly
