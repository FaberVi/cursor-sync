# Security audit: sidebar, chat import/export, packaging, scheduler

**Date:** 2026-08-04  
**Scope:** 12 files listed below  
**Commit:** `7713dc7b147bfe35fd8c9d28139b92de55ef3c9a`  
**Agent:** bc-78adfa2d-7164-4551-b620-98af81943c0c  

## Summary

| Severity | Count | Notes |
|----------|------:|-------|
| High (reconfirmed) | 2 | `conversationId` path traversal in restore; extension auto-install helper used by pull |
| Medium (new) | 2 | Unallowlisted `settings:set`; unsanitized webview `conversationId` FS open/reveal |
| Medium (reconfirmed) | 2 | Workspace `pythonPath` RCE; workspace can disable chat gist encryption |
| Low (new) | 1 | Uncapped `retryAfter` stall |
| Cleared / informational | — | See per-file sections |

---

## 1. `src/sidebar/messages.ts` (133 lines)

### Role
Dispatches every webview → extension-host message for the Cursor Sync sidebar.

### Untrusted inputs
- Entire `msg` object from `webview.onDidReceiveMessage` (cast to `SidebarMessage` with **no runtime schema validation**).
- Fields: `command`, `conversationId`, `bundlePath`, `key`, `value`.

### Analysis checklist
| Check | Result |
|-------|--------|
| External/untrusted inputs | Yes — all webview postMessage payloads |
| FS without path validation | Indirect — `conversationId` forwarded to `activateExistingChat` / `revealTranscriptsForConversation` |
| SQL with untrusted input | No (this file) |
| Command execution | `vscode.commands.executeCommand` for sync/export/import (fixed command IDs) |
| Deserialization | No JSON.parse here |
| Missing authorization | No allowlist on `settings:set` keys; no UUID check on `conversationId` |
| Race conditions | None material |

### Findings

#### NEW — Medium: `settings:set` writes any `cursorSync.*` key globally without allowlist
```127:130:src/sidebar/messages.ts
    case "settings:set": {
      const { updateSettingValue } = await import("./settings-tab.js");
      await updateSettingValue(msg.key, msg.value);
```
`updateSettingValue` does `cfg.update(key, value, ConfigurationTarget.Global)` with no key allowlist and no value type checks. A crafted webview message can set Global:
- `chatImport.pythonPath` → combines with known RCE
- `chatGist.encrypt` → force plaintext exports
- `syncExtensions.autoInstall` / `safeMode` / schedule knobs

**Remediation:** Allowlist keys to those rendered in the settings pane; validate types; reject unknown keys.

#### Defense gap: no message schema validation
`index.ts` casts `message: SidebarMessage` without zod/manual validation. Unknown commands fall through silently (no `default`).

#### Note
`chats:export` / `chats:exportGist` / `chats:importBundle` ignore `conversationId` / `bundlePath` and only invoke palette commands — currently safe, but dead fields invite future misuse.

---

## 2. `src/sidebar/chats-tab.ts` (173 lines)

### Role
Lists local chats/imports/bundles; opens or reveals transcript directories.

### Untrusted inputs
- `conversationId` from webview (`chats:revealTranscripts`, and via `openTranscriptForConversation` from activation fallback).
- Directory names under `~/.cursor/projects` and chats root (local FS).

### Analysis checklist
| Check | Result |
|-------|--------|
| External/untrusted inputs | `conversationId` from webview |
| FS without path validation | **Yes** — `path.join(..., conversationId)` |
| SQL | No |
| Command execution | `vscode.open`, `revealInExplorer` |
| Deserialization | No |
| Missing authorization | No UUID / `isSafeSegment` check |
| Race conditions | None material |

### Findings

#### NEW — Medium: path traversal via `conversationId` in reveal/open
```118:131:src/sidebar/chats-tab.ts
    const transcriptDir = path.join(
      projectsRoot,
      proj.name,
      "agent-transcripts",
      conversationId
    );
    // ...
      const uri = vscode.Uri.file(path.join(transcriptDir, jsonl));
      await vscode.commands.executeCommand("vscode.open", uri);
```
Same pattern in `revealTranscriptsForConversation` (lines 154–164).

Verified resolution:
`conversationId = "../../../tmp/pwned"` → `~/.cursor/tmp/pwned` (escapes `projects/<proj>/agent-transcripts`).

