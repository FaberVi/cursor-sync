<!-- orchestrate handoff
task: explore-store-db
branch: orch/cursor-chat-persistence/explore-store-db
agentId: bc-ee3dc983-98a3-4904-8a5d-baf66aa8a7ed
runId: run-b6d4da59-ba22-41fd-9e77-88ec716b56f5
resultStatus: finished
finishedAt: 2026-05-19T19:24:03.024Z
-->

## Status
success

## Branch
`orch/cursor-chat-persistence/explore-store-db`

## What I did
- Wrote `.orchestrate/cursor-chat-persistence/docs/explore-store-db.md` with required sections: Schema, Keys and blob graph, Join keys to composerId, Encrypted vs plaintext, Unknowns, Sources.
- Reverse-engineered layout from `resources/golden-store-template.sql`, `resources/golden-chat-store.template.db` (sqlite3), and extension code (`store-template-hydrate.ts`, `transcripts.ts`, `chat-persistence.ts`, `chat-id-sync.ts`, sync/state-reconciliation paths).
- Confirmed no live `~/.cursor/chats/**/store.db` on this VM; documented that gap and listed verifier sqlite3 commands for a machine with real chats.

## Measurements
- `explore-store-db.md` exists with required sections: 0 → 1 (all six sections present)
- `meta`/`blobs` tables documented with sample keys (`0`, `root`): not documented → documented
- Encryption boundary stated with evidence (plaintext JSON in BLOB; no live counterexample): not stated → stated with golden hex + CAST-as-TEXT tests

## Verification
not-verified

(No live Cursor `store.db` on worker VM; conclusions are from golden template + repo behavior. Verifier should run sqlite3 on a host with `~/.cursor/chats/**/store.db`.)

## Notes, concerns, deviations, findings, thoughts, feedback
- **Schema:** Only `meta` and `blobs` tables; `PRAGMA user_version = 1`; WAL journal mode in template.
- **`meta` key `'0'`:** JSON `{ agentId, latestRootBlobId, name, mode, createdAt }`; `agentId` matches parent folder / `composerId`.
- **`blobs` id `root`:** JSON array of `{ role, content: [{ type, text }] }` in extension model; fixture `store-snapshot.json` shows a richer multi-blob conceptual model not matching on-disk golden layout.
- **Encryption:** Extension reads/writes plaintext JSON cast to BLOB; no decrypt path in repo. Live Cursor encryption not ruled in/out without live DBs.
- **Restore:** Extension does whole-file `store.db` replace; does not remove `store.db-wal`/`shm` on finalize (unlike `state.vscdb`).
- **Path naming:** Code uses `<conversationId>`; bootstrap sometimes says `agentFolder` — same directory level.

## Suggested follow-ups
- Run live sqlite3 inventory on a dev machine: `SELECT key FROM meta; SELECT id FROM blobs; PRAGMA user_version;` across multiple conversations.
- Compare live blob JSON to extension-hydrated shape (tool/reasoning parts).
- Document `store.db-wal` behavior after finalize replace (restore-risks worker).
- If live DBs show extra `meta` keys or `blob-*` ids, update golden template version or extension hydrate logic.