# Debug Sync with Cursor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `Debug with Cursor` toast action on every sync failure that opens a new Composer with a reviewable, sanitized debug prompt (clipboard fallback when prefill is unavailable).

**Architecture:** New `src/sync-debug.ts` owns `SyncDebugFailure`, prompt building, notification action handling, and Composer open/fallback. `push.ts`, `pull.ts`, `extension.ts` (`executeSyncNow`), and `scheduler.ts` only construct failure metadata and call `showSyncFailureWithDebug`. Reuse `composer.createComposer` / `composer.openComposer` patterns from `src/chat-import-activate.ts` for best-effort prefill via `partialState.text` when supported.

**Tech Stack:** TypeScript, VS Code Extension API, Vitest, existing `tests/__mocks__/vscode.ts`.

**Spec:** `docs/superpowers/specs/2026-05-28-debug-sync-with-cursor-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/sync-debug.ts` | Create | Types, prompt builder, toast + Composer integration |
| `tests/sync-debug.test.ts` | Create | Unit tests for prompt + notification/Composer behavior |
| `tests/__mocks__/vscode.ts` | Modify | Add `env.clipboard.writeText` mock if missing |
| `src/push.ts` | Modify | Replace failure toasts with `showSyncFailureWithDebug` |
| `src/pull.ts` | Modify | Replace failure toasts with `showSyncFailureWithDebug` |
| `src/extension.ts` | Modify | `executeSyncNow` error/conflict/exception paths |
| `src/scheduler.ts` | Modify | Scheduled failure paths (not routine skips) |
| `tests/push-pull-debug.test.ts` | Create | Spy `showSyncFailureWithDebug` from push/pull/syncNow/scheduler |

---

### Task 1: Sync debug module (prompt + types)

**Files:**
- Create: `src/sync-debug.ts`
- Create: `tests/sync-debug.test.ts`

**Requirements:**
- Export `SyncDebugFailure` with fields from spec: `operation`, optional `direction`, `trigger`, `message`, optional `category`, `statusCode`, `conflictCount`, `extensionVersion`, `platform`.
- Export `DEBUG_WITH_CURSOR_ACTION = "Debug with Cursor"`.
- Export pure `buildSyncDebugPrompt(failure: SyncDebugFailure): string` that:
  - Includes operation, trigger (manual vs scheduled), direction, category, message, platform, extension version.
  - Instructs Cursor to diagnose, inspect listed files (`src/push.ts`, `pull.ts`, `scheduler.ts`, `extension.ts`, `diagnostics.ts`, `gist.ts`), output channel, sync history — prefer permanent fix or exact user action; no secrets.
  - Never embed tokens, gist IDs, absolute paths, or full logs even if passed in `message` (sanitize message: strip gist-like hex ids, home paths, `ghp_` tokens).
- Export `readExtensionVersion(): string` reading `package.json` adjacent to extension (use `import` from `../package.json` with `assert { type: "json" }` or read via `fs` from `context.extensionPath` in later task — for pure builder tests, accept version via failure field defaulting from package).
- Do **not** wire push/pull yet.

**Tests (TDD):**
- Prompt contains operation, trigger, message/category, platform, fix-or-user-action instructions.
- Prompt does not contain injected secret-like substrings when message contains token/gist id/path.
- Scheduled vs manual wording differs.

**Verify:** `npm test -- tests/sync-debug.test.ts`

---

### Task 2: Notification action + Composer prefill/fallback

**Files:**
- Modify: `src/sync-debug.ts`
- Modify: `tests/sync-debug.test.ts`
- Modify: `tests/__mocks__/vscode.ts` (clipboard mock, message mocks returning selected action)

**Requirements:**
- `showSyncFailureWithDebug(context, failure, options?: { level?: "error" | "warning"; title?: string })`:
  - Shows `showErrorMessage` or `showWarningMessage` with `DEBUG_WITH_CURSOR_ACTION` as extra button.
  - On action: calls `openComposerWithPrefilledPrompt(prompt)`.
  - If user dismisses, no further work.