Impact: open/reveal arbitrary paths the user can read (info disclosure / unexpected file open). Not a direct write; still violates containment.

**Remediation:** Require UUID (`COMPOSER_ID_RE`); after `path.resolve`, assert `path.relative(projectsRoot, resolved)` has no `..`.

---

## 3. `src/chat-import-sidebar-writeback.ts` (257 lines)

### Role
Queues/flushes pending sidebar merge + optional activation after chat import.

### Untrusted inputs
- `ChatBundle` JSON from disk (`entry.bundlePath`).
- `entry.workspaceStorageId`, `folderFsPath`, `conversationId` from `globalState` pending queue.

### Analysis checklist
| Check | Result |
|-------|--------|
| External/untrusted inputs | Pending bundle JSON; globalState entries |
| FS without path validation | Partially mitigated |
| SQL | Via `mergeSidebarIntoStateDb` (downstream) |
| Command execution | No |
| Deserialization | `JSON.parse(raw) as ChatBundle` — no re-validation |
| Missing authorization | N/A (extension-owned queue) |
| Race conditions | Flush vs. reload; entries retained on partial merge (intentional) |

### Positive controls
- `COMPOSER_ID_RE` UUID gate on `queueSidebarWriteback` and flush.
- `resolvePendingBundlePath` contains paths under `~/.cursor/import-activation/sidebar-pending` (rejects sibling-prefix and `../`).

### Residual issues
- `applyImmediateSidebarWriteback` does **not** enforce UUID (only non-empty trim) — inconsistent with queue.
- Flush `JSON.parse` does not re-run `parseChatBundleOrCollection` / schema validation.
- `stateDbPathForWorkspaceStorageId(entry.workspaceStorageId)` does not sanitize storage id segments (poisoned globalState could traverse); requires prior compromise of extension globalState.

**Cleared for new Critical/High** in this file alone when queue path is used.

---

## 4. `src/chat-import-ux.ts` (375 lines)

### Role
Batch restore UX, workspace folder picker, outcome toasts/logging.

### Analysis checklist
| Check | Result |
|-------|--------|
| External/untrusted inputs | Bundle titles/ids in UI strings; `restoreOptions` from config |
| FS / path validation | Picker returns `folders[].uri.fsPath` only |
| SQL | No |
| Command execution | No |
| Deserialization | No |
| Command injection | **None** — no shell/spawn |
| Race conditions | None |

### Notes
- `restoreOptionsFromConfiguration()` (caller) uses workspace-effective `config.get` for activate defaults — UX influence, not RCE by itself.
- Failure labels use `bundle.title` / `conversationId` in toasts only (not executed).

**Cleared** for command injection / path issues in this file.

---

## 5. `src/chat-persistence-restore.ts` (730 lines)

### Role
Core chat bundle restore: Python transport, golden store, verify, activate.

### Untrusted inputs
- `ChatBundle` (gist/file): `conversationId`, `transcriptFiles[].relativePath`, snapshots.
- Workspace settings: `chatImport.pythonPath`, `chatImport.autoMapToOpenWorkspace`.
- `options.workspaceFolder`.

### Analysis checklist
| Check | Result |
|-------|--------|
| External/untrusted inputs | Bundle + settings |
| FS without path validation | **Yes** |
| SQL | Via Python / verify helpers |
| Command execution | `spawnSync(cand, ["--version"])` then Python transport |
| Deserialization | Bundle already parsed upstream; `safeJsonParse` helper |
| Missing authorization | Settings not locked to global |
| Race conditions | Temp file write/unlink in `finally` — OK |

### Findings

#### RECONFIRMED — Medium: workspace `pythonPath` → arbitrary execution
```96:105:src/chat-persistence-restore.ts
  const config = vscode.workspace.getConfiguration("cursorSync");
  const configured = config.get<string>("chatImport.pythonPath")?.trim();
  const candidates = configured ? [configured] : ["python3", "python"];
  for (const cand of candidates) {
    try {
      const { spawnSync } = await import("node:child_process");
      const res = spawnSync(cand, ["--version"], { encoding: "utf-8" });
```
Uses `config.get()` (all scopes). Contrast: `transportChatScriptDir` correctly uses `inspect().globalValue`.

