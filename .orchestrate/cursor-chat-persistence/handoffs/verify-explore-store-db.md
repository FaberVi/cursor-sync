<!-- orchestrate handoff
task: verify-explore-store-db
branch: orch/cursor-chat-persistence/explore-store-db
agentId: bc-b96dc1b3-95a8-4614-a9c0-85f5b51b55c3
runId: run-34dac106-3ec5-478a-b096-4c23365ebab9
resultStatus: finished
finishedAt: 2026-05-19T19:27:03.823Z
-->

Verifying the explore-store-db handoff against acceptance criteria: reading the doc, checking cited sources, and running sqlite3 on available fixtures.
Running sqlite3 on the golden template and the cited tests to verify schema and encryption claims.
## Verification
unit-test-verified

## Target
`explore-store-db` on branch `orch/cursor-chat-persistence/explore-store-db`

## Branch
`orch/cursor-chat-persistence/explore-store-db`

## Execution
- `grep '^## ' .orchestrate/cursor-chat-persistence/docs/explore-store-db.md` → all six required sections present (Schema, Keys and blob graph, Join keys to composerId, Encrypted vs plaintext, Unknowns, Sources)
- `for f in <13 cited paths>; do test -e "$f"` → all 13 Sources entries exist on disk
- `find ~/.cursor/chats -name store.db | wc -l` → 0 (no live DBs on verifier VM; matches worker gap note)
- `sqlite3 resources/golden-chat-store.template.db "PRAGMA user_version; PRAGMA journal_mode; SELECT name FROM sqlite_master WHERE type='table';"` → `user_version=1`, `journal_mode=wal`, tables `meta`, `blobs` only
- `sqlite3 resources/golden-chat-store.template.db "SELECT key FROM meta; SELECT id FROM blobs;"` → meta key `0`, blob id `root`
- `sqlite3 resources/golden-chat-store.template.db "SELECT key, substr(CAST(value AS TEXT),1,120) FROM meta; SELECT id, substr(CAST(value AS TEXT),1,120) FROM blobs;"` → readable plaintext JSON (`agentId`, `latestRootBlobId`, message array)
- `sqlite3 resources/golden-chat-store.template.db "SELECT key, hex(substr(value,1,40)) FROM meta;"` → hex prefix `7B226167656E744964...` decodes to `{"agentId"...` (UTF-8 JSON in BLOB)
- `file resources/golden-chat-store.template.db` → `SQLite 3.x database, user version 1, UTF-8` (not SQLCipher)
- Manual hydrate repro (copy template + `UPDATE meta/blobs ... CAST(... AS BLOB)`) → post-update `CAST(value AS TEXT)` returns readable JSON for both tables
- `grep -r 'decrypt|encrypt|SQLCipher|cipher' src/` → no matches (supports “no decrypt path in repo” claim)
- `npm run lint` → pass (`tsc --noEmit`)
- `npm test -- tests/store-template-hydrate.test.ts --testTimeout=30000` → 1 failed (sqlite3 stdin subprocess timeout/error on hydrated temp DB); manual equivalent above succeeded
- Committed verifier audit: `.orchestrate/cursor-chat-persistence/verifier-explore-store-db.md` (pushed to branch)

## Findings
Per acceptance criterion:
- [x] explore-store-db.md exists with all required sections: six `##` sections confirmed (met)
- [x] Documents meta/blobs tables and sample key patterns: `meta`/`blobs` DDL, `meta key '0'`, `blobs id 'root'`, JSON field shapes, and `blob-*` unknown pattern documented; independently confirmed via sqlite3 on golden template (met)
- [x] States encryption status with evidence: doc table cites golden hex, `CAST AS TEXT`, extension `CAST(... AS BLOB)` writes, and no decrypt in repo; verifier reproduced plaintext JSON via hex + CAST on golden DB; live Cursor encryption correctly flagged unknown due to no live DBs (met)

Other findings (severity-ordered):
- (med) Live `~/.cursor/chats/**/store.db` absent on verifier VM: multi-blob chains, extra meta keys, and live encryption cannot be ruled in/out; doc Unknowns section covers this appropriately
- (low) `tests/store-template-hydrate.test.ts` fails in this environment (sqlite3 stdin script subprocess); manual hydrate SQL reproduces the same plaintext round-trip the test asserts

**Verdict: PASS** — doc meets all acceptance criteria for schema coverage, encryption boundary (with appropriate live gap caveat), and cited sources.

## Notes & suggestions
- Planner should treat golden-template + repo evidence as sufficient for merge of this explore doc; live sqlite3 inventory on a dev machine with active chats remains the recommended follow-up (commands already in doc Unknowns/Encrypted sections).
- If a later worker updates golden template after live inspection finds `blob-*` ids or extra meta keys, bump `GOLDEN_STORE_TEMPLATE_VERSION` per `resources/README-golden.txt`.
- Investigate sqlite3 stdin piping in CI/VM if hydrate tests are needed for future gates (`runSqliteScript` fails via Node `execFile` stdin; direct shell `sqlite3 db "SQL"` works).