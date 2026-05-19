<!-- orchestrate handoff
task: explore-restore-risks
branch: orch/cursor-chat-persistence/explore-restore-risks
agentId: bc-3cb0c18e-8307-4335-b858-26965009e940
runId: run-9d8f78bf-5b78-4cd0-b7a6-6d6ce035b909
resultStatus: finished
finishedAt: 2026-05-19T19:24:37.067Z
-->

## Status
success

## Branch
`orch/cursor-chat-persistence/explore-restore-risks`

## What I did
- Added `.orchestrate/cursor-chat-persistence/docs/explore-restore-risks.md` (178 lines) from `bootstrap-reference.md`, `src/chat-persistence.ts`, `src/state-reconciliation.ts`, `src/rollback.ts`, `src/store-template-hydrate.ts`, `src/sync-engine-ops.ts`, `src/sync-engine.ts`, `tests/chat-persistence.test.ts`, and related README/composer-merge references.
- Sections: Backup surfaces, Overwrite mechanics, Version/schema drift, File locking and WAL, Safe restore procedure, Unsafe operations, Hypothesis verdict, Pending-state-bundle flow (with sequence diagram), Sources.
- Pushed to `origin/orch/cursor-chat-persistence/explore-restore-risks` (no PR per instructions).

## Measurements
- `LOC(.orchestrate/cursor-chat-persistence/docs/explore-restore-risks.md): 0 → 178`
- Acceptance: pending-state-bundle flow documented → yes
- Acceptance: safe vs unsafe restore constraints listed → yes
- Acceptance: cross-version hypothesis addressed → yes

## Verification
not-verified

## Notes, concerns, deviations, findings, thoughts, feedback
- **Pending bundle**: Documented `PendingStateBundleV1`, prepare (shadow copy + WAL checkpoint + composer merge + golden hydrate), finalize (backup live, strip `state.vscdb-wal`/`-shm`, replace with retries, rollback on failure). Aligns with `executeFinalizeStateReconciliation` and `SyncEngine.prepare`.
- **Rollback**: Extension keeps only 3 backup dirs under `globalStorage/backups/`; automatic rollback on failed writes/finalize only — no user-facing restore UI.
- **store.db WAL gap**: Finalize and chat-load paths replace the main `store.db` only; they do not remove or sync `store.db-wal`/`-shm`. Called out as unsafe for ad-hoc copies; state.vscdb is handled more carefully.
- **Hypothesis verdict**: Partially supported — byte-identical full-file restore can work if Cursor schema/IDs stay compatible; not guaranteed across upgrades (checksum ≠ schema validity; golden hydrate is best-effort).
- **Encryption**: Repo extension code treats `meta`/`blobs` and composer ItemTable values as plaintext JSON/BLOB in paths reviewed; no encryption layer documented in extension.
- Live Cursor DBs were not scanned on this VM; conclusions are code-derived plus bootstrap reference.

## Suggested follow-ups
- Merge with sibling explore docs (`explore-store-db.md`, `explore-state-vscdb.md`, `explore-workspace-mapping.md`) into `docs/cursor-chat-persistence.md`.
- Optional live validation: `PRAGMA user_version` / `table_info` on real `store.db` and sample `state.vscdb` after a Cursor upgrade.
- Planner may want a verifier grep for `pending-state-bundle`, `rollbackFromBackup`, and `goldenStoreTemplateVersion` in the merged doc.