<!-- orchestrate handoff
task: verify-explore-workspace-mapping
branch: orch/cursor-chat-persistence/explore-workspace-mapping
agentId: bc-9cca3874-de0a-4cad-b2d1-d42a49674b0d
runId: run-012f87aa-850e-4797-afaa-c4b6479004ff
resultStatus: finished
finishedAt: 2026-05-19T19:26:29.139Z
-->

## Verification
unit-test-verified

## Target
`explore-workspace-mapping` on branch `orch/cursor-chat-persistence/explore-workspace-mapping`

## Branch
`orch/cursor-chat-persistence/explore-workspace-mapping`

## Execution
- `npm ci` → dependencies installed (vitest available)
- `npm test -- tests/chat-id-sync.test.ts tests/transcripts-export-import-fidelity.test.ts tests/chats-manifest.test.ts` → 3 files, 17/17 passed
- `npx vitest run -t "imports v2 bundle with store"` → 1/1 passed; asserts store at `~/.cursor/chats/<targetProjectKey>/<conversationId>/store.db` (lines 735–746 in fidelity test)
- `npx tsx .orchestrate/cursor-chat-persistence/verify-workspace-mapping-doc.mjs` → exit 0; `listWorkspaceKeysUnderChatsRoot` lists dirs under `~/.cursor/chats/`; `validateWorkspaceKeysForImport` warn-only when chats root empty, strict fail when dirs exist but key missing
- Source cross-check: `chat-id-sync.ts` (chats root, validation, `composerId: entry.conversation_id`), `transcripts.ts` (`deriveStoreWorkspaceMapping` → `folderName`, `findStoreDbForConversation` lexicographic scan, placeholder “Chats workspace hash is not the Cursor project folder name”), `sync-engine-ops.ts` (`resolveLiveStateDbPath`), `chats-manifest.ts` / `sync-manifest.ts` (independent `workspaceKey` / `workspaceStorageFolderId` fields)
- `test -d ~/.cursor/chats` / `workspaceStorage` → both absent on VM (no live correlation)
- Doc section grep → required headings present (Identifier types, Mapping algorithm, Join keys, How Cursor creates keys, Import/sync implications, Unknowns, Sources)

## Findings
Per acceptance criterion:
- [x] `explore-workspace-mapping.md` distinguishes `workspaceKey` vs `workspaceStorageFolderId`: met — dedicated subsection + identifier table (doc L15–22); confirmed in `chats-manifest.ts` / `sync-manifest.ts` separate required fields
- [x] Documents `composerId` / `conversation_id` join across `store.db` and `state.vscdb`: met — mermaid + table (doc L102–148); `chat-id-sync.test.ts` asserts `composerId === conversation_id`; doc cites pointer/content coupling in `chat-id-sync.ts` header comment
- [x] Notes whether `workspaceKey` equals any hash: met — doc L28–30 states not established in-repo; `buildCurrentWorkspaceIdentifier` uses `md5(fsPath)` only for sidebar JSON, not chats path

Verifier plan (chats path layout + `chat-id-sync` validation):
- [x] Doc L9, L43–51, L148 describe `~/.cursor/chats/<workspaceKey>/<conversationId>/store.db` and validation/discovery functions; behavior matches `chat-id-sync.ts` L6–50

Other findings (severity-ordered):
- (low) No live `workspace.json` ↔ `workspaceKey` correlation on this VM; doc correctly labels procedure-only (L93–100, L179)
- (low) `validateWorkspaceKeysForImport` has no dedicated unit test in repo; covered by new verifier script only
- (low) Doc algorithm for `deriveStoreWorkspaceMapping` matches source; extension maps to project `folderName`, not disk-discovered `workspaceKey` — risk called out in doc L69, L167

**Verdict: pass** for scoped documentation acceptance criteria.

## Notes & suggestions
- Pushed verifier artifact `.orchestrate/cursor-chat-persistence/verify-workspace-mapping-doc.mjs` (commit `dd92799`).
- Planner follow-up: run doc’s live correlation procedure on a machine with Agent history; optionally add a unit test mirroring the verifier script for `validateWorkspaceKeysForImport`.
- `findStoreDbForConversation` first lexicographic hit on duplicate `conversation_id` across keys remains an operational ambiguity (doc L176–177).