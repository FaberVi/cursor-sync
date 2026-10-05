# Cursor Sync

VS Code/Cursor extension (publisher FaberVi, extension id `fabervi.cursor-sync`) that syncs user-level Cursor settings and selected `~/.cursor` assets to a private GitHub repository. Gist destination was removed in 2.0.0.

The local clone is `ExtensionContext.globalStorageUri/sync-repo`. On Windows that is `%APPDATA%\Cursor\User\globalStorage\fabervi.cursor-sync\sync-repo`. Synced files sit under `cursorSync.destination.path` (default `cursor-sync`): `{base}/cursor-user/`, `{base}/dot-cursor/`, `{base}/manifest.json`, and `{base}/cursor-chat.json`. Skill folders on disk are `~/.cursor/skills/<name>` (sync key `dot-cursor/skills/<name>`).

This extension writes real user files. Treat every sync change as potentially destructive.

## Commands

Use pnpm. Node 20+, Git on PATH, VS Code/Cursor `^1.128.0`.

```bash
pnpm install
pnpm run build
pnpm run lint
pnpm test
pnpm run package
```

`pnpm run lint` is `tsc --noEmit`. Tests are Vitest. The sidebar is a webview (`src/sidebar/`) with Sync, Chats, and Settings. `refreshSidebar()` updates that webview only, not Cursor's native Composer history.

`extension.ts` stays thin: register commands, wire modules, start background work. Put behavior in the module that already owns it.

## Repo workflow

- Do not commit or push unless the user asks. When they ask to commit and push, open a pull request instead of pushing the default branch.
- Maintenance commits: update `CHANGELOG.md` and `package.json` together, in phased semver commits. If the version was not bumped for the change set, ask before releasing. Keep `pnpm-lock.yaml` aligned with `package.json`.
- Do not stage `docs/` unless the user asks. `docs/superpowers/specs/` and `docs/superpowers/plans/` are gitignored. Shipped docs live under `docs/` (for example `docs/chat-import-activate.md`). `package-vsix.sh` is tracked.
- Paths must work on Windows, macOS, and Linux. On Windows the shell is PowerShell 5.x: do not chain commands with `&&`.

## Sync safety

Never silently drop user data. Keep rollback, conflict handling, checksums, and manifest compatibility. A change that overwrites local files follows the existing confirm path.

- Tokens stay in SecretStorage. Do not print, log, or put them in `settings.json` or telemetry.
- Push copies the machine into the clone, then deletes clone files that are not on disk. A skill directory that is **missing** is a real deletion and will be published. An **empty** skill directory is a vacant shell: `restoreVacantSkillFoldersFromClone` refills it from the clone before push or pull. Do not skip that restore.
- A file directly in `skills/` (for example `operations.json`) is a file, not a skill folder.
- On replace, clear the skill folder's children and write the clone files back. Do not `rm` the skill directory itself. Record the skill-folder backup on the sync journal before clearing, so a failure midway can restore it. On Windows an open directory handle deletes the contents, then fails the rmdir, and the write-back never runs. A local-only skill whose empty directory cannot be removed stays in place and the pull continues.
- Windows lock recovery uses Restart Manager on files only (not the directory, not junctions), in batches. It may close the process that holds a file after checking the live image. Never kill Cursor, VS Code, this extension host, or Windows session processes (`svchost`, `csrss`, `lsass`, and the other critical images).

## Chats

Native chat JSON is the transport since v0.8.0: `version: 1`, `conversationState` + `blobs`, optional `storeDb`. The file in the clone is `{base}/cursor-chat.json` (sync key `dot-cursor/cursor-chat.json`). Encryption (`cursorSync.chats.encrypt`, Argon2id + AES-256-GCM) wraps that JSON. Reject legacy ChatBundle (`schemaVersion` / `type: chat-persistence`).

- Do not call `developer.importChat` or `developer.bulkImportChats`. Import through storage. In a running IDE, register with `composer.createNew` (one options object). `composer.createComposer` is not a command. Call `createNew` only when `partialState` has real content (`conversationMap` or `fullConversationHeadersOnly`). Empty `partialState` wipes a disk-restored chat. Never put a base64 `conversationState` string in `partialState`.
- Do not purge per-conversation `cursorDiskKV` rows on import.
- Imported chats are synthetic on the destination workspace: clear bubble `requestId`, rebind `workspaceIdentifier`, stamp current timestamps. Do not keep a Request ID.
- Composer UI reads `composerData.fullConversationHeadersOnly` plus `bubbleId:<composerId>:<uuid>` rows. On-disk `conversationMap` is often empty. Look up `cursorDiskKV` by exact key or `key IN (...)`, never `LIKE 'prefix%'`. If the global DB fails `integrity_check`, write the workspace DB instead.
- Default hydration is TypeScript protobuf (`cursorSync.chatImport.useProtobufHydration`). The map must be non-empty. After activation, re-persist hydrated state when the IDE clobbers `composerData`.
- Local chat-bundle import must not prompt or auto-run Reload Window. Transcript import may still offer reload when `cursorSync.transcripts.autoReloadAfterImport` is set or the user chooses it.
- `queueSidebarWriteback` stages native sidebar rows in `~/.cursor/import-activation/sidebar-pending/` and flushes them on activate. Do not flush that queue before an autoreload.

## Before finishing

Build, lint, and the tests that cover the change. Update `CHANGELOG.md` when behavior changes. Do not commit secrets, weaken confirmations, or reformat unrelated code.

## Learned User Preferences

- Do not commit or push without an explicit ask. A requested commit-and-push opens a pull request instead of pushing the default branch.
- Package maintenance uses phased semver commits, `CHANGELOG.md`, and `package.json`. Ask before releasing when the version was not bumped.
- Do not stage `docs/` unless asked. `docs/superpowers/` is gitignored.
- Use pnpm for package operations.
- Refresh this file via continual-learning only when asked.

## Learned Workspace Facts

- Sync destination is a GitHub repository. The clone is `%APPDATA%\Cursor\User\globalStorage\fabervi.cursor-sync\sync-repo` on Windows, under `cursorSync.destination.path` (default `cursor-sync`). Gists are not a destination.
- Skill replace must not remove the skill directory. Push treats a missing skill directory as a deletion and an empty one as vacant, and refills the vacant one from the clone first.
- Chat sync is native JSON (`cursor-chat.json`). ChatBundle is rejected. Import constraints are in the Chats section above.
