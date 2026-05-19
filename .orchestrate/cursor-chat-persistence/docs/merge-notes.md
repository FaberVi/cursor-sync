# Merge notes: `docs/cursor-chat-persistence.md`

Merged 2026-05-19 on branch `orch/cursor-chat-persistence/persistence-doc`.

## Source branches (merged in order)

1. `orch/cursor-chat-persistence/explore-store-db`
2. `orch/cursor-chat-persistence/explore-state-vscdb`
3. `orch/cursor-chat-persistence/explore-workspace-mapping`
4. `orch/cursor-chat-persistence/explore-restore-risks`

## Dedup decisions

| Topic | Primary section in master doc | Omitted duplication |
|-------|------------------------------|---------------------|
| `store.db` DDL / meta / blobs | [store.db schema](#storedb-schema) | Full blob-graph prose kept once; fixture `blob-*` noted briefly |
| `state.vscdb` ItemTable / merge | [state.vscdb keys](#statevscdb-keys) | Long community key lists shortened to table |
| Workspace identifiers | [Workspace mapping](#workspace-mapping) + [Join keys](#join-keys) | Single mermaid (architecture) + join table; removed second full mermaid from mapping doc |
| Restore / WAL / pending bundle | [Safe sync and restore](#safe-sync-and-restore-constraints) | One pending sequence diagram |
| Encryption | [Encrypted vs plaintext](#encrypted-vs-plaintext) | Unified table; per-layer tables merged |
| Unknowns | [Open unknowns](#open-unknowns) | Consolidated numbered list |

## Verifier inputs incorporated

- **store-db:** Golden sqlite3 repro (`user_version=1`, WAL, plaintext JSON in BLOB); live gap noted.
- **state-vscdb:** Merge semantics match `composer-merge.ts`; candidate-order mismatch called out in safe constraints.
- **workspace-mapping:** `folderName` vs `workspaceKey` risk; lexicographic scan ambiguity.
- **restore-risks:** `store.db` WAL gap vs state triple; hypothesis verdict in safe section.

## Acceptance mapping

| Criterion | Master doc section |
|-----------|-------------------|
| Self-contained reference | Full doc |
| Four topic areas integrated | Architecture, store.db, state.vscdb, workspace mapping, restore |
| Actionable restore constraints | Safe sync and restore constraints (Do / Do not tables + procedure) |
| Schemas | store.db + state.vscdb sections |
| Join keys | Join keys + architecture mermaid |
| Encryption table | Encrypted vs plaintext |
| Open unknowns | Open unknowns |

## Not merged into master (by design)

- Verifier audit files (`verifier-explore-store-db.md`, etc.) — remain on explore branches.
- `verify-workspace-mapping-doc.mjs` — operational script, not end-user doc.
