# Chat export/import QuickPick human labels design

**Date:** 2026-05-21  
**Status:** Approved for implementation planning  
**Related:** [2026-05-21-chat-export-quickpick-design.md](./2026-05-21-chat-export-quickpick-design.md)  
**Scope:** Improve workspace and conversation QuickPick labels across export, import, and transcript flows via shared helpers.

## Summary

Workspace pickers currently show opaque md5 keys from `~/.cursor/chats/` because `humanWorkspaceLabel` only strips dashed hash suffixes, not bare 32-char hex keys. Conversation pickers show skills/system preamble text because titles come from the first transcript snippet via `summarizeTranscriptForSidebar`, which does not filter boilerplate or prefer composer sidebar names.

This spec adds shared resolution helpers: reverse-map chats workspace keys to real folder paths (tilde-shortened under `$HOME`), and resolve conversation titles from composer headers first, then meaningful user transcript text, then conversation id.

## Goals

- Workspace QuickPick **primary label** = resolved folder path (`~/…` when under home); fallback = `humanWorkspaceLabel(key)` with md5 key in **description**.
- Conversation QuickPick **primary label** = composer `name` when available; else first meaningful user message (skip skills/system preamble); else `conversationId`.
- **Shared helpers** used by export, import, and transcript pickers (scope B — not export-only).
- Add/update unit tests in `tests/chat-export-ux.test.ts`, `tests/chat-workspace-label.test.ts`, and transcript-bundle tests.

## Non-goals

- Changing `summarizeTranscriptForSidebar` behavior globally (sidebar previews, manifest subtitles, `buildChatBundle` title derivation stay as-is).
- Caching workspace/composer indexes across extension activations (build per picker flow).
- Resolving md5 keys for workspaces with no `workspaceStorage/workspace.json` entry (fallback only).

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Scope | B — shared helpers for export + import + transcript pickers |
| Workspace path display | Tilde-shortened when under `$HOME` (e.g. `~/dev/private/cursor-sync`) |
| Approach | A — extend existing modules; new targeted transcript helper (not global sidebar summarizer change) |
| `buildChatBundle` title | Unchanged (`summarizeTranscriptForSidebar`) |

## Architecture

### Module layout (approach A)

| Module | New / changed responsibility |
|--------|------------------------------|
| `src/chat-workspace-context.ts` | `buildChatsKeyToFolderMap(cursorUser)` — scan `workspaceStorage/*/workspace.json`, map `md5FolderKey(folderFsPath)` → `folderFsPath` |
| `src/chat-workspace-label.ts` | `formatDisplayPath`, `workspaceQuickPickLabel`, `projectQuickPickLabel`; consume folder map |
| `src/composer-merge.ts` | `getComposerDisplayName`, `loadComposerNameIndex(stateDbPath)` |
| `src/transcript-bundle.ts` | `isTranscriptBoilerplate`, `firstMeaningfulTranscriptTitle`, `resolveConversationDisplayTitle` |
| `src/chat-export-ux.ts` | Use shared workspace + conversation label APIs |
| `src/import-gist-transcripts.ts` | Use shared workspace (+ project mapping) label APIs |
| `src/chat-persistence.ts` | Use shared project mapping label APIs |
| `src/transcripts.ts` | `discoverExportConversationCandidates` uses `resolveConversationDisplayTitle` |

```text
┌──────────────────────────────────────────────────────────────┐
│  QuickPick flows (export / import / transcript export)        │
└────────────────────────────┬─────────────────────────────────┘
                             │
         ┌───────────────────┴───────────────────┐
         ▼                                       ▼
┌─────────────────────┐              ┌─────────────────────────┐
│ buildChatsKeyToFolderMap │          │ loadComposerNameIndex    │
│ formatDisplayPath        │          │ (one state.vscdb query)  │
│ workspaceQuickPickLabel  │          └───────────┬─────────────┘
└─────────────────────┘                          │
         │                                       ▼
         │                          ┌─────────────────────────────┐
         │                          │ resolveConversationDisplayTitle │
         │                          │ 1. composer name              │
         │                          │ 2. firstMeaningfulTranscript  │
         │                          │ 3. conversationId             │
         └──────────────────────────┴─────────────────────────────┘
```