- `openComposerWithPrefilledPrompt(prompt: string)` (best-effort, never throws):
  1. If `composer.createComposer` available: `executeCommand` with minimal `partialState` (`composerId` uuid, `text: prompt`, `richText` optional) and `{ openInNewTab: true, view: "editor" }` per `chat-import-activate.ts`.
  2. If result has `composerId`, try `composer.openComposer` / `composer.focusComposer`.
  3. If prefill unsupported or open fails: `env.clipboard.writeText(prompt)` + `showInformationMessage` to paste into Cursor chat; still try to open empty Composer when commands exist.
  4. If no composer commands: clipboard + information message only.
  - Log fallback via `getLogger()` from `diagnostics.ts`; swallow errors.
- Export helpers for tests: `__testOnlyOpenComposer` or mock-friendly internal exports only if needed.

**Tests:**
- Mock `showErrorMessage` returning `"Debug with Cursor"` → `executeCommand` called with createComposer when registered.
- When createComposer missing → clipboard write + info message.
- When createComposer succeeds but no text in args → clipboard fallback path (if detectable).

**Verify:** `npm test -- tests/sync-debug.test.ts`

---

### Task 3: Wire push and pull failure branches

**Files:**
- Modify: `src/push.ts`
- Modify: `src/pull.ts`
- Create: `tests/push-pull-debug.test.ts`

**Requirements:**
- Replace **failure** `showErrorMessage` / conflict-blocker `showWarningMessage` with `showSyncFailureWithDebug(context, { operation: "push"|"pull", direction, trigger, message, category, statusCode, conflictCount })`.
- Keep: history, telemetry, status bar, logs, return values, in-progress skip toast unchanged.
- Conflict blocker on push: warning level + conflict count.
- Auth/no-token failures: include category `AUTH_FAILED` or `no_token` without token in message.

**Tests:**
- Mock `showSyncFailureWithDebug`; trigger push gist failure and pull auth failure; assert called with correct `operation`, `direction`, `trigger`.

**Verify:** `npm test -- tests/push-pull-debug.test.ts`

---

### Task 4: Wire Sync Now (`extension.ts`)

**Files:**
- Modify: `src/extension.ts`
- Modify: `tests/push-pull-debug.test.ts` (or `tests/sync-now-debug.test.ts`)

**Requirements:**
- `executeSyncNow` on `error`, `conflict`, and `catch` uses `showSyncFailureWithDebug` with `operation: "syncNow"`, `trigger: "manual"`.
- Do **not** add debug toast when delegating to push/pull that already shows one (push/pull unchanged for those paths).
- Conflict: warning level, `category: "CONFLICT"`, `conflictCount: result.keys.length`.

**Tests:**
- Mock determineSyncAction → error/conflict; assert helper called once with syncNow metadata.

**Verify:** `npm test`

---

### Task 5: Wire scheduled sync failures

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `tests/scheduler.test.ts` or `tests/push-pull-debug.test.ts`

**Requirements:**
- On scheduled `error`, `conflict`, failed push/pull (`false` return), and `catch` in `scheduledTick`: call `showSyncFailureWithDebug` with `operation: "scheduler"`, `trigger: "scheduled"`.
- Do **not** call helper for `none`, in-progress skip, or routine skipped paths.
- Scheduled conflicts: warning + conflict count (may only log today — add toast per spec).

**Tests:**
- `determineSyncAction` → error in scheduled tick → helper with `trigger: "scheduled"`.
- `none` / in-progress skip → helper not called.

**Verify:** `npm test`

---

## Acceptance

- All sync failure toasts offer `Debug with Cursor`.
- Composer opens with prefilled prompt when supported; otherwise clipboard + guidance.
- No secrets in prompt; existing success/history behavior unchanged.
- Full suite: `npm test`
