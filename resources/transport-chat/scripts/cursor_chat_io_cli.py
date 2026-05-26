"""CLI entrypoints for cursor_chat_io (cursor_chat_io split module)."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

from cursor_chat_io_common import *
from cursor_chat_io_bundle import build_bundle
from cursor_chat_io_import import import_bundle, verify_activation_checks

def cmd_list(_: argparse.Namespace) -> None:
    refs = discover_conversations()
    if not refs:
        print("No conversations found.")
        return
    print(f"{'ID':<38} {'transcript':<10} {'store':<6} {'project / workspace'}")
    for r in refs:
        proj = r.project_key or "-"
        ws = r.store_workspace_key or "-"
        extra = proj if r.has_transcript else ws
        print(
            f"{r.conversation_id}  "
            f"{'yes' if r.has_transcript else 'no':<10} "
            f"{'yes' if r.has_store else 'no':<6} "
            f"{extra}  {r.title_hint[:50]}"
        )


def cmd_export(args: argparse.Namespace) -> None:
    state_db = Path(args.state_db).expanduser() if args.state_db else None
    bundle, warnings = build_bundle(args.conversation_id, state_db)
    out = Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bundle, indent=2), encoding="utf-8")
    print(f"Exported bundle -> {out}")
    print(
        f"  transcripts={len(bundle.get('transcriptFiles') or [])} "
        f"store={'yes' if bundle.get('storeSnapshot') else 'no'} "
        f"sidebar={'yes' if bundle.get('sidebarSnapshot') else 'no'}"
    )
    for w in warnings:
        print(f"  warning: {w}", file=sys.stderr)


def cmd_verify(args: argparse.Namespace) -> None:
    bundle_path = Path(args.bundle).expanduser() if args.bundle else None
    bundle: dict[str, Any] | None = None
    if bundle_path and bundle_path.is_file():
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        cid = bundle["conversationId"]
    else:
        cid = args.conversation_id
    if not cid:
        raise SystemExit("Pass --bundle or --conversation-id")
    if not args.workspace_folder or not str(args.workspace_folder).strip():
        print(
            "error: --workspace-folder is required for verify (expected fsPath match)",
            file=sys.stderr,
        )
        raise SystemExit(1)
    ws_ctx = resolve_workspace_context(
        Path(args.state_db).expanduser() if args.state_db else None,
        args.workspace_folder,
    )
    if ws_ctx is None:
        raise SystemExit(
            f"Could not resolve workspace for --workspace-folder {args.workspace_folder!r}"
        )
    expect_rich = (
        sidebar_snapshot_has_composer_data(bundle, cid)
        if bundle is not None
        else False
    )
    expect_store = bool(bundle and bundle.get("storeSnapshot", {}).get("content"))
    checks = verify_import_visibility(
        cid,
        ws_ctx,
        expect_rich_composer_data=expect_rich,
        expect_store=expect_store,
    )
    if args.post_activate:
        checks.extend(verify_activation_checks(cid))
    print_verify_report(checks, json_lines=args.json_lines)
    if not verify_checks_all_ok(checks):
        raise SystemExit(1)


def cmd_import(args: argparse.Namespace) -> None:
    import_bundle(
        Path(args.bundle).expanduser(),
        args.target_project,
        args.target_workspace,
        Path(args.state_db).expanduser() if args.state_db else None,
        args.dry_run,
        pin_recent=not args.no_pin_recent,
        workspace_folder=args.workspace_folder,
        sync_global=not args.no_global_state,
        activate=args.activate,
        activate_strict=args.activate_strict,
        ping_server=args.ping_server,
        bridge_wait_result=max(0.0, float(args.bridge_wait_result)),
    )


def cmd_inspect(args: argparse.Namespace) -> None:
    bundle = json.loads(Path(args.bundle).expanduser().read_text(encoding="utf-8"))
    print(json.dumps({k: bundle.get(k) for k in (
        "schemaVersion", "type", "createdAt", "conversationId", "title",
        "subtitle", "previewText",
    )}, indent=2))
    tfs = bundle.get("transcriptFiles") or []
    print(f"transcriptFiles: {len(tfs)}")
    for tf in tfs[:20]:
        print(f"  - {tf.get('relativePath')} ({tf.get('sizeBytes')} bytes)")
    if len(tfs) > 20:
        print(f"  ... and {len(tfs) - 20} more")
    store = bundle.get("storeSnapshot")
    if store:
        print(
            f"storeSnapshot: {store.get('sizeBytes')} bytes, "
            f"workspace={store.get('sourceWorkspaceKey')}"
        )
    side = bundle.get("sidebarSnapshot")
    if isinstance(side, dict):
        keys = sorted(side.keys())
        print(f"sidebarSnapshot keys: {', '.join(keys)}")


def cmd_paths(args: argparse.Namespace) -> None:
    print("projects_root:", projects_root())
    print("chats_root:", chats_root())
    print("cursor_config:", cursor_config_root())
    print("state_db candidates:")
    for p in list_state_db_candidates():
        print(" ", p)
    folder = getattr(args, "workspace_folder", None)
    if folder:
        ctx = resolve_workspace_context(workspace_folder=folder)
        if ctx:
            print("\nresolved for --workspace-folder:")
            print("  folder:", ctx.folder_fs_path)
            print("  chats key (store.db):", ctx.chats_workspace_key)
            print("  workspaceStorage id (typical):", ctx.workspace_storage_id)


def cmd_resolve(args: argparse.Namespace) -> None:
    state_db = Path(args.state_db).expanduser() if args.state_db else None
    ctx = resolve_workspace_context(state_db, args.workspace_folder)
    if not ctx:
        raise SystemExit("Could not resolve workspace (pass --state-db or --workspace-folder).")
    print(json.dumps(
        {
            "folderFsPath": ctx.folder_fs_path,
            "chatsWorkspaceKey": ctx.chats_workspace_key,
            "workspaceStorageId": ctx.workspace_storage_id,
            "workspaceIdentifier": ctx.workspace_identifier,
            "suggestedImport": (
                f"python3 scripts/cursor_chat_io.py import <bundle.json> "
                f"--state-db ~/.config/Cursor/User/workspaceStorage/"
                f"{ctx.workspace_storage_id}/state.vscdb "
                f"--workspace-folder {ctx.folder_fs_path}"
            ),
        },
        indent=2,
    ))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export/import Cursor agent chats offline (cursor-sync ChatBundle format).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List known conversation IDs on this machine")
    p_list.set_defaults(func=cmd_list)

    p_paths = sub.add_parser("paths", help="Print resolved Cursor data paths")
    p_paths.add_argument("--workspace-folder", help="Show md5 chats key for this folder")
    p_paths.set_defaults(func=cmd_paths)

    p_res = sub.add_parser(
        "resolve",
        help="Print chats store key + workspaceStorage id for import (from --state-db or --workspace-folder)",
    )
    p_res.add_argument("--state-db", help="Path to workspaceStorage/.../state.vscdb")
    p_res.add_argument("--workspace-folder", help="Absolute path to opened workspace folder")
    p_res.set_defaults(func=cmd_resolve)

    p_exp = sub.add_parser("export", help="Export one conversation to a JSON bundle")
    p_exp.add_argument("conversation_id", help="UUID folder name")
    p_exp.add_argument("-o", "--output", required=True, help="Output .json path")
    p_exp.add_argument("--state-db", help="Explicit state.vscdb for sidebar snapshot")
    p_exp.set_defaults(func=cmd_export)

    p_imp = sub.add_parser("import", help="Import a JSON bundle")
    p_imp.add_argument("bundle", help="Bundle .json path")
    p_imp.add_argument("--target-project", help="Remap source project key to this projects/ folder name")
    p_imp.add_argument("--target-workspace", help="Restore store.db under this ~/.cursor/chats/ key")
    p_imp.add_argument("--state-db", help="state.vscdb to merge composer.* into")
    p_imp.add_argument(
        "--workspace-folder",
        required=True,
        help="Required: opened repo path; sets store.db chats key (md5) and workspaceIdentifier",
    )
    p_imp.add_argument("--dry-run", action="store_true", help="Show planned writes only")
    p_imp.add_argument(
        "--no-pin-recent",
        action="store_true",
        help="Keep original lastUpdatedAt instead of bumping to top of sidebar",
    )
    p_imp.add_argument(
        "--no-global-state",
        action="store_true",
        help="Do not merge into globalStorage/state.vscdb (not recommended)",
    )
    p_imp.add_argument(
        "--activate",
        action="store_true",
        help=(
            "After disk restore, build partialState and run cursor_composer_bridge.py "
            "(requires Cursor open on --workspace-folder)"
        ),
    )
    p_imp.add_argument(
        "--activate-strict",
        action="store_true",
        help="Fail import if bridge exits 2 (staged only, no hook/CLI activation)",
    )
    p_imp.add_argument(
        "--ping-server",
        action="store_true",
        help="Optional agentClient probe (v1 stub: logs not implemented)",
    )
    p_imp.add_argument(
        "--bridge-wait-result",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help=(
            "With --activate, pass --wait-result to the bridge "
            "(poll ~/.cursor/import-activation/result.json)"
        ),
    )
    p_imp.set_defaults(func=cmd_import)

    p_ver = sub.add_parser("verify", help="Check whether an import should appear in the sidebar")
    p_ver.add_argument("--bundle", help="Bundle JSON (uses conversationId from it)")
    p_ver.add_argument("--conversation-id", help="Conversation UUID")
    p_ver.add_argument("--state-db", help="Workspace state.vscdb used for import")
    p_ver.add_argument(
        "--workspace-folder",
        required=True,
        help="Required: expected workspace folder path (fsPath match)",
    )
    p_ver.add_argument(
        "--json-lines",
        action="store_true",
        help="Emit verify report as JSON lines instead of [OK]/[FAIL] labels",
    )
    p_ver.add_argument(
        "--post-activate",
        action="store_true",
        help=(
            "Include activation checks (pending.json, result.json composerId) "
            "after import --activate"
        ),
    )
    p_ver.set_defaults(func=cmd_verify)

    p_insp = sub.add_parser("inspect", help="Summarize a bundle file")
    p_insp.add_argument("bundle")
    p_insp.set_defaults(func=cmd_inspect)

    args = parser.parse_args()
    args.func(args)
