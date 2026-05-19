# Verifier audit: explore-store-db

Target: `.orchestrate/cursor-chat-persistence/docs/explore-store-db.md` on branch `orch/cursor-chat-persistence/explore-store-db`.

## Section checklist

All six required sections present: Schema, Keys and blob graph, Join keys to composerId, Encrypted vs plaintext, Unknowns, Sources.

## sqlite3 reproduction (2026-05-19)

Golden template `resources/golden-chat-store.template.db`:

```
PRAGMA user_version → 1
PRAGMA journal_mode → wal
Tables → meta, blobs (2 total)
meta keys → 0
blobs ids → root
meta value (CAST AS TEXT) → {"agentId":"00000000-0000-4000-8000-000000000001","latestRootBlobId":"root",...}
blobs root (CAST AS TEXT) → [{"role":"user","content":[{"type":"text","text":"__PLACEHOLDER__"}]}]
meta hex prefix → 7B226167656E744964223A... (UTF-8 JSON)
file(1) → SQLite 3.x database, user version 1, UTF-8
```

Manual hydrate SQL (same pattern as `store-template-hydrate.ts`) on copied template: UPDATE meta/blobs with CAST AS BLOB succeeded; post-update CAST(value AS TEXT) returned readable JSON.

## Live gap

`find ~/.cursor/chats -name store.db` → 0 files on verifier VM.

## Sources cited

All 13 paths listed in doc Sources section exist on disk.

## Repo encryption scan

`grep -r decrypt|encrypt|SQLCipher|cipher src/` → no matches.

## Tests

`npm test -- tests/store-template-hydrate.test.ts` → failed (sqlite3 subprocess on hydrated temp DB; manual equivalent succeeded). Not blocking doc acceptance.
