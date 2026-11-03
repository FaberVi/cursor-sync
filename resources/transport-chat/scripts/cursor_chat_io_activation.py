"""Post-import activation bridge and disk KV persist (cursor_chat_io split module)."""
from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any

from cursor_chat_io_common import *

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
    from cursor_chat_io_import import merge_cursor_disk_kv

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
