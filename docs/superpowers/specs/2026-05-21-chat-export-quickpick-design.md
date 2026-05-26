# Chat export QuickPick and batch bundle design

**Date:** 2026-05-21  
**Status:** Approved for implementation planning  
**Scope:** Replace manual conversation-ID prompts with a guided export picker; support multi-chat batch export/import.

## Summary

Replace `showInputBox` conversation-ID entry in all three chat export/save commands with a two-step QuickPick flow aligned with existing import UX: pick a local Cursor workspace (`~/.cursor/chats/<md5>`), then multi-select conversations discovered on disk. Exports produce either a single `ChatBundle` (one chat) or a `ChatBundlesCollection` wrapper (multiple chats). Gist export uses one private Gist per run. Import (Gist URL and local bundle file) detects the batch shape and lets the user pick which conversation to restore.

## Goals

- Discover workspaces and conversations from disk; never require typed IDs.
- Multi-select conversations; cancel at any picker step aborts the command.
- Reuse import UX conventions: `humanWorkspaceLabel`, QuickPick titles/placeholders matching gist transcript import.
- Apply the new picker to:
  - `executeExportChatToGist` (`src/export-gist-chat.ts`)
  - `executeExportChatBundle` (`src/chat-persistence.ts`)
  - `executeSaveChatLocal` (`src/chat-persistence.ts`)
- Keep existing private-Gist success/error copy and two-argument `createGist` (no public flag).
- Extend Gist and local file import to support batch bundles with a per-bundle QuickPick.
- Add unit tests for picker helpers and batch parse logic.

## Non-goals

- Changing the Gist URL input for chat import (still paste URL/ID).
- Changing agent transcript Gist import/export flows.
- Automatic import of all bundles in a collection in one run (user picks one).
- Resolving md5 workspace keys to friendly folder paths in the picker (optional enhancement only if cheap via `workspaceStorage` scan).

## Decisions (from brainstorming)

| Topic | Decision |
|-------|----------|
| Commands using picker | All three ID-prompt flows (Gist export, local bundle export, save locally) |
| Multi-chat Gist | One Gist; multiple bundles in one file when count > 1 |
| Multi-chat local | One combined JSON file (same shape as multi-chat Gist) |
| Multi-chat import | Detect batch shape; QuickPick one bundle to restore |
| Workspace source | `~/.cursor/chats/` directory keys (parity with `import-gist-transcripts.ts`) |

## Architecture

### Approach

**Dedicated `chat-export-ux.ts` + shared workspace label helper** (recommended over extending `chat-import-ux.ts` or reusing project-first transcript export discovery).

```text
┌─────────────────────────────────────────────────────────────┐
│  Commands: export Gist | export file | save local             │
└───────────────────────────┬─────────────────────────────────┘
                            │
                            ▼
              ┌─────────────────────────┐
              │  pickChatsForExport()   │  chat-export-ux.ts
              │  1. workspace QuickPick │
              │  2. conversations multi │
              └───────────┬─────────────┘
                          │ { workspaceKey, conversationIds[] }
                          ▼
              ┌─────────────────────────┐
              │  buildChatBundle (×N)   │  chat-persistence.ts
              │  optional workspaceKey  │
              └───────────┬─────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
   single ChatBundle              ChatBundlesCollection
   (1 conversation)              (2+ conversations)
          │                               │
          ▼                               ▼
   chat-bundle.json              chat-bundles.json (Gist)
   or .json file                  or combined local file
```

### New / moved modules

| Module | Responsibility |
|--------|----------------|
| `src/chat-workspace-label.ts` | `humanWorkspaceLabel(folderName)`; shared by import and export |
| `src/chat-export-ux.ts` | Disk discovery + VS Code QuickPicks for export |
| `src/chat-bundle-format.ts` (optional) | `ChatBundlesCollection` type, `parseChatBundleOrCollection`, `pickBundleFromCollection` — may live in `chat-persistence.ts` if preferred to avoid extra file |

Refactor duplicates:

- `humanWorkspaceLabel` in `import-gist-transcripts.ts` and `chat-persistence.ts` → import from `chat-workspace-label.ts`.

## Export picker flow

### Step 1: Select workspace

