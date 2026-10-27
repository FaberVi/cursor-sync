# Scoped Security Audit — 2026-08-04

**Commit audited:** `7713dc7b147bfe35fd8c9d28139b92de55ef3c9a`  
**Branch:** `cursor/vulnerability-findings-management-ae89`  
**Run:** `bc-78adfa2d-7164-4551-b620-98af81943c0c`  
**Scope:** Ten security-critical modules listed below.

This report re-verifies prior flagged issues that touch this scope and documents new findings discovered in these files.

---

## Summary

| Severity | Count | Status |
|----------|------:|--------|
| Critical | 1 | Still active (sqlite3 `.shell` RCE via sync SQL) |
| High | 3 | Still active / newly confirmed in-scope |
| Medium | 3 | New or reconfirmed |
| Low / cleared | several | See per-file notes |

**Highest priority:** stop feeding untrusted SQL into `sqlite3 … '.read'`, and reject path segments containing `..` / separators before any `path.join` into `~/.cursor`.

---

## 1. `src/gist.ts` (198 lines)

### Role
GitHub Gist HTTP client: `GistClient` for API CRUD; `fetchGistFileContent` for truncated gist file download via `raw_url`.

### External / untrusted inputs
- Constructor PAT (`pat`) from SecretStorage (via callers).
- `gistId` interpolated into `/gists/${gistId}` (callers must validate).
- `file.raw_url` and `file.content` from GitHub API JSON.
- Request/response bodies (`JSON.stringify` / `response.json()`).

### File system
None.

### SQL / command execution
None. Uses `fetch` only.

### Deserialization
`response.json()` for API success and error bodies. No prototype-sensitive merges here.

### Authorization
Bearer-style `Authorization: token ${pat}` when present. No token logging in this module. Error messages use status codes / GitHub `message` field, not the PAT.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| GIST-1 | Low / cleared | `fetchGistFileContent` attaches the PAT to whatever host is in `file.raw_url` with no allowlist. In practice `raw_url` comes from GitHub’s API, not gist file contents. Node `fetch` strips `Authorization` on cross-origin redirects. No complete attacker-controlled `raw_url` chain found in-repo. |
| GIST-2 | Info | `GITHUB_API` is hardcoded to `https://api.github.com` — good. |
| GIST-3 | Info | `getGist` / `updateGist` do not validate `gistId` shape; callers such as `extractGistId` in transcript import restrict to hex IDs. Other call sites should keep the same discipline. |

### Key sections

```6:48:src/gist.ts
export async function fetchGistFileContent(
  file: GistFile | undefined,
  token?: string
): Promise<string> {
  // ...
  if (token) {
    headers.Authorization = `token ${token}`;
  }
  response = await fetch(file.raw_url, { headers });
  // ...
}
```

```92:106:src/gist.ts
  private async request<T>(...): Promise<ApiResult<T>> {
    const url = `${GITHUB_API}${endpoint}`;
    // ...
    if (this.pat) {
      headers["Authorization"] = `token ${this.pat}`;
    }
```

---

## 2. `src/auth.ts` (137 lines)

### Role
PAT capture, SecretStorage persistence, validation, clear, and require-with-prompt.

### External / untrusted inputs
- User-typed PAT from `showInputBox` (password field).
- Stored secret from VS Code SecretStorage.

### File system / SQL / commands
None directly. Uses `GistClient` for validation and gist discovery.

### Deserialization
None beyond API results in `gist.ts`.

### Authorization
Token stored under `cursorSync.githubPAT` via `context.secrets`. Never written to settings.json. Logs validation failure messages and gist IDs only — not the PAT.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| AUTH-1 | Cleared | PAT lifecycle is SecretStorage-only; validation errors show API category messages. |
| AUTH-2 | Info | `configureGithub` auto-binds the first gist whose description equals `"Cursor Sync - Settings Backup"`. A same-account attacker who can create such a gist could steer the victim’s configured gistId (requires PAT already compromised or shared account). |

### Key sections

```16:46:src/auth.ts
  const pat = await vscode.window.showInputBox({
    prompt: "Enter your GitHub Personal Access Token (requires gist scope)",
    password: true,
    // ...
  });
  // ...
  await context.secrets.store(SECRET_KEY, pat.trim());
```

---

## 3. `src/landing-zone-fetcher.ts` (10 lines)