## Workspace labels

### Index build

`buildChatsKeyToFolderMap(wsRoot: string): Promise<Map<string, string>>`

1. List `cursorUser/workspaceStorage/*/` (reuse `resolveSyncRoots().cursorUser`).
2. For each entry with readable `workspace.json`:
   - Parse `folder` URI → `folderFsPath` via existing `folderPathFromWorkspaceUri` + `path.resolve`.
   - `chatsKey = md5FolderKey(folderFsPath)`.
   - `map.set(chatsKey, folderFsPath)`.
3. Ignore malformed/missing `workspace.json`; no throw.

Call once at the start of each multi-step picker flow; pass the map into label helpers.

### Display path

`formatDisplayPath(folderFsPath: string, homeDir?: string): string`

- If `folderFsPath` is under `homeDir` (default `os.homedir()`), replace prefix with `~/` + remainder.
- Else return absolute path unchanged.
- Use `path` normalization so trailing slashes do not break prefix match.

### QuickPick row helpers

`workspaceQuickPickLabel(chatsKey: string, map: Map<string, string>): { label: string; description: string }`

- **Resolved:** `label = formatDisplayPath(map.get(chatsKey))`, `description = chatsKey`.
- **Fallback:** `label = humanWorkspaceLabel(chatsKey)`, `description = chatsKey` (same as today for picker value wiring).

`projectQuickPickLabel(projectFolderName: string, map: Map<string, string>): string`

For `~/.cursor/projects/<encoded-name>/` rows in import project-mapping pickers:

1. Find `folderFsPath` in map values where basename or existing `humanLabel` heuristics match the encoded project dir (same spirit as `findProjectMatchingOpenWorkspaceFolder`: basename match, optional loose match).
2. If match: `formatDisplayPath(folderFsPath)`.
3. Else: `humanWorkspaceLabel(projectFolderName)` (current behavior).

QuickPick wiring unchanged: `description` remains the folder key / project dir name used as the pick value; `detail` remains full filesystem path.

### Call sites

| File | Function | Change |
|------|----------|--------|
| `chat-export-ux.ts` | `pickChatsForExport` workspace step | `workspaceQuickPickLabel` |
| `import-gist-transcripts.ts` | `promptForTargetWorkspace` | `workspaceQuickPickLabel` |
| `import-gist-transcripts.ts` | `promptForProjectMapping` | `projectQuickPickLabel` for local project rows |
| `chat-persistence.ts` | project mapping loop | `projectQuickPickLabel` for local project rows |

## Conversation labels

### Composer name index

`loadComposerNameIndex(): Promise<Map<string, string>>`

1. Resolve first readable path from `resolveStateDbCandidates()` (`__chatPersistenceInternals`).
2. Query: `SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1`.
3. Parse JSON; for each entry in `allComposers`, if `composerId` and non-empty `name` string → `map.set(composerId, name.trim())`.
4. On failure (missing DB, lock, parse error): return empty `Map` (no user-facing error).

Use `getComposerId` from `composer-merge.ts` for id extraction.

`getComposerDisplayName(index: Map<string, string>, conversationId: string): string | undefined`

### Transcript title helpers (picker-only)

`isTranscriptBoilerplate(text: string): boolean`

Normalized single-line text is boilerplate when any of:

- Starts with (case-sensitive prefix list, extend as needed):
  - `The user has manually attached the following skills`
  - `<manually_attached_skills>`
  - `<EXTREMELY_IMPORTANT>`
  - `You have superpowers`
  - `Below is the full content of your`
- After `normalizePreviewLine`, length is 0.
- Line is predominantly angle-bracket tags (e.g. >50% of non-space chars are inside `<…>` segments).

`firstMeaningfulTranscriptTitle(transcriptContent: string, conversationId: string): string | null`

