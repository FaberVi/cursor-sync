# Verifier: explore-state-vscdb

Date: 2026-05-19  
Target: `explore-state-vscdb` on `orch/cursor-chat-persistence/explore-state-vscdb`

## Commands

| Command | Outcome |
|---------|---------|
| `test -f ~/.config/Cursor/User/globalStorage/state.vscdb` | `LIVE_DB=no` (no Cursor install on VM) |
| `npm ci && npm test` | 92 passed, 2 failed (unrelated: `store-template-hydrate` timeout, workspace path match on Windows path) |
| `npx vitest run tests/transcripts.test.ts -t "sidebar state"` | 2 passed (`extractComposerDataPayload`, `mergeComposerDataAdditive`) |
| `npx vitest run tests/chats-manifest.test.ts tests/sync-manifest.test.ts` | 5 passed (`stateTarget` global/workspace validation) |
| `npx tsx -e` mergeComposerHeadersChain / mergeComposerDataAdditive | Headers shallow-merge by `composerId`; `type: "head"` backfill; `allComposers` array merge by id |
| `npm run build` | Build complete |

## Source cross-check (doc vs repo)

- `ItemTable` + `composer.composerHeaders` / `composer.composerData`: `src/transcripts.ts`, `src/sync-engine-ops.ts`, `bootstrap-reference.md`
- Candidate order: `resolveStateDbCandidates` workspace→global; `resolveImportMergeStateDbCandidates` global→workspace (`src/transcripts.ts:2303-2312`)
- `resolveLiveStateDbPath` + manifest `stateTarget`: `src/sync-engine-ops.ts`, `src/chats-manifest.ts`
- Plaintext JSON merge: `src/composer-merge.ts` (no decrypt path)
- Shadow WAL: `copyStateDbTriple`, `runWalCheckpointFull`; finalize deletes live `-wal`/`-shm` (`src/state-reconciliation.ts:279-281`)

## Verdict

**PASS** — doc meets acceptance criteria; live `sqlite3` inventory still recommended on a Cursor host.