### Role
Interface only: `LandingZoneFetcher.materialize(destinationDirectory)`.

### Analysis
No implementation ships in this file. No I/O, no auth, no SQL. Risk lives in future/concrete fetchers and in `SyncEngine`, which consumes whatever directory a fetcher (or user folder pick) produces.

### Findings
None in-file. Treat any future HTTP/Gist fetcher as fully untrusted input into `parseSyncManifestJson` / `SyncEngine.prepare`.

---

## 4. `src/sync-engine.ts` (328 lines)

### Role
Landing-zone sync prepare: read `sync-manifest.json`, shadow-copy live `state.vscdb`, run metadata SQL, hydrate/copy chat `store.db` files, write pending reconciliation bundle.

### External / untrusted inputs
- Entire landing zone tree (user-selected folder today; fetcher-materialized later).
- Manifest fields: `conversation_id`, `state_vscdb_sql`, `pre_hydrate_sql`, `store_db_file`, `composer_header_payloads`, workspace keys, etc.
- Parsed via `parseSyncManifestJson` (`src/sync-manifest.ts`).

### File system
- Reads landing assets (paths constrained by `resolveLandingPath` for relative asset files).
- Writes under extension `globalStorage/.../state-reconciliation/runs/<runId>/`.
- Builds **live** `store.db` paths: `path.join(chatsRoot, workspace_key, conversation_id, "store.db")` — **no containment check on `conversation_id`**.

### SQL
- `runMetadataSqlOnShadowDb(shadowMain, meta.state_vscdb_sql)` — raw strings from manifest.
- `runSqliteScript(shadowStore, manifest.db_template.pre_hydrate_sql)` — raw string from manifest.
- Composer header merge builds SQL with `escapeSqlLiteral`.

### Command execution
Indirect via `runSqliteScript` → `execFile("sqlite3", [dbPath, ".read " + tmpPath])`.

### Deserialization
`JSON.parse` of manifest; header payloads merged into DB.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| SYNC-1 | **Critical** | Manifest `metadata_overrides.state_vscdb_sql` and `db_template.pre_hydrate_sql` are executed through `runSqliteScript`. The sqlite3 CLI honors meta-commands (including `.shell`) inside `.read` files → **OS command execution during prepare**, before finalize confirmation. (Previously flagged; still present.) |
| SYNC-2 | **High** | `conversation_id` is only checked non-empty in `parseSyncManifestJson` (not `isSafeSegment` / UUID). `path.join(chatsRoot, workspace_key, conversation_id, "store.db")` resolves `../` outside `~/.cursor/chats`. Verified: `conversation_id=../../../tmp/pwn` → `/home/user/tmp/pwn/store.db`. |

### Key sections

```169:181:src/sync-engine.ts
    if (meta.state_vscdb_sql && meta.state_vscdb_sql.length > 0) {
      try {
        await runMetadataSqlOnShadowDb(shadowMain, meta.state_vscdb_sql);
```

```199:212:src/sync-engine.ts
      const liveStore = path.join(
        chatsRoot,
        entry.workspace_key,
        entry.conversation_id,
        "store.db"
      );
```

```246:248:src/sync-engine.ts
          if (manifest.db_template.pre_hydrate_sql) {
            await runSqliteScript(shadowStore, manifest.db_template.pre_hydrate_sql);
          }
```

**Remediation:** Reject/strip lines starting with `.` before `runSqliteScript`, or use Python `executescript` only for untrusted SQL. Validate `conversation_id` with `isSafeSegment` (prefer UUID) and assert `path.relative(chatsRoot, resolved)` containment.

---

## 5. `src/sync-engine-ops.ts` (127 lines)

### Role
Helpers: resolve live state DB paths, copy DB triple, WAL checkpoint, merge composer headers, run metadata SQL chunks.

### External / untrusted inputs
- `workspaceStorageFolderId` / `folderId` (callers usually validate via manifest parsers).
- `sqlChunks` passed to `runMetadataSqlOnShadowDb` (manifest-controlled when called from SyncEngine).
- `headerPayloads` merged into JSON then SQL-escaped.

### File system
`path.join(root, folderId, "state.vscdb")` — if `folderId` contains `..`, Node resolves outside workspaceStorage. Sync-manifest path validates with `isSafeSegment`; this helper itself does not.

