"""Disk import workflow and activation bridge (cursor_chat_io split module)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from cursor_chat_io_common import *
from cursor_chat_io_bundle import (
    build_cursor_disk_kv_rows_from_bundle,
    decode_artifact,
    merge_agent_kv_snapshot,
    merge_cursor_disk_kv,
    merge_state_db,
    remap_agent_kv_snapshot_for_destination,
    remap_disk_kv_snapshot_for_destination,
    synthesize_store_db_from_bundle,
)

SUPPORTED_BUNDLE_SCHEMA_VERSIONS = frozenset({1, 2})


def persist_disk_kv_rows_to_db(
    target_db: Path,
    disk_kv_rows: dict[str, str],
    cid: str,
    ws_identifier: dict[str, Any] | None,
    *,
    dry_run: bool,
    db_label: str,
    skip_purge: bool = False,
    skip_integrity_check: bool = False,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    if not skip_integrity_check and not sqlite_integrity_ok(target_db):
        warnings.append(
            f"{db_label} state.vscdb failed integrity_check. Skipped cursorDiskKV merge."
        )
        return False, warnings
    if not skip_purge:
        _, purge_warnings = purge_disk_kv_for_conversation(
            target_db, cid, dry_run=dry_run
        )
        warnings.extend(purge_warnings)
    ok_kv, kv_warnings = merge_cursor_disk_kv(
        target_db, disk_kv_rows, dry_run=dry_run, conversation_id=cid
    )
    warnings.extend(kv_warnings)
    if not (ok_kv and not dry_run):
        return bool(ok_kv), warnings
    print(
        f"Wrote {len(disk_kv_rows)} cursorDiskKV rows into {target_db} "
        f"[{db_label}] (composerData + {len(disk_kv_rows) - 1} bubbles)"
    )
    warnings.append(
        f"Restored {len(disk_kv_rows)} cursorDiskKV rows into {db_label} database."
    )
    if not skip_purge:
        rebind_count, rebind_warnings = rebind_existing_conversation_disk_kv_keys(
            target_db,
            cid,
            ws_identifier,
            dry_run=False,
        )
        warnings.extend(rebind_warnings)
        if rebind_count:
            print(
                f"Rebound session bindings on {rebind_count} existing cursorDiskKV "
                f"rows for {cid} in {db_label} database (no purge)"
            )
    return True, warnings


def build_activation_manifest(
    bundle: dict[str, Any],
    conversation_id: str,
    workspace_ctx: WorkspaceContext,
    *,
    open_in_new_tab: bool = True,
) -> dict[str, Any]:
    partial = bundle_to_partial_state(
        bundle,
        conversation_id,
        workspace_identifier=workspace_ctx.workspace_identifier,
    )
    return {
        "partialState": partial,
        "workspaceFolder": workspace_ctx.folder_fs_path,
        "openInNewTab": open_in_new_tab,
    }


def _parse_bridge_stdout(stdout: str) -> str | None:
    text = (stdout or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    cid = data.get("composerId")
    if isinstance(cid, str) and cid.strip():
        return cid.strip()
    return None


def invoke_composer_bridge(
    manifest: dict[str, Any],
    *,
    wait_result_s: float = 0.0,
    dry_run: bool = False,
) -> tuple[int, str | None]:
    import cursor_chat_io as _cio

    if dry_run:
        print(
            f"[dry-run] would run bridge: {COMPOSER_BRIDGE_SCRIPT} --manifest <tmp>",
            file=sys.stderr,
        )
        return 0, manifest.get("partialState", {}).get("composerId")

    if not COMPOSER_BRIDGE_SCRIPT.is_file():
        print(f"error: bridge script missing: {COMPOSER_BRIDGE_SCRIPT}", file=sys.stderr)
        return 1, None

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tf:
            json.dump(manifest, tf, indent=2, ensure_ascii=False)
            tf.write("\n")
            tmp_path = Path(tf.name)

        cmd = [
            sys.executable,
            str(COMPOSER_BRIDGE_SCRIPT),
            "--manifest",
            str(tmp_path),
        ]
        if wait_result_s > 0:
            cmd.extend(["--wait-result", str(wait_result_s)])

        proc = _cio.subprocess.run(cmd, capture_output=True, text=True)
        if proc.stderr:
            for line in proc.stderr.strip().splitlines():
                print(f"  bridge: {line}", file=sys.stderr)
        composer_id = _parse_bridge_stdout(proc.stdout or "")
        if composer_id is None and proc.returncode == 0:
            partial = manifest.get("partialState")
            if isinstance(partial, dict):
                raw = partial.get("composerId")
                if isinstance(raw, str) and raw.strip():
                    composer_id = raw.strip()
        return proc.returncode, composer_id
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass


def ping_server_probe(*, conversation_id: str) -> None:
    print(
        f"note: --ping-server probe not implemented for {conversation_id} "
        "(no agentClient HTTP contract in v1; see activation-architecture.md)",
        file=sys.stderr,
    )


def verify_activation_checks(conversation_id: str) -> list[VerifyCheck]:
    import cursor_chat_io as _cio

    checks: list[VerifyCheck] = []

    pending_path = _cio.ACTIVATION_PENDING_PATH
    result_path = _cio.ACTIVATION_RESULT_PATH

    pending_cid: str | None = None
    if pending_path.is_file():
        try:
            pending = json.loads(pending_path.read_text(encoding="utf-8"))
            if isinstance(pending, dict):
                raw = pending.get("composerId")
                if isinstance(raw, str):
                    pending_cid = raw.strip()
                if not pending_cid:
                    partial = pending.get("partialState")
                    if isinstance(partial, dict):
                        pc = partial.get("composerId")
                        if isinstance(pc, str):
                            pending_cid = pc.strip()
        except (OSError, json.JSONDecodeError):
            checks.append(
                VerifyCheck("activation.pending", "WARN", "pending.json unreadable")
            )
        else:
            if pending_cid == conversation_id:
                checks.append(
                    VerifyCheck(
                        "activation.pending",
                        "OK",
                        f"staged for {conversation_id}",
                    )
                )
            elif pending_cid:
                checks.append(
                    VerifyCheck(
                        "activation.pending",
                        "WARN",
                        f"pending composerId={pending_cid!r} (expected {conversation_id})",
                    )
                )
            else:
                checks.append(
                    VerifyCheck("activation.pending", "WARN", "pending.json has no composerId")
                )
    else:
        checks.append(VerifyCheck("activation.pending", "SKIP", "no pending.json"))

    result_cid: str | None = None
    result_ok = False
    if result_path.is_file():
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            if isinstance(result, dict) and result.get("ok") is not False:
                raw = result.get("composerId")
                if isinstance(raw, str) and raw.strip():
                    result_cid = raw.strip()
                    result_ok = True
        except (OSError, json.JSONDecodeError):
            checks.append(
                VerifyCheck("activation.result", "WARN", "result.json unreadable")
            )
        else:
            if result_ok and result_cid == conversation_id:
                checks.append(
                    VerifyCheck(
                        "activation.result",
                        "OK",
                        f"composerId={result_cid}",
                    )
                )
            elif result_cid:
                checks.append(
                    VerifyCheck(
                        "activation.result",
                        "WARN",
                        f"composerId={result_cid!r} (expected {conversation_id})",
                    )
                )
            else:
                checks.append(
                    VerifyCheck("activation.result", "WARN", "result.json missing composerId")
                )
    else:
        checks.append(
            VerifyCheck(
                "activation.result",
                "PENDING",
                "awaiting IDE hook, CURSOR_COMPOSER_BRIDGE_COMMAND, or --bridge-wait-result",
            )
        )

    if result_ok and result_cid == conversation_id:
        checks.append(VerifyCheck("activation.status", "OK", "completed"))
    elif pending_cid == conversation_id:
        checks.append(
            VerifyCheck(
                "activation.status",
                "PENDING",
                "manifest staged; IDE activation not confirmed",
            )
        )
    else:
        checks.append(
            VerifyCheck(
                "activation.status",
                "SKIP",
                "no matching activation artifacts for this conversation",
            )
        )

    return checks


def run_post_import_activation(
    bundle: dict[str, Any],
    conversation_id: str,
    workspace_ctx: WorkspaceContext,
    *,
    activate_strict: bool = False,
    bridge_wait_result: float = 0.0,
    dry_run: bool = False,
) -> None:
    import cursor_chat_io as _cio

    manifest = build_activation_manifest(bundle, conversation_id, workspace_ctx)
    print(f"Activating composer {conversation_id} via bridge ...", file=sys.stderr)
    code, composer_id = invoke_composer_bridge(
        manifest,
        wait_result_s=bridge_wait_result,
        dry_run=dry_run,
    )
    if code == 0:
        cid = composer_id or conversation_id
        print(f"Activation OK: composerId={cid}", file=sys.stderr)
        return
    if code == 1:
        print("error: bridge failed (invalid manifest or missing script)", file=sys.stderr)
        raise SystemExit(1)
    if code == 2:
        msg = (
            "Activation staged only (exit 2): manifest at "
            f"{_cio.ACTIVATION_PENDING_PATH}; Cursor must be open on the workspace. "
            "Set CURSOR_COMPOSER_BRIDGE_COMMAND or write result.json."
        )
        print(f"  warning: {msg}", file=sys.stderr)
        if activate_strict:
            print("error: --activate-strict requires bridge exit 0", file=sys.stderr)
            raise SystemExit(1)
        return
    print(f"error: bridge exited {code}", file=sys.stderr)
    raise SystemExit(1)


def import_bundle(
    bundle_path: Path,
    target_project: str | None,
    target_workspace: str | None,
    state_db: Path | None,
    dry_run: bool,
    pin_recent: bool = True,
    workspace_folder: str | None = None,
    sync_global: bool = True,
    *,
    activate: bool = False,
    activate_strict: bool = False,
    ping_server: bool = False,
    bridge_wait_result: float = 0.0,
) -> None:
    if not workspace_folder or not str(workspace_folder).strip():
        print(
            "error: --workspace-folder is required for import\n"
            "  Sets ~/.cursor/chats/<md5(folder)> store.db path and stamps "
            "workspaceIdentifier on composer headers (global + workspace state).",
            file=sys.stderr,
        )
        raise SystemExit(1)

    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    if bundle.get("type") != BUNDLE_TYPE:
        raise SystemExit("Unsupported bundle: expected type=chat-persistence")
    schema_version = bundle.get("schemaVersion")
    if schema_version not in SUPPORTED_BUNDLE_SCHEMA_VERSIONS:
        raise SystemExit(
            f"Unsupported bundle: schemaVersion={schema_version!r} "
            f"(expected {sorted(SUPPORTED_BUNDLE_SCHEMA_VERSIONS)})"
        )

    cid = bundle["conversationId"]
    warnings: list[str] = []
    transcripts_written = 0
    store_written = False
    sidebar_merged = False

    project_map: dict[str, str] = {}
    for tf in bundle.get("transcriptFiles") or []:
        rel = tf.get("relativePath", "")
        seg = rel.split("/")
        if seg:
            src = seg[0]
            project_map[src] = target_project or src

    if (bundle.get("transcriptFiles") or []) and not target_project:
        keys = sorted(project_map.keys())
        print(
            "Note: pass --target-project <folder-under-~/.cursor/projects> to remap transcripts.",
            file=sys.stderr,
        )
        print(f"  Source project key(s) in bundle: {', '.join(keys)}", file=sys.stderr)

    proot = projects_root()
    for tf in bundle.get("transcriptFiles") or []:
        rel = tf["relativePath"]
        seg = rel.split("/")
        mapped = "/".join([project_map.get(seg[0], seg[0]), *seg[1:]]) if seg else rel
        target = proot / mapped
        raw = decode_artifact(tf["content"], tf.get("encoding"))
        if sha256_hex(raw) != tf.get("checksum"):
            warnings.append(f"Checksum mismatch: {rel} (skipped)")
            continue
        if dry_run:
            print(f"[dry-run] would write transcript {target} ({len(raw)} bytes)")
            transcripts_written += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        print(f"Wrote transcript {target}")
        transcripts_written += 1

    ws_ctx = resolve_workspace_context(state_db, workspace_folder)
    if ws_ctx is None:
        print(
            f"error: could not resolve workspace for --workspace-folder {workspace_folder!r}\n"
            "  Open this folder in Cursor once, or pass --state-db for its workspaceStorage entry.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    print(
        f"Workspace folder: {ws_ctx.folder_fs_path}\n"
        f"  store.db -> ~/.cursor/chats/{ws_ctx.chats_workspace_key}/\n"
        f"  workspaceIdentifier.id -> {ws_ctx.workspace_storage_id}",
        file=sys.stderr,
    )

    snap = bundle.get("storeSnapshot")
    bundle_had_store = bool(snap and snap.get("content"))
    store_synthesized = False
    if snap:
        dest_ws, ws_warnings = resolve_chats_workspace_key(
            target_workspace, state_db, workspace_folder, bundle
        )
        warnings.extend(ws_warnings)
        raw = decode_artifact(snap["content"], snap.get("encoding"))
        if sha256_hex(raw) != snap.get("checksum"):
            warnings.append("store.db checksum mismatch (skipped)")
        else:
            target = chats_root() / dest_ws / cid / "store.db"
            if dry_run:
                print(f"[dry-run] would write store {target} ({len(raw)} bytes)")
                store_written = True
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
                print(f"Wrote store {target}")
                store_written = True
    elif not store_written:
        written, synth_warnings = synthesize_store_db_from_bundle(
            bundle,
            ws_ctx.chats_workspace_key,
            cid,
            dry_run=dry_run,
        )
        warnings.extend(synth_warnings)
        if written:
            store_written = True
            store_synthesized = True

    do_sync_global = sync_global
    merge_targets = merge_targets_for_import(state_db, sync_global=do_sync_global)
    agent_debug_log(
        "K",
        "cursor_chat_io_import.py:merge-targets",
        "state db merge targets",
        {
            "conversationId": cid,
            "mergeTargetPaths": [str(p) for p in merge_targets],
            "mergeTargetCount": len(merge_targets),
            "syncGlobal": do_sync_global,
            "stateDbArg": str(state_db) if state_db else None,
            "workspaceStorageId": ws_ctx.workspace_storage_id if ws_ctx else None,
            "folderFsPath": ws_ctx.folder_fs_path if ws_ctx else None,
        },
    )

    if bundle.get("sidebarSnapshot"):
        if dry_run:
            for db in merge_targets:
                print(f"[dry-run] would merge sidebar into {db}")
            sidebar_merged = True
        else:
            for db in merge_targets:
                ok, w = merge_state_db(
                    db, bundle, dry_run=False, pin_recent=pin_recent, workspace_ctx=ws_ctx
                )
                warnings.extend(w)
                if ok:
                    sidebar_merged = True
                    pin_note = " (pinned as most recent)" if pin_recent else ""
                    label = "global" if "globalStorage" in str(db) else "workspace"
                    print(f"Merged composer state into {db} [{label}]{pin_note}")
            if global_state_db_path() not in merge_targets:
                warnings.append(
                    "Global state.vscdb was not updated (--no-global-state); "
                    "sidebar may not show this chat for this workspace."
                )
    else:
        warnings.append("No sidebarSnapshot in bundle; sidebar merge skipped.")

    global_db = global_state_db_path()
    if global_db in merge_targets:
        ws_identifier = ws_ctx.workspace_identifier if ws_ctx is not None else None
        disk_kv = bundle.get("diskKvSnapshot")
        if isinstance(disk_kv, dict) and disk_kv.get("rows"):
            disk_kv_rows = remap_disk_kv_snapshot_for_destination(
                disk_kv, cid, ws_identifier
            )
        else:
            disk_kv_rows = build_cursor_disk_kv_rows_from_bundle(bundle, cid, ws_identifier)
        non_empty_request_ids = 0
        for row_key, row_val in disk_kv_rows.items():
            try:
                parsed = json.loads(row_val)
                if isinstance(parsed, dict) and parsed.get("requestId"):
                    non_empty_request_ids += 1
            except json.JSONDecodeError:
                pass
        agent_debug_log(
            "M",
            "cursor_chat_io_import.py:disk-kv-remap",
            "remapped diskKv rows before write",
            {
                "conversationId": cid,
                "incomingRowCount": len(disk_kv_rows),
                "rowsWithNonEmptyRequestId": non_empty_request_ids,
            },
        )
        disk_kv_written = False
        if sqlite_integrity_ok(global_db):
            ok_kv, kv_warnings = persist_disk_kv_rows_to_db(
                global_db,
                disk_kv_rows,
                cid,
                ws_identifier,
                dry_run=dry_run,
                db_label="global",
                skip_purge=True,
            )
            warnings.extend(kv_warnings)
            disk_kv_written = ok_kv
        else:
            warnings.append(
                "Global state.vscdb failed integrity_check. "
                "Merging cursorDiskKV by exact key only (no purge)."
            )
            ok_kv, kv_warnings = persist_disk_kv_rows_to_db(
                global_db,
                disk_kv_rows,
                cid,
                ws_identifier,
                dry_run=dry_run,
                db_label="global-exact-key",
                skip_purge=True,
                skip_integrity_check=True,
            )
            warnings.extend(kv_warnings)
            if ok_kv:
                disk_kv_written = True
            for db in merge_targets:
                db_path = Path(db)
                if db_path == global_db or "workspaceStorage" not in str(db_path):
                    continue
                ok_kv, kv_warnings = persist_disk_kv_rows_to_db(
                    db_path,
                    disk_kv_rows,
                    cid,
                    ws_identifier,
                    dry_run=dry_run,
                    db_label="workspace",
                    skip_purge=True,
                )
                warnings.extend(kv_warnings)
                if ok_kv:
                    disk_kv_written = True
                    break
            if not disk_kv_written:
                warnings.append(
                    "Sidebar headers merged. Chat bubbles stay missing until global "
                    "state.vscdb is repaired or the workspace cursorDiskKV write succeeds."
                )

        agent_kv = bundle.get("agentKvSnapshot")
        source_cid = (
            str(agent_kv.get("conversationId"))
            if isinstance(agent_kv, dict) and agent_kv.get("conversationId")
            else cid
        )
        if isinstance(agent_kv, dict) and agent_kv.get("rows"):
            agent_rows = remap_agent_kv_snapshot_for_destination(
                agent_kv, source_cid, cid
            )
            warnings.append(
                f"Restored {len(agent_rows)} agentKv rows from bundle "
                f"(blobCount={agent_kv.get('blobCount', 0)}, "
                f"checkpointCount={agent_kv.get('checkpointCount', 0)})."
            )
            ok_agent, agent_warnings = merge_agent_kv_snapshot(
                global_db, agent_rows, dry_run=dry_run
            )
            warnings.extend(agent_warnings)
            if ok_agent and not dry_run:
                print(f"Wrote {len(agent_rows)} agentKv rows into {global_db}")

    if bundle_had_store and not store_written:
        print(
            "error: bundle includes storeSnapshot but store.db was not written "
            "(checksum mismatch or skipped write)",
            file=sys.stderr,
        )
        raise SystemExit(1)

    print(
        f"Done: conversation={cid} transcripts={transcripts_written} "
        f"store={store_written} sidebar_merged={sidebar_merged}"
    )
    for w in warnings:
        print(f"  warning: {w}", file=sys.stderr)
    expect_rich = sidebar_snapshot_has_composer_data(bundle, cid)
    expect_store = bundle_had_store or store_written or store_synthesized
    verify_checks = verify_import_visibility(
        cid,
        ws_ctx,
        expect_rich_composer_data=expect_rich,
        expect_store=expect_store,
        expected_tool_bubble_count=expected_tool_bubble_count_from_bundle(bundle),
    )
    for c in verify_checks:
        print(f"  verify: {c.format_line()}", file=sys.stderr)
    if not dry_run and not verify_checks_all_ok(verify_checks):
        print("error: import verify failed (see verify lines above)", file=sys.stderr)
        raise SystemExit(1)

    if activate:
        run_post_import_activation(
            bundle,
            cid,
            ws_ctx,
            activate_strict=activate_strict,
            bridge_wait_result=bridge_wait_result,
            dry_run=dry_run,
        )

    if ping_server:
        if dry_run:
            print(
                f"[dry-run] would run --ping-server probe for {cid}",
                file=sys.stderr,
            )
        else:
            ping_server_probe(conversation_id=cid)

    if activate:
        activation_checks = verify_activation_checks(cid)
        for c in activation_checks:
            print(f"  verify: {c.format_line()}", file=sys.stderr)
        verify_checks.extend(activation_checks)

    if not dry_run:
        if not verify_checks_all_ok(verify_checks):
            print("error: import verify failed (see verify lines above)", file=sys.stderr)
            raise SystemExit(1)
        if sidebar_merged:
            print("Reload Cursor to refresh the chat sidebar.", file=sys.stderr)
        global_db = global_state_db_path()
        ent = (
            read_composer_header_entry(global_db, cid) if global_db.is_file() else None
        )
        wi = ent.get("workspaceIdentifier") if isinstance(ent, dict) else None
        wi_id = wi.get("id") if isinstance(wi, dict) else None
        agent_debug_log(
            "I",
            "cursor_chat_io_import.py:post-import",
            "python import finished",
            {
                "conversationId": cid,
                "sidebarMerged": sidebar_merged,
                "storeWritten": store_written,
                "transcriptsWritten": transcripts_written,
                "verifyAllOk": verify_checks_all_ok(verify_checks),
                "globalHeaderFound": ent is not None,
                "globalHeaderWorkspaceId": wi_id,
                "expectedWorkspaceStorageId": ws_ctx.workspace_storage_id if ws_ctx else None,
                "headerIsArchived": ent.get("isArchived") if isinstance(ent, dict) else None,
                "warningCount": len(warnings),
            },
        )