#### RECONFIRMED — High: `conversationId` path traversal on temp + store paths
```215:219:src/chat-persistence-restore.ts
  const storeDbPath = path.join(
    resolveChatsRoot(),
    storeWorkspaceKey,
    bundle.conversationId,
    "store.db"
  );
```
```391:396:src/chat-persistence-restore.ts
  const tmpBundlePath = path.join(
    os.tmpdir(),
    `cursor-sync-import-${conversationId}-${Date.now()}.json`
  );
  // ...
    await fs.writeFile(tmpBundlePath, JSON.stringify(remappedBundle, null, 2), "utf8");
```
Verified: `conversationId=../../../tmp/pwned` → `/tmp/pwned-<ts>.json` arbitrary write of bundle JSON.

`validateSingleBundle` only requires non-empty string `conversationId` (no `isSafeSegment` / UUID).

#### Also
- `applyProjectMappingToBundle` rewrites `relativePath` first segment only; remaining `../` segments still reach Python disk import (known bundle path issue).

---

## 6. `src/export-gist-chat.ts` (144 lines)

### Role
Export selected chats to a private GitHub Gist; optional encryption.

### Untrusted inputs
- Encryption enable flag via settings (`isChatGistEncryptionEnabled()`).
- Chat selection from UI (local).

### Analysis checklist
| Check | Result |
|-------|--------|
| External inputs | Settings scope for encrypt flag |
| FS | Via export builders (not this file) |
| SQL | No |
| Command execution | No |
| Deserialization | No |
| Secrets | Token via `requireToken` / SecretStorage — not logged |

### Findings

#### RECONFIRMED — Medium: workspace can disable encryption
`isChatGistEncryptionEnabled()` (in `chat-encryption-auth.ts`) uses `config.get()`; export skips `encryptChatGistPayload` when false → plaintext private gist upload despite user-global encrypt intent.

**Cleared here:** PAT handling; gist create goes through `withRetry` + `GistClient`.

---

## 7. `src/import-gist-chat.ts` (280 lines)

### Role
Import chat bundle(s) from a GitHub Gist URL/ID.

### Untrusted inputs
- User gist URL/ID (validated).
- Gist file content (JSON / encrypted envelope).

### Analysis checklist
| Check | Result |
|-------|--------|
| External inputs | Gist id + file content |
| FS | Delegated to restore |
| SQL | No |
| Command execution | No |
| Deserialization | `parseChatBundleOrCollection` after optional decrypt |
| Auth | Requires configured token for private gists |

### Positive controls
```270:279:src/import-gist-chat.ts
function extractGistId(input: string): string | null {
  // ...
  const urlMatch = trimmed.match(/gist\.github\.com\/[^/]+\/([A-Za-z0-9-]+)/i);
  if (urlMatch) return urlMatch[1]!;
  if (/^[A-Za-z0-9-]+$/.test(trimmed)) return trimmed;
```

### Findings

#### RECONFIRMED — Medium: attacker Argon2 params (DoS) via decrypt path
`decryptChatGistPayload` accepts envelope KDF ceilings (see `chat-gist-crypto.ts`); triggered from `resolveGistChatFileContent` before restore.

Downstream restore inherits High `conversationId` / transcript path issues.

---

## 8. `src/chat-workspace-context.ts` (268 lines)

### Role
Resolves workspace folder → chats MD5 key, workspaceStorage id, composer `workspaceIdentifier`.

### Untrusted inputs
- `options.workspaceFolder`, `options.stateDbPath`.
- `workspace.json` `folder` URIs on disk.
- `targetWorkspace` override in `resolveChatsWorkspaceKey`.

### Analysis checklist
| Check | Result |
|-------|--------|
| External inputs | Paths / JSON from disk |
| FS without validation | `stateDbPathForWorkspaceStorageId` joins `workspaceStorageId` unchecked |
| SQL | No |
| Deserialization | `JSON.parse` of `workspace.json` |
| Path traversal | `resolveChatsWorkspaceKey` can return raw `targetWorkspace` for store key |

### Findings
- `folderToProjectKey` encodes path separators to `-` (good for project dir names).
- `stateDbPathForWorkspaceStorageId("../../tmp/x")` resolves outside `workspaceStorage` — callers must sanitize; writeback uses ids from prior resolve/scan.
- `resolveChatsWorkspaceKey` returning unsanitized `targetWorkspace` is a footgun if callers `path.join(chatsRoot, key, ...)` without checks (current transcript import uses local dir names).

**No standalone Critical** without a caller that accepts attacker `targetWorkspace` into FS writes.

---