- Root: `resolveChatsRoot()` → `~/.cursor/chats/`.
- List directories via `listChatsWorkspaceDirs(chatsRoot)` (same semantics as import).
- **0 workspaces:** `showErrorMessage` — no local chat workspaces; open a workspace in Cursor first.
- **1 workspace:** auto-select its key.
- **2+:** `showQuickPick` single-select:
  - `label`: `humanWorkspaceLabel(w.name)`
  - `description`: `w.name` (md5 key)
  - `detail`: `w.fullPath`
  - `title`: `Select workspace for chat export`
  - `placeHolder`: `Choose the workspace whose chats you want to export`
  - `ignoreFocusOut`: true
- User dismisses picker → return `null` (abort).

### Step 2: Select conversations

- For selected `workspaceKey`, enumerate `~/.cursor/chats/<workspaceKey>/*/`.
- Include a conversation when `store.db` exists in that folder (primary signal).
- Enrich QuickPick rows:
  - `label`: transcript-derived title via `summarizeTranscriptForSidebar` when any `~/.cursor/projects/*/agent-transcripts/<conversationId>/*.jsonl` exists; else `conversationId`.
  - `description`: `conversationId`
  - `detail`: e.g. `store.db` and/or `N jsonl` (mirror `discoverExportConversationCandidates` detail style).
- `showQuickPick` with `canPickMany: true`:
  - `title`: `Select conversations to export (N found)`
  - `placeHolder`: `Each selection exports store.db (scoped workspace), transcripts, and sidebar metadata when available`
  - Default: all items `picked: true` (same as transcript export).
- Empty list → `showInformationMessage` — no conversations in this workspace.
- No selection / dismiss → abort.

### Return type

```typescript
export interface ChatExportSelection {
  workspaceKey: string;
  conversationIds: string[];
}

export async function pickChatsForExport(): Promise<ChatExportSelection | null>;
```

## Batch bundle format

### Single chat (unchanged compatibility)

Existing `ChatBundle`:

```typescript
{
  schemaVersion: 1;
  type: "chat-persistence";
  createdAt: string;
  conversationId: string;
  title: string;
  // ... existing fields
}
```

### Multiple chats (new wrapper)

```typescript
export interface ChatBundlesCollection {
  schemaVersion: 1;
  type: "chat-bundles-collection";
  createdAt: string; // ISO-8601
  sourceWorkspaceKey: string; // md5 key from export picker
  bundles: ChatBundle[];
}
```

Validation rules:

- `bundles.length >= 1`
- Each element must pass existing single-bundle validation (`type`, `schemaVersion`, `conversationId`).

### File naming

| Context | 1 chat | 2+ chats |
|---------|--------|----------|
| Gist | `chat-bundle.json` (existing constant) | `chat-bundles.json` |
| Local save dialog default | `<safeId>-chat-bundle.json` | `chat-bundles-<timestamp>.json` |
| Local save under globalStorage | `<safeId>_<timestamp>.json` | `chat-bundles_<timestamp>.json` |

Gist `createGist` description remains `"Cursor Sync - Chat Export"`. Two arguments only (private by default).

### Success messaging

- **Single chat:** keep current string pattern:  
  `Export successful! Chat "<title>" in private Gist at <url>. Anyone with the link can open it.`
- **Multiple chats:**  
  `Export successful! <N> chats in private Gist at <url>. Anyone with the link can open it.`  
  Still offer `"Copy URL"`.
- Local export/save: analogous count in information message; preserve warning count suffix when applicable.

## `buildChatBundle` changes

Add optional scoped store lookup:

```typescript
export async function buildChatBundle(
  _context: vscode.ExtensionContext,
  conversationId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options?: { workspaceKey?: string }
): Promise<{ bundle: ChatBundle; title: string; warnings: string[] }>;
```

When `options.workspaceKey` is set:

- Resolve `store.db` only at `~/.cursor/chats/<workspaceKey>/<conversationId>/store.db`.
- Do not fall back to another workspace’s store for the same conversation ID.
- If missing, emit existing warning and continue with transcripts-only bundle if transcripts exist.

Transcript enumeration: unchanged — scan all `~/.cursor/projects/*/agent-transcripts/<conversationId>/` (preserves current cross-project behavior).

Sidebar snapshot: unchanged — read/filter `state.vscdb` globally for the conversation ID.

## Command behavior

### `executeExportChatToGist`

