<!-- orchestrate handoff
task: verify-merge-persistence-doc
branch: `orch/cursor-chat-persistence/persistence-doc` (no verifier commits; working tree clean)
agentId: bc-b0e7bb8d-e00d-458a-a172-ac98a3b6bc81
runId: run-6f01c328-2a3e-4f9e-9924-1145fbae99e4
resultStatus: finished
finishedAt: 2026-05-19T19:30:50.762Z
-->

## Verification
unit-test-verified

## Target
`merge-persistence-doc` on branch `orch/cursor-chat-persistence/persistence-doc`

## Branch
`orch/cursor-chat-persistence/persistence-doc` (no verifier commits; working tree clean)

## Execution
- `test -f /workspace/docs/cursor-chat-persistence.md && wc -l` → file exists, **458 lines**
- Python required-section checker (architecture, `store.db` schema, `state.vscdb` keys, workspace mapping, join keys, encrypted vs plaintext table, safe restore with Do/Do-not tables, open unknowns, mermaid, DDL snippets) → **ALL_REQUIRED_SECTIONS_PRESENT**, **3** mermaid blocks
- `grep -E '^## '` on master doc → 12 top-level sections including all four explore topic areas plus join keys, encryption, restore, unknowns, live commands, repo sources
- `grep` for planner spot-checks (`composer.composerHeaders`, `pending-state-bundle`, `goldenStoreTemplateVersion`, `workspaceKey`) → all present (multiple occurrences each)
- Python keyword coverage vs four explore slices (`store-db`, `state-vscdb`, `workspace-mapping`, `restore-risks`) → **OK** for all slices
- `sqlite3 /workspace/resources/golden-chat-store.template.db "PRAGMA user_version; …"` → `user_version=1`, `journal_mode=wal`, tables `meta`/`blobs`, meta key `0`, blob id `root` (matches doc schema claims)
- `Read` + `grep` `src/transcripts.ts` `resolveStateDbCandidates` / `resolveImportMergeStateDbCandidates` → workspace-first save vs global-first import (matches doc)
- `grep` `src/state-reconciliation.ts` finalize → removes `state.vscdb-wal`/`-shm` only; `replaceFileWithRetries` for `store.db` without WAL cleanup (matches doc risk callout)
- `npm ci && npm test -- tests/chat-persistence.test.ts` → **5/5 passed** (corroborates golden-template / persistence claims cited in doc; does not test markdown)
- Live paths `~/.cursor/chats`, `~/.config/Cursor/.../state.vscdb` → **not present on VM** (doc states this; live verification commands not runnable here)

## Findings
Per acceptance criterion:
- [x] **docs/cursor-chat-persistence.md exists and is self-contained**: 458-line doc with architecture, paths, schemas, constraints, unknowns, live commands, and repo source index; optional pointer to slice docs only at end (met)
- [x] **All four topic areas integrated without duplication**: dedicated sections for `store.db` schema, `state.vscdb` keys, workspace mapping, and safe sync/restore; merge-notes document dedup; three distinct mermaid diagrams (architecture, blob graph, pending bundle) (met)
- [x] **Safe sync/restore constraints section is actionable**: numbered “Before you restore” checklist, Safe/Unsafe operation tables, cross-version verdict, pending-state-bundle sequence with field list (met)

Verifier-specific:
- [x] **Verdict pass**; **no missing required sections** (schemas, join keys + mapping table, encryption table, restore constraints, open unknowns all present)

Other findings (severity-ordered):
- (low) **Live Cursor DB inventories unverified on this VM** — expected; doc flags gap and supplies `sqlite3` commands for hosts with Agent history
- (low) **`composer.composerData` canonical shape** remains explicitly unknown (documented in Open unknowns #6)

## Notes & suggestions
- Primary verification for this target was **static doc audit + golden DB + source cross-check**; unit tests are ancillary alignment, not a markdown test harness.
- Suggested planner follow-up: run [Live verification commands](docs/cursor-chat-persistence.md#live-verification-commands) on a dev machine with real `~/.cursor/chats` and append measured key inventories if the orchestration wants live closure on open unknowns.