### SQL / commands
`runMetadataSqlOnShadowDb` → `runSqliteScript` (see SYNC-1).  
`mergeComposerHeadersIntoDb` uses `escapeSqlLiteral` for JSON payload.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| OPS-1 | **Critical** (enabler) | `runMetadataSqlOnShadowDb` passes trimmed chunks unmodified into `runSqliteScript` — no meta-command filtering. |
| OPS-2 | Low | Exported `resolveWorkspaceStateDbPath(folderId)` trusts callers to sanitize `folderId`. |

```119:126:src/sync-engine-ops.ts
export async function runMetadataSqlOnShadowDb(dbPath: string, sqlChunks: string[]): Promise<void> {
  for (const chunk of sqlChunks) {
    const trimmed = chunk.trim();
    if (trimmed.length === 0) continue;
    await runSqliteScript(dbPath, trimmed.endsWith(";") ? trimmed : `${trimmed};\n`);
  }
}
```

---

## 6. `src/chat-import-activate.ts` (970 lines)

### Role
Post-import composer activation: stage `~/.cursor/import-activation/pending.json`, call IDE commands (`composer.createNew` / `openComposer`), optional Python bridge fallback.

### External / untrusted inputs
- Chat bundle / partial state (from gist or local import).
- `pending.json` on disk (also written by this module; readable/writable by other same-user processes).
- Bridge stdout JSON lines.

### File system
- Writes `pending.json` / `result.json` under `~/.cursor/import-activation/`.
- Temp manifest under `os.tmpdir()`.
- Reads state DBs for enrichment (`enrichManifestPartialStateFromDisk`).

### SQL
Via `repairComposerDataAfterActivation` / `readRichComposerDataEntryFromStateDb` (escaped keys).

### Command execution
```746:746:src/chat-import-activate.ts
      const proc = spawn("python3", args, { cwd: rawManifest.workspaceFolder });
```
Argv array (no shell). Script path from `resolveComposerBridgeScript`. `cwd` comes from manifest `workspaceFolder`.

### Deserialization
`JSON.parse` of pending/result/bridge stdout; `normalizeActivationManifest` on untrusted pending payloads.

### Authorization
No cryptographic integrity on pending manifests. Workspace match is enforced by the watcher (open folder must equal `workspaceFolder`).

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| ACT-1 | Medium | Activation manifests are unsigned files under the home directory. Any same-user process can drop a crafted `pending.json`; when the matching workspace is open, the watcher/`runComposerActivation` will invoke composer commands with attacker `partialState`. |
| ACT-2 | Low | Python bridge uses hardcoded `python3` (good vs workspace `pythonPath`), but `cwd` is attacker-influenced via pending/raw manifest. |
| ACT-3 | Info | `skipPythonBridge` default path prefers IDE commands — reduces reliance on Python for in-extension activation. |

---

## 7. `src/chat-import-activate-watcher.ts` (191 lines)

### Role
FileSystemWatcher on `pending.json`; auto-runs `runComposerActivation` when workspace matches.

### External / untrusted inputs
Whatever appears in `paths.pendingPath` (default `~/.cursor/import-activation/pending.json`).

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| WATCH-1 | Medium | Auto-processing amplifies ACT-1: create/change events debounce into activation without user confirmation beyond “workspace folder matches”. |

```84:100:src/chat-import-activate-watcher.ts
    if (!activationWorkspaceMatches(manifest.workspaceFolder, vscode.workspace.workspaceFolders)) {
      // log and return
    }
    const outcome = await runComposerActivation(manifest, runOptions);
```

**Remediation:** HMAC or extension-secret stamp on staged manifests; ignore pending files without a valid stamp; optionally require explicit user confirm for watcher-driven activation.

---

## 8. `src/store-template-hydrate.ts` (206 lines)

### Role
Copy golden `store.db` template and INSERT meta/blobs for a chat via SQL script.

### External / untrusted inputs
- `chat` content (titles, message text, `chat_id`).
- Bundle transcript lines (`JSON.parse` per line) when using `messagesFromChatBundle`.
- `templatePath` / `outputPath` (caller-controlled).

### SQL
Uses `escapeSqlLiteral` for meta JSON; blob payloads as hex (`X'...'`); blob ids are sha256 hex — structurally safe from quote injection.

