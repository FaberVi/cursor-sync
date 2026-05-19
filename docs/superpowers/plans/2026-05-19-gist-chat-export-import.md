# Gist Chat Export/Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add private Gist export and import for single-conversation `ChatBundle` payloads, mirroring local save/load but shareable via URL.

**Architecture:** Refactor `chat-persistence.ts` to expose `buildChatBundle` and `restoreChatBundle` used by local and gist flows. Gist export uploads one `chat-bundle.json` file; gist import fetches by URL/ID, validates bundle type, then calls the same restore path as local load.

**Tech Stack:** TypeScript, VS Code extension API, `GistClient`, Vitest

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `src/chat-persistence.ts` | Bundle build/restore core + local commands | Export shared functions |
| `src/export-gist-chat.ts` | Export chat to private Gist | Create |
| `src/import-gist-chat.ts` | Import chat from Gist URL/ID | Create |
| `src/extension.ts` | Command registration | Modify |
| `package.json` | Command contributions | Modify |
| `tests/chat-gist-export-import.test.ts` | Gist chat round-trip tests | Create |
| `tests/export-visibility.test.ts` | Private gist copy assertions | Modify |
| `README.md` | User-facing docs | Modify |
| `CHANGELOG.md` | Release notes | Modify |

Constants: `CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json"`, gist description `"Cursor Sync - Chat Export"`.

---

### Task 1: Extract shared build/restore core

**Files:**
- Modify: `src/chat-persistence.ts`

- [ ] Export `buildChatBundle(conversationId, progress)` returning `ChatBundle` + warnings (logic from `saveChat` without file write).
- [ ] Export `restoreChatBundle(context, bundle, progress)` returning `LoadChatResult` (logic from `loadChat` without file read).
- [ ] Refactor `saveChat` / `loadChat` to call the shared functions.
- [ ] Run `npm test -- tests/chat-persistence.test.ts` and ensure passing.

---

### Task 2: Gist chat export

**Files:**
- Create: `src/export-gist-chat.ts`

- [ ] `executeExportChatToGist(context)`: prompt conversation ID (same as local save), require token, build bundle, `createGist({ "chat-bundle.json": { content: JSON.stringify(bundle) } }, "Cursor Sync - Chat Export")`.
- [ ] Progress UI + success message with optional Copy URL (match `export.ts` private gist copy).
- [ ] Run tests after Task 5.

---

### Task 3: Gist chat import

**Files:**
- Create: `src/import-gist-chat.ts`

- [ ] `executeImportChatFromGist(context)`: gist URL/ID input (reuse `extractGistId` pattern from `import-gist-transcripts.ts` or share helper).
- [ ] Fetch gist, require `chat-bundle.json`, parse as `ChatBundle`, validate `type === "chat-persistence"` and `schemaVersion === 1`.
- [ ] Call `restoreChatBundle`; reuse reload-after-import UX from `executeLoadChatLocal`.
- [ ] Clear error if gist has transcript manifest but no chat bundle.

---

### Task 4: Register commands

**Files:**
- Modify: `src/extension.ts`, `package.json`

- [ ] Commands: `cursorSync.exportChatToGist`, `cursorSync.importChatFromGist`.
- [ ] Titles: `Cursor Sync: Export Chat to Private Gist`, `Cursor Sync: Import Chat from Private Gist`.

---

### Task 5: Tests

**Files:**
- Create: `tests/chat-gist-export-import.test.ts`
- Modify: `tests/export-visibility.test.ts`

- [ ] Mock `GistClient`; export creates gist with `chat-bundle.json` only, two-arg `createGist`.
- [ ] Import fetches gist, validates bundle, calls restore (mock filesystem/sqlite as needed).
- [ ] Reject gist missing `chat-bundle.json` or wrong bundle type.
- [ ] `npm test` for new/changed tests.

---

### Task 6: Documentation

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] Document new commands under chat/transcript section.
- [ ] CHANGELOG entry under unreleased/next version for gist chat export/import.
