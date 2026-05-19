<!-- orchestrate handoff
task: merge-persistence-doc
branch: orch/cursor-chat-persistence/persistence-doc
agentId: bc-f6941c1a-2d58-49fb-9940-025834421b4a
runId: run-5d888da9-1cbb-477b-b28e-f847d8182cfe
resultStatus: finished
finishedAt: 2026-05-19T19:28:56.634Z
-->

## Status
success

## Branch
`orch/cursor-chat-persistence/persistence-doc`

## What I did
- Merged dependency branches in order: `explore-store-db`, `explore-state-vscdb`, `explore-workspace-mapping`, `explore-restore-risks`.
- Wrote self-contained `docs/cursor-chat-persistence.md` (architecture, `store.db` schema, `state.vscdb` keys, workspace mapping, join keys + mermaid diagrams, encrypted vs plaintext table, actionable safe/unsafe restore constraints, pending-state-bundle flow, open unknowns, live verification commands, repo sources).
- Added `.orchestrate/cursor-chat-persistence/docs/merge-notes.md` documenting dedup decisions and verifier inputs.
- Pushed `orch/cursor-chat-persistence/persistence-doc` only (no PR per instructions).

## Measurements
- `LOC(docs/cursor-chat-persistence.md): 0 → 458`
- `LOC(.orchestrate/cursor-chat-persistence/docs/merge-notes.md): 0 → 45`
- Four explore topic areas in master doc: 0 → 4 (store.db, state.vscdb, workspace mapping, restore constraints)
- Required master sections (schemas, join keys, encryption table, restore constraints): 0 → present

## Verification
not-verified

(Document merge only; no live Cursor DBs on VM. Upstream verifiers passed explore slices against golden template and repo source. Planner can grep `docs/cursor-chat-persistence.md` for `composer.composerHeaders`, `pending-state-bundle`, `goldenStoreTemplateVersion`, and `workspaceKey`.)

## Notes, concerns, deviations, findings, thoughts, feedback
- Live `~/.cursor/chats` and `state.vscdb` absent on worker/verifier VMs; master doc states this and includes sqlite3 commands for hosts with real installs.
- Duplication reduced: one architecture mermaid, one pending-bundle sequence, unified encryption and unknowns sections; slice docs remain under `.orchestrate/cursor-chat-persistence/docs/explore-*.md`.
- Called out operational risks from verifiers: `deriveStoreWorkspaceMapping` → project `folderName` vs real `workspaceKey`; save (workspace-first) vs import (global-first) `state.vscdb` candidate order; `store.db` WAL not stripped on finalize.
- No PR opened; planner owns integration.

## Suggested follow-ups
- Run master doc [Live verification commands](docs/cursor-chat-persistence.md#live-verification-commands) on a Cursor-installed dev machine and append measured key inventories.
- Planner verifier: confirm `docs/cursor-chat-persistence.md` sections for schemas, join keys, encryption table, and safe restore constraints.
- Optional code follow-up: align `resolveStateDbCandidates` vs `resolveImportMergeStateDbCandidates` order or document operator policy in extension UI.