1. Parse jsonl lines (same line loop as `summarizeTranscriptForSidebar`).
2. Collect snippets via existing `collectTranscriptSnippets` + `normalizePreviewLine`.
3. **Pass 1:** lines where `role === "user"` and not boilerplate.
4. **Pass 2:** any non-boilerplate snippet.
5. Return `truncateText(first, 96)` or `null`.

`resolveConversationDisplayTitle(options): string`

```typescript
export function resolveConversationDisplayTitle(options: {
  conversationId: string;
  composerName?: string | null;
  transcriptContent?: string | null;
}): string;
```

Return order:

1. `composerName` if non-empty after trim.
2. `firstMeaningfulTranscriptTitle(transcriptContent, conversationId)` if non-null.
3. `conversationId`.

### `chat-export-ux.ts` changes

- At start of `listConversationsForWorkspace` / `pickChatsForExport`: `const composerIndex = await loadComposerNameIndex()`.
- Replace `transcriptTitleForConversation` with:
  - Read first available jsonl content (existing scan).
  - `resolveConversationDisplayTitle({ conversationId, composerName: composerIndex.get(conversationId), transcriptContent })`.
- Remove direct `summarizeTranscriptForSidebar` import from this file.

### `transcripts.ts` changes

In `discoverExportConversationCandidates`:

- Load composer index once per call.
- Set `label` via `resolveConversationDisplayTitle` instead of `summary.title` from `summarizeTranscriptForSidebar`.
- Keep `description` / `detail` unchanged.

### Import transcript flows

Where import gist discovery builds user-visible conversation labels in QuickPicks (if present), use the same resolver. Sidebar payload building in `buildHeadersPayloads` continues to use `summarizeTranscriptForSidebar` for derived import metadata.

## QuickPick row contract (unchanged wiring)

### Workspace

| Field | Value |
|-------|--------|
| `label` | Resolved tilde path or `humanWorkspaceLabel` fallback |
| `description` | md5 chats key (picker return value) |
| `detail` | `w.fullPath` or projects root join |

### Conversation

| Field | Value |
|-------|--------|
| `label` | `resolveConversationDisplayTitle(...)` |
| `description` | `conversationId` |
| `detail` | e.g. `3 jsonl · store.db` |

Cancel / empty-selection behavior unchanged from parent spec.

## Error handling

| Case | Behavior |
|------|----------|
| `workspaceStorage` scan fails | Empty map → all workspace labels use `humanWorkspaceLabel` fallback |
| No `workspace.json` for a chats key | Fallback label for that key only |
| `state.vscdb` unreadable | Empty composer index → transcript-only titles |
| No jsonl / only boilerplate | Label = `conversationId` |
| Picker cancelled | Unchanged (silent abort) |

## Testing

### `tests/chat-workspace-label.test.ts`

- `formatDisplayPath` — tilde under home, absolute outside home.
- `workspaceQuickPickLabel` — resolved key → tilde label; unknown key → `humanWorkspaceLabel`.
- `buildChatsKeyToFolderMap` — temp `workspaceStorage` fixture with `workspace.json` → correct md5 key.

### `tests/chat-export-ux.test.ts`

- Conversation row label uses composer name when index mocked/supplied.
- Jsonl fixture: skills preamble line then user message → label is user message, not preamble.
- Fallback to `conversationId` when no composer name and no meaningful transcript.

### `tests/transcript-bundle.test.ts` (or dedicated)

- `isTranscriptBoilerplate` — known preamble strings true; normal user question false.
- `firstMeaningfulTranscriptTitle` — skips preamble, returns user line.
- `resolveConversationDisplayTitle` — priority order 1 → 2 → 3.

### Optional integration

- Extend transcript export candidate test if `discoverExportConversationCandidates` label is asserted elsewhere.

## Implementation notes

- Prefer pure functions for map build, path format, and title resolution (test without VS Code).
- Reuse `folderFromWorkspaceJson` / `md5FolderKey` from `chat-workspace-context.ts`; export `buildChatsKeyToFolderMap` for tests.
- Do not bump `package.json` version unless user requests release.
- Parent QuickPick spec non-goal “optional workspace path resolution” is superseded by this spec for label display only (still no new persistence fields).

## Open questions

None.