### Command execution
Indirect via `runSqliteScript` (generated script is extension-built, not raw manifest SQL). Still depends on sqlite3 `.read` plumbing but content is escaped/hex.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| HYDR-1 | Cleared (SQL injection) | Literals escaped / hex-encoded. |
| HYDR-2 | High (caller-dependent) | `outputPath` is not contained here. When SyncEngine passes a path built from malicious `conversation_id`, hydration writes the escaped store outside chats root (see SYNC-2). |

---

## 9. `src/chat-import-merge.ts` (680 lines)

### Role
Merge composer headers / composerData into `state.vscdb`; repair after activation; prepare headers from bundle sidebar snapshots.

### External / untrusted inputs
- `ChatBundle` (gist/local), including `sidebarSnapshot.composerHeaders` / `composerData`.
- Existing DB JSON blobs.
- `conversationId` embedded in SQL keys (escaped).

### SQL
All dynamic values go through `escapeSqlLiteral`. Keys for diskKV use exact match (`key = '...'`), not `LIKE`.

### Command execution
Via `runSqliteScript` only with extension-generated scripts.

### Deserialization
Multiple `JSON.parse` paths on DB and bundle data; `Object.entries` filtering by conversation; `rebindComposerRecord` / `clearSessionBindingInTree`.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| MERGE-1 | Cleared (SQLi) | Escaping present for merged JSON. |
| MERGE-2 | Info | Trusts bundle sidebar shapes; integrity depends on upstream bundle validation. Prototype pollution in related `chat-partial-state.ts` remains a separate flagged issue (not this file’s merge loop). |
| MERGE-3 | Low | `mergeTargetsForImport` / `repairComposerDataAfterActivation` accept absolute `dbPath` from callers without re-validating location. |

---

## 10. `src/transcripts-import-execute.ts` (406 lines)

### Role
Orchestrates agent-transcript gist import (v1 + v2): fetch gist, map projects, build restore operations, preview/apply.

### External / untrusted inputs
- User gist URL/ID → `extractGistId` (hex 20/32).
- Gist file names, contents, `transcript-manifest.json`.
- Manifest `conversationId`, `sourceRelativePath`, project keys, artifact metadata.
- Workspace mapping choices (prompted; segments validated in plan helpers).

### File system
Builds write targets then hands to `previewAndApplyImportPlan` (mkdir + write):

**v1:**
```197:201:src/transcripts-import-execute.ts
      absolutePath: path.join(
        targetProject.fullPath,
        "agent-transcripts",
        ...relativeInProject.split("/")
      ),
```
`relativeInProject` derived from gist sync keys — `../` segments escape the project tree.

**v2:** `resolveArtifactImportPath` (in `transcripts-import-sidebar.ts`) joins `conversationId` / `sourceRelativePath` without `isSafeSegment` or post-join containment.

Verified resolutions:
- v1 `relativeInProject=../../../.bashrc` → `~/.cursor/.bashrc`
- store kind `conversationId=../../tmp/evil` → `~/.cursor/tmp/evil/store.db`

### SQL / commands
None directly in this file.

### Deserialization
`parseTranscriptBundleManifest`; artifact decode.

### Authorization
Requires configured token for private gists; user confirms mapping / selection. Confirmation does **not** prove paths stay under intended roots.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| TX-1 | **High** | Path traversal / arbitrary file write via untrusted conversation IDs and relative paths in gist manifests (reconfirmed; execute path is the orchestrator). |

**Remediation:** Reject IDs/paths with separators or `..`; after join, require `path.relative(root, resolved)` containment for projects root and chats root.

---

## 11. `src/chat-disk-kv-export.ts` (186 lines)

### Role
Export `cursorDiskKV` rows for a conversation into a bundle snapshot; optional Python enrichment.

### External / untrusted inputs
- `conversationId` from bundles.
- Row values from SQLite (parsed as JSON for tool-bubble counting).

### SQL
```61:65:src/chat-disk-kv-export.ts
function diskKvKeysSql(conversationId: string): string {
  const prefixBubble = escapeSqlLiteral(`bubbleId:${conversationId}:`);
  const keyComposer = escapeSqlLiteral(`composerData:${conversationId}`);
  return `SELECT key FROM cursorDiskKV WHERE key = '${keyComposer}' OR key LIKE '${prefixBubble}%';`;
}
```
Quotes are escaped; **LIKE wildcards `%` and `_` inside `conversationId` are not escaped**.