## 9. `src/retry.ts` (46 lines)

### Role
Retry wrapper for GitHub API `ApiResult` calls.

### Findings

#### NEW — Low: uncapped `retryAfter` can stall the extension host
```27:31:src/retry.ts
    if (attempt < MAX_ATTEMPTS - 1) {
      const delay = result.error.retryAfter
        ? result.error.retryAfter * 1000
        : BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
      await sleep(delay);
```
`gist.ts` sets `retryAfter` from `Retry-After` via `parseInt` with no upper bound. A huge header value yields multi-year `setTimeout` delays (blocks the async retry chain for that operation).

NaN/`-1` headers fire immediately (not a hang).

**Remediation:** Cap e.g. `Math.min(Math.max(0, retryAfter), 120)` seconds; treat non-finite as default backoff.

No command execution / FS / SQL.

---

## 10. `src/scheduler.ts` (277 lines)

### Role
Periodic pull/push based on checksum diff vs gist manifest.

### Untrusted inputs
- Workspace settings: `schedule.enabled`, `schedule.intervalMin` (min clamped to 5).
- Remote `manifest.json` from gist (checksums only used for comparison).
- Sync state gist id.

### Analysis checklist
| Check | Result |
|-------|--------|
| External inputs | Manifest JSON; settings |
| FS | Reads local sync files for checksums |
| Deserialization | `JSON.parse(manifestFile.content)` |
| Command execution | No — calls `executePull` / `executePush` |
| Authorization | Uses `requireToken` |

### Findings
- Scheduler itself does not write remote file contents; **amplifies** known High issues in `executePull` (path traversal write, extension auto-install) when `trigger: "scheduled"` bypasses interactive safe-mode prompts.
- Workspace can toggle/schedule interval (cannot go below 5 minutes).
- Conflict / error paths use sanitized debug helpers.

**No new Critical in this file**; documents amplification of pull-path findings.

---

## 11. `src/packaging.ts` (65 lines)

### Role
Read local sync files, checksum, build gist manifest payload.

### Analysis checklist
| Check | Result |
|-------|--------|
| External inputs | `SyncFileEntry.absolutePath` / `relativeSyncKey` from callers |
| FS | `fs.readFile(file.absolutePath)` — trusts enumerator |
| Deserialization | No |
| Command execution | No |
| Privacy | `computeMachineId` hashes `hostname:username` (not a secret leak of PAT) |

**Cleared** for injection in this module; risk is entirely whether `enumerateSyncFiles` keeps paths inside sync roots (out of scope file).

---

## 12. `src/extensions.ts` (56 lines)

### Role
Serialize installed extensions; diff remote vs local lists.

### Analysis checklist
| Check | Result |
|-------|--------|
| External inputs | `remoteEntries[].id` from gist JSON (via pull) |
| FS / SQL / shell | No |
| Validation | No publisher allowlist / id format check |

### Findings

#### RECONFIRMED — High (impact in `pull.ts`, helper here)
`findMissingExtensions` returns remote IDs with no allowlist. `pull.ts` `syncExtensionsAfterPull` auto-installs when `syncExtensions.autoInstall` defaults true — RCE via malicious extension after gist compromise.

This file alone only compares IDs; exploit completion is in pull.

---

## Cross-cutting recommendations

1. Treat UUID / `isSafeSegment` as mandatory for every `conversationId` used in `path.join`.
2. Read security-sensitive settings (`pythonPath`, `chatGist.encrypt`, `safeMode`, `syncExtensions.*`) via `inspect().globalValue` (or `scope: application` in package.json).
3. Allowlist sidebar `settings:set` keys; add CSP to webview HTML; runtime-validate webview messages.
4. Cap `retryAfter`; reject sqlite/meta and path-escaping IDs at parse boundaries (`chat-bundle-format`, sync manifest).
5. Default `syncExtensions.autoInstall` to false; confirm before install.

---

## Key file excerpts (full small files)

### `retry.ts` (full)
See repository `src/retry.ts` (46 lines) — entire module is the retry loop above.

### `extensions.ts` (full)
See repository `src/extensions.ts` (56 lines) — `generateExtensionsJson` / `findMissingExtensions` / `findExtraExtensions`.

### `packaging.ts` (full)
See repository `src/packaging.ts` (65 lines) — `packageFiles` / checksum / machine id.

Larger modules are summarized by the cited line ranges above rather than pasted in full.
