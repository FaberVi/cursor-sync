<!-- orchestrate handoff
task: explore-state-vscdb
branch: orch/cursor-chat-persistence/explore-state-vscdb
agentId: bc-e8b91c93-a032-4268-b0bb-954bd965fcef
runId: run-0787c877-7265-4535-b9fa-d50c60172796
resultStatus: finished
finishedAt: 2026-05-19T19:24:11.269Z
-->

## Status
success

## Branch
`orch/cursor-chat-persistence/explore-state-vscdb`

## What I did
- Added `.orchestrate/cursor-chat-persistence/docs/explore-state-vscdb.md` covering `state.vscdb` schema (`ItemTable`, `cursorDiskKV`), `composer.composerHeaders` / `composer.composerData` shapes, header/data merge semantics, global vs workspace `stateTarget`, WAL triple copy/checkpoint/finalize behavior, join keys, plaintext vs encrypted boundaries, unknowns, and sources.
- Synthesized from `bootstrap-reference.md`, `src/transcripts.ts`, `src/sync-engine-ops.ts`, `src/composer-merge.ts`, `src/chats-manifest.ts`, related modules, tests/fixtures, and external Cursor v0.50.5 storage docs (no live DB on this VM).

## Measurements
(none)

## Verification
not-verified

## Notes, concerns, deviations, findings, thoughts, feedback
- No `~/.config/Cursor` or `state.vscdb` on the worker VM; live schema/key inventory should be re-run on a Cursor-installed host with the sqlite3 commands in the doc’s Sources section.
- Extension only **writes** `ItemTable` keys `composer.composerHeaders` and `composer.composerData`; it **reads** `cursorDiskKV` for export evidence only. Full message history may still live in global `cursorDiskKV` (`bubbleId:*`, `composerData:{id}`) and/or `store.db` — restoring sidebar pointers alone may not revive full threads.
- **Candidate DB order mismatch:** `resolveStateDbCandidates` prefers workspace-first (chat bundle save); `resolveImportMergeStateDbCandidates` prefers global-first (import). Manifest `stateTarget` is explicit for reconciliation/sync but not for ad-hoc save/load.
- `composer.composerData` has two documented shapes (UUID-keyed map vs `allComposers` array); merge/filter code supports both; canonical Cursor write shape is unknown without live DB.
- State reconciliation / sync engine merge **headers only** on shadow unless `metadata_overrides.state_vscdb_sql` is used; `composerData` merge is used in transcript import and chat bundle load paths.
- Third-party docs may lag Cursor versions; repo behavior is the source of truth for extension-safe restore constraints.

## Suggested follow-ups
- Run live `sqlite3` inventory on global + one workspace `state.vscdb` and append sample key lists / value lengths to this doc or the merged master doc.
- Align save vs import `state.vscdb` candidate order or document operator guidance when both global and workspace DBs exist.
- Explore worker for `store.db` and workspace-mapping should be cross-linked in the planner merge for end-to-end restore constraints (`cursorDiskKV` + `store.db` + headers).