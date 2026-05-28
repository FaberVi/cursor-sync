#!/usr/bin/env python3
"""
End-to-end transport-chat workflow (Gates 1–4).

Wraps cursor_chat_io.py: resolve workspaces, pick conversations, backup global state,
export bundle, Phase A disk import, Phase B activation, verify.

All paths default to ~/.cursor/skills/transport-chat/scripts/.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

from cursor_chat_io import (  # noqa: E402
    ACTIVATION_RESULT_PATH,
    build_bundle,
    cursor_config_root,
    discover_conversations,
    expected_tool_bubble_count_from_bundle,
    first_user_text,
    import_bundle,
    md5_folder_key,
    projects_root,
    resolve_workspace_context,
    verify_activation_checks,
    verify_checks_all_ok,
    verify_import_visibility,
)
GLOBAL_BACKUP_NAME = "state.vscdb.sync.backup"
USER_QUERY_RE = re.compile(r"<user_query>\s*(.*?)(?:</user_query>|$)", re.DOTALL)


@dataclass
class WorkspaceResolved:
    folder_fs_path: str
    workspace_storage_id: str
    state_db: Path
    project_key: str


def folder_to_project_key(folder_fs_path: str) -> str:
    p = Path(folder_fs_path).expanduser().resolve()
    return str(p).replace("\\", "/").strip("/").replace("/", "-")


def state_db_path(workspace_storage_id: str) -> Path:
    return (
        cursor_config_root()
        / "workspaceStorage"
        / workspace_storage_id
        / "state.vscdb"
    )


def resolve_workspace(folder: str, state_db: Path | None = None) -> WorkspaceResolved:
    ctx = resolve_workspace_context(state_db, folder)
    if ctx is None:
        raise SystemExit(
            f"Could not resolve workspace for {folder!r}. "
            "Open that folder in Cursor once, then retry."
        )
    db = state_db or state_db_path(ctx.workspace_storage_id)
    if not db.is_file():
        raise SystemExit(f"Missing workspace state DB: {db}")
    return WorkspaceResolved(
        folder_fs_path=ctx.folder_fs_path,
        workspace_storage_id=ctx.workspace_storage_id,
        state_db=db,
        project_key=folder_to_project_key(ctx.folder_fs_path),
    )


def preview_text(jsonl_path: Path) -> str:
    try:
        raw = jsonl_path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return "(unreadable)"
    for line in raw.splitlines()[:80]:
        m = USER_QUERY_RE.search(line)
        if m:
            return m.group(1).strip()[:100].replace("\n", " ")
    hint = first_user_text(jsonl_path)
    if hint.startswith("<manually_attached"):
        return "(skills attached; open transcript for full prompt)"
    return hint[:100] if hint else "(no preview)"


def transcript_mtime(project_key: str, conversation_id: str) -> float:
    d = projects_root() / project_key / "agent-transcripts" / conversation_id
    if not d.is_dir():
        return 0.0
    mt = 0.0
    for jf in d.glob("*.jsonl"):
        mt = max(mt, jf.stat().st_mtime)
    return mt


def pick_conversations(
    *,
    project_key: str | None = None,
    workspace_folder: str | None = None,
    grep: str | None = None,
    limit: int = 15,
) -> list[tuple[float, str, str, str]]:
    if workspace_folder and not project_key:
        project_key = folder_to_project_key(workspace_folder)
    rows: list[tuple[float, str, str, str]] = []
    for ref in discover_conversations():
        if project_key and ref.project_key != project_key:
            continue
        if grep and grep.lower() not in (ref.project_key or "").lower():
            if grep.lower() not in ref.title_hint.lower():
                if grep.lower() not in ref.conversation_id.lower():
                    continue
        pk = ref.project_key or "-"
        mtime = transcript_mtime(pk, ref.conversation_id) if pk != "-" else 0.0
        prev = ref.title_hint[:100]
        if pk != "-":
            jfs = list(
                (projects_root() / pk / "agent-transcripts" / ref.conversation_id).glob(
                    "*.jsonl"
                )
            )
            if jfs:
                prev = preview_text(jfs[0])
        rows.append((mtime, ref.conversation_id, pk, prev))
    rows.sort(key=lambda r: r[0], reverse=True)
    return rows[:limit]


def cmd_pick(args: argparse.Namespace) -> None:
    rows = pick_conversations(
        project_key=args.project_key,
        workspace_folder=args.workspace_folder,
        grep=args.grep,
        limit=args.limit,
    )
    if not rows:
        print("No conversations found for filters.", file=sys.stderr)
        raise SystemExit(1)
    for mtime, cid, pk, prev in rows:
        ts = (
            datetime.fromtimestamp(mtime).strftime("%Y-%m-%d %H:%M")
            if mtime
            else "no-transcript"
        )
        print(f"{ts}  {cid}  [{pk}]")
        print(f"  {prev[:90]}")


def backup_global_state() -> Path:
    global_dir = cursor_config_root() / "globalStorage"
    src = global_dir / "state.vscdb"
    dst = global_dir / GLOBAL_BACKUP_NAME
    if not src.is_file():
        raise SystemExit(f"Missing global state: {src}")
    shutil.copy2(src, dst)
    return dst


def cursor_running() -> bool:
    try:
        r = subprocess.run(
            ["pgrep", "-x", "cursor"],
            capture_output=True,
            timeout=5,
        )
        if r.returncode == 0:
            return True
    except (OSError, subprocess.TimeoutExpired):
        pass
    try:
        r = subprocess.run(
            ["pgrep", "-f", "cursor.AppImage"],
            capture_output=True,
            timeout=5,
        )
        return r.returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def run_transport(args: argparse.Namespace) -> None:
    src = resolve_workspace(args.source)
    dest = resolve_workspace(args.destination)
    bundle_path = Path(args.bundle).expanduser() if args.bundle else None
    if bundle_path is None:
        bundle_path = Path(f"/tmp/chat-transport-{args.conversation_id}.json")

    print("=== Transport chat ===", file=sys.stderr)
    print(f"Source:      {src.folder_fs_path}", file=sys.stderr)
    print(f"  project:   {src.project_key}", file=sys.stderr)
    print(f"  state-db:  {src.state_db}", file=sys.stderr)
    print(f"Destination: {dest.folder_fs_path}", file=sys.stderr)
    print(f"  project:   {dest.project_key}", file=sys.stderr)
    print(f"  state-db:  {dest.state_db}", file=sys.stderr)
    print(f"Conversation: {args.conversation_id}", file=sys.stderr)
    print(f"Bundle:      {bundle_path}", file=sys.stderr)

    if not args.skip_backup:
        dst = backup_global_state()
        print(f"[OK] Global backup -> {dst}", file=sys.stderr)

    if cursor_running() and not args.allow_cursor_running:
        print(
            "Warning: Cursor is running; global sidebar merge may not stick during Phase A.",
            file=sys.stderr,
        )

    print("--- Export ---", file=sys.stderr)
    bundle, warnings = build_bundle(args.conversation_id, src.state_db)
    bundle_path.parent.mkdir(parents=True, exist_ok=True)
    bundle_path.write_text(json.dumps(bundle, indent=2), encoding="utf-8")
    for w in warnings:
        print(f"  warning: {w}", file=sys.stderr)
    print(f"[OK] Exported -> {bundle_path}", file=sys.stderr)

    print("--- Phase A: disk import ---", file=sys.stderr)
    if not args.skip_phase_a:
        import_bundle(
            bundle_path,
            dest.project_key,
            None,
            dest.state_db,
            args.dry_run,
            pin_recent=not args.no_pin_recent,
            workspace_folder=dest.folder_fs_path,
            sync_global=not args.no_global_state,
            activate=False,
            activate_strict=False,
            ping_server=False,
            bridge_wait_result=0.0,
        )
        if not args.dry_run:
            ctx = resolve_workspace_context(dest.state_db, dest.folder_fs_path)
            if ctx is None:
                raise SystemExit("verify: could not resolve destination after import")
            store_snap = bundle.get("storeSnapshot") or {}
            checks = verify_import_visibility(
                args.conversation_id,
                ctx,
                expect_rich_composer_data=False,
                expect_store=bool(store_snap.get("content")),
                expected_tool_bubble_count=expected_tool_bubble_count_from_bundle(
                    bundle
                ),
            )
            for c in checks:
                print(c.format_line(), file=sys.stderr)
            if not verify_checks_all_ok(checks):
                print(
                    "Phase A verify had failures (global merge often fails while Cursor runs).",
                    file=sys.stderr,
                )

    if args.disk_only:
        print("Disk-only transport complete (skipped Phase B).", file=sys.stderr)
        return

    print("--- Phase B: activation ---", file=sys.stderr)
    if not cursor_running():
        print(
            "Warning: Cursor does not appear to be running; activation will stage only.",
            file=sys.stderr,
        )
    import_bundle(
        bundle_path,
        dest.project_key,
        None,
        dest.state_db,
        False,
        pin_recent=not args.no_pin_recent,
        workspace_folder=dest.folder_fs_path,
        sync_global=not args.no_global_state,
        activate=True,
        activate_strict=args.activate_strict,
        ping_server=False,
        bridge_wait_result=float(args.bridge_wait_result),
    )

    if not args.dry_run:
        ctx = resolve_workspace_context(dest.state_db, dest.folder_fs_path)
        if ctx is None:
            raise SystemExit("post-activate verify: could not resolve destination")
        store_snap = bundle.get("storeSnapshot") or {}
        checks = verify_import_visibility(
            args.conversation_id,
            ctx,
            expect_rich_composer_data=False,
            expect_store=bool(store_snap.get("content")),
            expected_tool_bubble_count=expected_tool_bubble_count_from_bundle(bundle),
        )
        checks.extend(verify_activation_checks(args.conversation_id))
        for c in checks:
            print(c.format_line(), file=sys.stderr)
        activation_ok = any(
            c.name == "activation.result" and c.status == "OK" for c in checks
        )
        if activation_ok:
            print("[OK] Transport complete (activation confirmed).", file=sys.stderr)
        else:
            print(
                "Activation PENDING: open destination workspace, enable Cursor Sync, "
                "run Command Palette → Cursor Sync: Import Chat Bundle (Activate) "
                f"with bundle {bundle_path}, then Reload Window.",
                file=sys.stderr,
            )
            if ACTIVATION_RESULT_PATH.is_file():
                print(f"  result.json: {ACTIVATION_RESULT_PATH}", file=sys.stderr)
            if args.activate_strict:
                raise SystemExit(1)


def cmd_resolve_print(args: argparse.Namespace) -> None:
    ws = resolve_workspace(args.workspace_folder)
    print(
        json.dumps(
            {
                "folderFsPath": ws.folder_fs_path,
                "workspaceStorageId": ws.workspace_storage_id,
                "stateDb": str(ws.state_db),
                "projectKey": ws.project_key,
                "chatsWorkspaceKey": md5_folder_key(ws.folder_fs_path),
            },
            indent=2,
        )
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Transport a Cursor chat between workspaces (full import-v2 workflow).",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_pick = sub.add_parser("pick", help="List recent conversations for a workspace/project")
    p_pick.add_argument("--workspace-folder", help="Absolute source or dest workspace path")
    p_pick.add_argument(
        "--project-key",
        help="~/.cursor/projects/<name> folder (overrides --workspace-folder mapping)",
    )
    p_pick.add_argument("--grep", "-g", help="Filter project key / preview / UUID")
    p_pick.add_argument("--limit", type=int, default=15)
    p_pick.set_defaults(func=cmd_pick)

    p_res = sub.add_parser("resolve", help="Resolve workspace to state-db + project key JSON")
    p_res.add_argument("--workspace-folder", required=True)
    p_res.set_defaults(func=cmd_resolve_print)

    p_bak = sub.add_parser("backup-global", help="Copy global state.vscdb to .sync.backup")
    def _backup(_: argparse.Namespace) -> None:
        print(backup_global_state())

    p_bak.set_defaults(func=_backup)

    p_run = sub.add_parser("run", help="Full transport: backup, export, Phase A, Phase B")
    p_run.add_argument("--source", required=True, help="Absolute source workspace folder")
    p_run.add_argument("--destination", required=True, help="Absolute destination workspace folder")
    p_run.add_argument("--conversation-id", required=True, help="UUID to transport")
    p_run.add_argument("-o", "--bundle", help="Bundle JSON path (default /tmp/chat-transport-<uuid>.json)")
    p_run.add_argument("--disk-only", action="store_true", help="Skip Phase B activation")
    p_run.add_argument("--skip-backup", action="store_true")
    p_run.add_argument("--skip-phase-a", action="store_true")
    p_run.add_argument("--dry-run", action="store_true")
    p_run.add_argument("--no-pin-recent", action="store_true")
    p_run.add_argument("--no-global-state", action="store_true")
    p_run.add_argument("--allow-cursor-running", action="store_true")
    p_run.add_argument("--activate-strict", action="store_true")
    p_run.add_argument("--bridge-wait-result", type=float, default=30.0)
    p_run.set_defaults(func=run_transport)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
