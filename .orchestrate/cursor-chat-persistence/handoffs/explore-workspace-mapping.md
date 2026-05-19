<!-- orchestrate handoff
task: explore-workspace-mapping
branch: orch/cursor-chat-persistence/explore-workspace-mapping
agentId: bc-06e5dab6-b81d-44f4-bc63-3873ec5fab3e
runId: run-7c54b66f-7dac-4ce1-905a-159e437e065d
resultStatus: finished
finishedAt: 2026-05-19T19:24:19.204Z
-->

## Status
success

## Branch
`orch/cursor-chat-persistence/explore-workspace-mapping`

## What I did
- Added `.orchestrate/cursor-chat-persistence/docs/explore-workspace-mapping.md` with sections: Identifier types, Mapping algorithm, Join keys across layers, How Cursor creates keys, Import/sync implications, Unknowns, Sources.
- Mapped extension behavior from `chat-id-sync.ts`, `transcripts.ts` (`deriveStoreWorkspaceMapping`, `listChatsWorkspaceKeys`, `findStoreDbForConversation`), `sync-engine-ops.ts`, `chats-manifest.ts`, `sync-manifest.ts`, `state-reconciliation.ts`, and bootstrap-reference.
- Documented that `workspaceKey` and `workspaceStorageFolderId` are separate; `composerId` === `conversation_id` joins store.db, state.vscdb, and projects; `workspaceKey` is not proven to equal workspaceStorage id, project `folderName`, or `md5(fsPath)` (sidebar `workspaceIdentifier.id` uses md5 only inside JSON).
- Noted no live Cursor dirs on this VM; included a live correlation procedure for verifiers with a real install.

## Measurements
- `explore-workspace-mapping.md`: 0 → 194 lines
- Acceptance: workspaceKey vs workspaceStorageFolderId distinguished → yes (dedicated subsection + table)
- Acceptance: composerId/conversation_id join documented → yes (mermaid + table + chat-id-sync pointer)
- Acceptance: workspaceKey equals hash → documented as not established in-repo

## Verification
not-verified

(No live `~/.cursor/chats` or `workspaceStorage` on the VM; conclusions are repo-derived only. A verifier with Cursor installed should run the doc’s live correlation procedure.)

## Notes, concerns, deviations, findings, thoughts, feedback
- `deriveStoreWorkspaceMapping` resolves store restore to **target project `folderName`**, while UI text says chats hash is **not** the project folder name—import auto-map may write to a path Cursor never reads if keys differ; manual pick from existing `~/.cursor/chats/*` is safer.
- `findStoreDbForConversation` scans all workspace keys lexicographically; duplicate conversation IDs across keys would be ambiguous (first hit wins).
- Tests in `transcripts-export-import-fidelity.test.ts` encode the project-folderName-as-chats-key behavior for v2 import; treat as extension contract, not Cursor native naming.
- Pushed branch only; no PR per task instructions.

## Suggested follow-ups
- Run live `workspace.json` ↔ `workspaceKey` ↔ `projects/<folderName>` correlation on a machine with Agent chat history and append measured examples to the doc.
- Explore whether `workspaceKey` appears in `state.vscdb` or `cursorDiskKV` (worker 2 scope) to infer a deterministic join without guessing.
- Clarify whether `deriveStoreWorkspaceMapping` should prefer existing chats keys over project `folderName` when both exist.