1. `pickChatsForExport()` → abort if null.
2. `requireToken` → abort if missing (existing).
3. `withProgress` — `Creating private Gist...`
4. For each `conversationId`, `buildChatBundle(..., { workspaceKey })`.
5. If one bundle → gist file `chat-bundle.json` with stringified single bundle.
6. If multiple → gist file `chat-bundles.json` with stringified `ChatBundlesCollection`.
7. `createGist` + existing success/error/copy URL flow.

### `executeExportChatBundle`

1. `pickChatsForExport()`.
2. Build bundle(s) in progress.
3. `showSaveDialog` with default name per table above.
4. Write one JSON file (single bundle object or collection).
5. Information message with title or count + warnings.

### `executeSaveChatLocal`

1. Same picker and build loop as file export.
2. Write under `context.globalStorageUri/chat-bundles/` without save dialog (existing auto path pattern, adapted for collection filename).

## Import changes

### Parse helper

`parseChatBundleOrCollection(raw: string): { kind: "single"; bundle: ChatBundle } | { kind: "collection"; collection: ChatBundlesCollection }`

- Invalid JSON / wrong `type` → existing-style errors.
- Collection with empty `bundles` → error.

`pickBundleFromCollection(collection): Promise<ChatBundle | null>`

- QuickPick items: `label: bundle.title`, `description: bundle.conversationId`, `detail` optional (subtitle / file count).
- `title`: `Select chat to import`
- `placeHolder`: `This export contains multiple conversations`
- Dismiss → abort import.

### Gist import (`import-gist-chat.ts`)

`fetchAndParseGistBundle`:

1. Fetch gist.
2. If `chat-bundle.json` present → parse as single (current behavior).
3. Else if `chat-bundles.json` present → parse collection → `pickBundleFromCollection` → return chosen `ChatBundle`.
4. Else existing errors (transcript manifest, settings manifest, missing file).

Export `CHAT_BUNDLES_GIST_FILE_NAME = "chat-bundles.json"` alongside existing `CHAT_BUNDLE_GIST_FILE_NAME`.

### Local bundle import (`executeImportChatBundleCore` in `chat-persistence.ts`)

After reading selected file:

1. `parseChatBundleOrCollection`.
2. If collection → `pickBundleFromCollection`.
3. Pass single `ChatBundle` into `loadChat` / `restoreChatBundle` (unchanged).

Gist URL input flow unchanged.

## Error handling

| Case | Behavior |
|------|----------|
| Picker cancelled | Silent return (no error toast) |
| No workspaces | Error message |
| No conversations in workspace | Information message |
| Token missing (Gist) | Existing auth failure path |
| `buildChatBundle` throws for one ID in batch | Fail entire export with `Chat export failed: <msg>` (no partial Gist) |
| Gist create fails | Existing `Export failed: ...` |
| Import batch parse fails | `Gist chat import failed` / `Chat import failed` with parse reason |

## Testing

### New `tests/chat-export-ux.test.ts`

- `humanWorkspaceLabel` — hash suffix stripping (8- and 40-char hex).
- `listChatsWorkspaceDirs` — temp fixture dirs.
- `listConversationsForWorkspace` — includes dirs with `store.db`, skips without.
- `pickChatsForExport` — mock `vscode.window.showQuickPick` sequence (workspace + multi conv); cancel returns null.

### New or extended `tests/chat-bundle-format.test.ts`

- `parseChatBundleOrCollection` — single bundle, collection, invalid type, empty bundles array.
- Gist file name selection logic (1 vs N bundles) if extracted to pure function.

### Extend `tests/export-visibility.test.ts`

- Assert multi-chat success copy still mentions `private Gist` and `Anyone with the link can open it.` when added.
- Keep two-arg `createGist` assertions.

### Update `tests/chat-gist-export-import.test.ts`

- Replace `showInputBox` conversation ID mocks with `showQuickPick` workspace + conversation picks.
- Add round-trip test: export collection → import picks one bundle → restore.

## Implementation notes

- Prefer pure functions for disk listing (testable without VS Code).
- Log export selection and batch size at info/debug level (existing logger patterns).
- Do not bump `package.json` version in implementation PR unless user requests release.
- Version gate: batch collection `schemaVersion: 1` is independent of per-bundle `schemaVersion: 1`.

## Open questions

None — brainstorming decisions are captured above.