### Command execution
May call `runPythonExportDiskKvSnapshot` (argv-based) when TS export finds no rows but bubbles exist.

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| DKV-1 | Medium | Attacker-controlled `conversationId` containing `%`/`_` can broaden the LIKE match and pull other conversations’ keys into an export snapshot (confidentiality). Also conflicts with guidance to avoid prefix `LIKE` scans on potentially corrupt global DBs (availability / integrity risk). |
| DKV-2 | Cleared (SQLi quotes) | `escapeSqlLiteral` prevents classic quote breakout. |

**Remediation:** Require UUID `conversationId` before querying; escape LIKE wildcards (`\`%`, `\_`) or use only exact-key / `key IN (...)` lookups.

---

## 12. `src/state-reconciliation.ts` (306 lines)

### Role
Prepare/finalize atomic replacement of live `state.vscdb` and chat stores from shadow copies; chats.json import path uses UUID-validated `chat_id`.

### External / untrusted inputs
- User-picked `chats.json` (validated by `parseChatsManifestJson` — UUID chat ids, safe workspace key).
- Pending bundle JSON on disk between prepare and finalize.

### File system
Prepare writes under extension globalStorage. Finalize copies `bundle.stateVscdbShadow` → `bundle.stateVscdbLive` and each `storeReplacements` pair **with no path containment check** on the deserialized paths.

### SQL
Header merge / hydrate only (escaped); no raw manifest SQL on this path (safer than SyncEngine).

### Findings

| ID | Severity | Finding |
|----|----------|---------|
| SR-1 | Cleared (prepare path traversal) | `chat_id` UUID-validated — unlike SyncEngine’s `conversation_id`. |
| SR-2 | Medium | Finalize trusts `livePath` / `shadowPath` / `stateVscdbLive` from `pending-state-bundle.json`. Confirmation UI does not list concrete destinations. A tampered pending bundle (same-user write to globalStorage) can overwrite arbitrary files when the user clicks “Replace”. |
| SR-3 | Info | Rollback-on-failure via `createBackup` / `rollbackFromBackup` is good for integrity of intended targets, not for blocking malicious destinations. |

```263:286:src/state-reconciliation.ts
  const confirm = await vscode.window.showWarningMessage(
    "Replace live state.vscdb and chat store files from the pending shadow copies? Backups will be created first.",
    { modal: true },
    "Replace"
  );
  // ...
  await replaceFileWithRetries(bundle.stateVscdbShadow, bundle.stateVscdbLive);
  for (const pair of bundle.storeReplacements) {
    await fs.mkdir(path.dirname(pair.livePath), { recursive: true });
    await replaceFileWithRetries(pair.shadowPath, pair.livePath);
  }
```

**Remediation:** On finalize, re-resolve allowed roots and reject any live path outside Cursor user/chats/globalStorage trees; show the path list in the confirm dialog; optionally HMAC the pending bundle at prepare time.

---

## Cross-cutting dependency (out of file list but required for SYNC-1)

`src/transcripts-sqlite.ts` `runSqliteScript`:

```196:204:src/transcripts-sqlite.ts
export async function runSqliteScript(dbPath: string, script: string): Promise<void> {
  // writes script to temp file
  await execFile("sqlite3", [dbPath, `.read ${tmpPath}`], execOpts);
```

This is the RCE sink for SyncEngine metadata / pre-hydrate SQL.

---

## Recommended fix order

1. **Critical:** Sanitize or avoid sqlite3 `.read` for untrusted SQL (`state_vscdb_sql`, `pre_hydrate_sql`).
2. **High:** `isSafeSegment` / UUID + post-join containment for all conversation/chat path segments (sync-engine, transcript import, chat bundle restore).
3. **High / Medium:** Default-deny extension auto-install and settings-injection issues tracked in prior audits (outside this file list but still open).
4. **Medium:** Pending-bundle and pending-activation integrity (HMAC + path allowlists).
5. **Medium:** Escape LIKE wildcards or ban non-UUID ids in diskKV export.

---

## Relationship to prior flagged inventory

Still **active** and in-scope for this pass:
- Critical RCE via `runSqliteScript` / sync manifest SQL
- High path traversal via unsanitized `conversation_id` in sync-engine
- High path traversal in transcript gist import

Newly documented in this scoped pass:
- Activation pending.json auto-exec (ACT-1 / WATCH-1)
- Finalize pending-bundle path trust (SR-2)
- diskKv LIKE wildcard widening (DKV-1)
