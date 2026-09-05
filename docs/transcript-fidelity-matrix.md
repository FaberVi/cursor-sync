# Transcript and chat backup fidelity matrix

Cross-machine chat continuity in Cursor Sync uses a **four-layer** model. This document maps each layer to symptoms on import and what to do on the source machine before sync.

## Layers

| Layer | On-disk location | Preserves |
|-------|------------------|-----------|
| 1 — Transcript | `~/.cursor/projects/<project>/agent-transcripts/<id>/**/*.jsonl` | Message text, subagent JSONL |
| 2 — Store | `~/.cursor/chats/<md5(workspace)>/<id>/store.db` | Runtime blobs / protobuf graph |
| 3 — Sidebar | `state.vscdb` ItemTable (`composer.composerHeaders`, `composer.composerData`) | Composer history metadata |
| 4 — Composer bubbles | Global `state.vscdb` → `cursorDiskKV` | Tool/MCP cards, `toolFormerData`, UI rendering |

## Backup tiers (extension UI)

| Tier | Meaning | Typical on-disk signal |
|------|---------|------------------------|
| **Full backup** | Best cross-machine fidelity | `store.db` + Layer 4 with tool bubbles |
| **Resumable** | Can continue in Composer with reasonable fidelity | `store.db` and/or Layer 4 rows |
| **Partial** | Store present but Layer 4 tool bubbles missing | `store.db`, `toolBubbleCount: 0` |
| **Archive only** | Transcript JSONL only | No `store.db`, no `cursorDiskKV` rows |

Sidebar **Chats** tab shows the tier badge per conversation after expanding a project group.

## Symptom → cause → action

| Symptom on destination | Likely cause | Action on source (machine A) |
|------------------------|--------------|------------------------------|
| Chat visible but Composer empty / Loading | Import without activation; missing `store.db` | Open chat in Composer; enable **Activate chat after import**; re-push |
| Plain text bubbles, no tool/MCP cards | Layer 4 text-only (schema v1 or no `diskKvSnapshot`) | Open chat in Composer; wait for save; push again |
| `toolBubbleCount: 0` at push | Chat never materialized bubbles in global DB | Use chat in Composer before export |
| `no store.db` in sidebar detail | Transcript-only chat (normal for many chats) | Open in Composer to create `store.db` if you need native resume |
| Chat not in sync gist | Below minimum tier with **Sync only resumable chats** | Disable filter or upgrade chat to resumable tier |
| Local chat not updated after pull | Pull updates disabled (default) | Enable **Update local chats from remote on pull** in Settings |
| Tool history lost for model | Archive-only backup | Accept transcript-only or re-export after full materialization |

## Push / pull settings

| Setting | Default | Effect |
|---------|---------|--------|
| `cursorSync.chats.syncOnlyFullBackups` | `false` | When `true`, skips transcript-only chats on push |
| `cursorSync.chats.pullUpdates` | `false` | When `true`, allows re-import of existing conversation IDs |
| `cursorSync.chats.pullUpdatePolicy` | `newerWins` | `remoteWins`, `newerWins`, `ask`, or `skip` |
| `cursorSync.chatImport.activateDefault` | `false` | Run Composer activation after disk restore |

## Verify after import

`chat-import-verify` checks Layer 4 when the bundle contained `diskKvSnapshot`:

- `layer4.composerData` — `cursorDiskKV` row `composerData:<id>`
- `layer4.bubbles` — at least one `bubbleId:<id>:*` row
- `layer4.toolBubbles` — count of bubbles with `toolFormerData`

## References

- Layer model: `resources/transport-chat/reference.md`
- Fidelity helpers: `src/chat-backup-eligibility.ts`, `src/chat-bundle-fidelity.ts`
- Import activation: `docs/chat-import-activate.md`
