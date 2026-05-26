## Learned User Preferences

- Do not run `git commit` or `git push` without explicit permission; when asked to commit and push, open a pull request instead of pushing directly to the default branch.
- For npm-package maintenance in this repo: split uncommitted work into phased semver commits, update `CHANGELOG.md` and `package.json`, and ask before releasing if the version was not bumped for the change set.
- During maintenance commits, do not stage `docs/` unless the user explicitly asks; leave `package-vsix.sh` untracked unless they ask to include it.
- User often starts work with `/light-prompt` for a tight structured prompt (~200 tokens) and uses parallel swarms for multi-part implementation or research.
- For chat transport across machines or repos (often the `bergamota` workspace), use the Cursor Sync extension **Chats** sidebar—not the deprecated `/transport-chat` skill workflow (standalone `~/.cursor/skills/transport-chat` removed in v0.7.0).
- For substantial features, use superpowers brainstorming then writing-plans; store specs and plans under `docs/superpowers/`.
- Refreshes `AGENTS.md` via continual-learning and the agents-memory-updater subagent when asked.
- Prefer concise, high-quality English responses; do not use emojis.

## Learned Workspace Facts

- `cursor-sync` is a VS Code extension (publisher MarceloBarella) that syncs Cursor user config and selected `~/.cursor` assets to a private GitHub Gist.
- Chat export/import is built into the extension: Python scripts live under `resources/transport-chat/scripts/` (bundled in the VSIX since v0.7.0; no separate skill install).
- Opening imported chats is a two-phase flow: disk restore (transcripts, `store.db`, workspace/global `state.vscdb`) then IDE activation via `composer.*` APIs; see `docs/chat-import-activate.md`.
- Cursor chat persistence spans four layers: JSONL transcripts, `store.db`, workspace/global `state.vscdb` (sidebar), and `cursorDiskKV` (Composer UI); tool/MCP UI fidelity depends on `cursorDiskKV`, not JSONL alone.
- Feature specs and implementation plans for this repo live under `docs/superpowers/specs/` and `docs/superpowers/plans/`.
- `cursor-detective` is a personal read-only forensics skill at `~/.cursor/skills/cursor-detective/` (explicit `/cursor-detective`); design spec in-repo, not shipped in the extension VSIX.
- Git and release workflow for this repo is defined in `.cursor/rules/git.mdc`.
- Keep `package-lock.json` version aligned with `package.json` on releases; `.worktrees` belongs in `.gitignore`.
- Sidebar UX is webview-based with Sync, Chats, and Settings tabs (`src/sidebar/`).
