<!-- orchestrate handoff
task: verify-explore-state-vscdb
branch: orch/cursor-chat-persistence/explore-state-vscdb
agentId: bc-89ee529c-94ea-4c4c-8d9c-e42e4006ca08
runId: run-42a0ffde-9083-4906-b91c-aa1c9caa36c0
resultStatus: finished
finishedAt: 2026-05-19T19:26:01.480Z
-->

## Verification
unit-test-verified

## Target
`explore-state-vscdb` on branch `orch/cursor-chat-persistence/explore-state-vscdb`

## Branch
`orch/cursor-chat-persistence/explore-state-vscdb`

## Execution
- Read `.orchestrate/cursor-chat-persistence/docs/explore-state-vscdb.md` → all required sections present (Schema, Composer/sidebar keys, Global vs workspace, Join keys, Encrypted vs plaintext, Unknowns, Sources)
- Cross-checked doc claims against `src/composer-merge.ts`, `src/transcripts.ts` (2303–2313, 1855–1878, 1911–1933, 2736–2753), `src/sync-engine-ops.ts`, `src/chats-manifest.ts`, `src/state-reconciliation.ts` (279–281), `src/sync-engine.ts`, `.orchestrate/cursor-chat-persistence/bootstrap-reference.md` → structures, merge semantics, `stateTarget` resolution, WAL triple/checkpoint/finalize, plaintext boundary align with source
- `test -f ~/.config/Cursor/User/globalStorage/state.vscdb` → `LIVE_DB=no` (no `~/.config/Cursor` on VM; live sqlite inventory not run)
- `npm ci && npm test` → 92 passed, 2 failed (`store-template-hydrate` timeout; `findProjectMatchingOpenWorkspaceFolder` Windows path — unrelated to state.vscdb doc)
- `npx vitest run tests/transcripts.test.ts -t "sidebar state"` → 2/2 passed (`extractComposerDataPayload`, `mergeComposerDataAdditive` scalar-conflict behavior)
- `npx vitest run tests/chats-manifest.test.ts tests/sync-manifest.test.ts` → 5/5 passed (`stateTarget` global/workspace + `workspaceStorageFolderId` requirement)
- `npx tsx -e` executing `mergeComposerHeadersChain` / `mergeComposerDataAdditive` → headers shallow-merge by `composerId` with `type: "head"` backfill; `allComposers` array merge by `composerId`; existing map keys not overwritten on scalar/object conflict
- `npm run build` → success
- Committed verifier log: `.orchestrate/cursor-chat-persistence/verifier/explore-state-vscdb-verification.md` (pushed `d3c470c`)

## Findings
Per acceptance criterion:
- [x] **explore-state-vscdb.md documents ItemTable and primary composer keys**: met — `ItemTable` schema, `composer.composerHeaders` / `composer.composerData` JSON shapes, `cursorDiskKV` read-only patterns, evidence SQL (`transcripts.ts` grep + doc §Composer/sidebar keys)
- [x] **Explains global vs workspace stateTarget**: met — manifest fields, `resolveLiveStateDbPath`, candidate-order table (`resolveStateDbCandidates` vs `resolveImportMergeStateDbCandidates`), workspace vs chats `workspaceKey` distinction; confirmed in `chats-manifest.test.ts`
- [x] **Encryption/plaintext boundary documented**: met — `ItemTable` composer values plaintext JSON; `cursorDiskKV` read-only/no decrypt; `store.db` called out as separate layer; matches `composer-merge.ts` / `coerceSqliteValue` vs `parseFullJsonValue` usage
- [x] **Verifier: composerHeaders/composerData structure and merge semantics**: met — doc §Merge semantics matches `mergeComposerHeadersAdditive` / `mergeComposerDataAdditive`; executable tsx repro + passing `transcripts.test.ts` sidebar helpers

Other findings (severity-ordered):
- (low) **No live DB validation**: VM has no Cursor `state.vscdb`; doc’s recommended `sqlite3` commands were not executed — canonical `composer.composerData` shape (map vs `allComposers`) remains repo/community inference only
- (low) **Full suite noise**: 2 unrelated test failures in full `npm test`; targeted composer/manifest tests all pass

## Notes & suggestions
- **Verdict: PASS** for explore worker acceptance criteria; gap is operational (live key inventory), not doc omission.
- Planner should schedule live `sqlite3` inventory on a Cursor-installed host per doc Sources section before treating `cursorDiskKV` key inventory as complete.
- Candidate-order mismatch (save workspace-first vs import global-first) is documented; consider operator guidance or code alignment in a follow-up task.
- Cross-link merged master doc to `store.db` / workspace-mapping explores for end-to-end restore (headers alone insufficient per doc Unknowns #3).