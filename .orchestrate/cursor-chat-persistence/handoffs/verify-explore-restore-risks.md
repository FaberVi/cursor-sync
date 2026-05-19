<!-- orchestrate handoff
task: verify-explore-restore-risks
branch: `orch/cursor-chat-persistence/explore-restore-risks` (no verifier commits)
agentId: bc-bc3fa62f-7622-40d4-941b-10109aa5fb8d
runId: run-f6953bbd-6db2-4fc9-95a3-16a7a6f0c6be
resultStatus: finished
finishedAt: 2026-05-19T19:26:08.220Z
-->

## Verification
unit-test-verified

## Target
`explore-restore-risks` on branch `orch/cursor-chat-persistence/explore-restore-risks`

## Branch
`orch/cursor-chat-persistence/explore-restore-risks` (no verifier commits)

## Execution
- `git branch --show-current` → `orch/cursor-chat-persistence/explore-restore-risks`
- Read `.orchestrate/cursor-chat-persistence/docs/explore-restore-risks.md` (178 lines) → all required sections present (`Backup surfaces`, `Overwrite mechanics`, `Version/schema drift`, `File locking and WAL`, `Safe restore procedure`, `Unsafe operations`, `Hypothesis verdict`, `Pending-state-bundle flow`, `Sources`)
- `rg` doc for `pending-state-bundle`, `PendingStateBundleV1`, `executeFinalizeStateReconciliation`, `rollbackFromBackup`, `goldenStoreTemplateVersion` → all referenced; dedicated **Pending-state-bundle flow** section with mermaid sequence + field list
- Cross-check `src/state-reconciliation.ts` (`executePrepareStateReconciliation`, `executeFinalizeStateReconciliation`, `PendingStateBundleV1`, WAL strip, `replaceFileWithRetries` 5×400ms backoff, finalize `rollbackFromBackup`) → matches doc
- Cross-check `src/rollback.ts` (`createBackup`, `rollbackFromBackup`, `MAX_BACKUPS = 3`, `pruneOldBackups`) → matches doc
- `npm ci` → success (356 packages)
- `npm test -- tests/chat-persistence.test.ts` → **5/5 passed** (1 file, 209ms)

## Findings
Per acceptance criterion:
- [x] **explore-restore-risks.md covers pending-state-bundle flow**: Lines 129–162 document prepare (shadow triple copy, WAL checkpoint, composer merge, golden hydrate), finalize (backup live, strip `state.vscdb-wal`/`-shm`, replace with retries, cleanup), `PendingStateBundleV1` fields, `notifyPendingStateBundleIfAny`; aligned with `state-reconciliation.ts` (met)
- [x] **Lists safe vs unsafe restore constraints**: **Safe constraints (summary)** table (lines 85–95) plus numbered safe procedure (74–83); **Unsafe operations** table (97–112) (met)
- [x] **Addresses cross-version compatibility hypothesis**: **Hypothesis verdict** (114–127) — partially supported with ID/schema/WAL/layer conditions; explicitly not a general guarantee; references `goldenStoreTemplateVersion` and checksum vs schema validity (met)

Verifier plan (state-reconciliation pending bundle + rollback):
- [x] Pending bundle prepare/finalize and `rollbackFromBackup` on finalize failure documented and confirmed in source (met)

**Verdict: PASS** — no blocking gaps for target acceptance criteria.

Other findings (severity-ordered):
- (low) **Live Cursor DB validation absent** — doc is code-derived; worker noted no on-VM scan of real `store.db` / `state.vscdb`. Acceptable for explore/read-only scope; merge docs may want optional `PRAGMA user_version` follow-up.
- (low) **Section order** — pending-bundle flow is after hypothesis verdict; content is complete, only navigation order differs from prepare→finalize chronology.

## Notes & suggestions
- Cited test file passes; tests cover bundle format/checksums, not the pending finalize path — doc accuracy for reconciliation rests on source cross-check (done), not test coverage of finalize.
- Suggested planner follow-up: merge with sibling explore docs; optional live schema probe after Cursor upgrade.
- No verifier artifacts committed (per user no-commit rule; verification evidence is commands above).