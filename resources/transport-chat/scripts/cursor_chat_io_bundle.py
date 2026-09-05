"""Bundle build, merge, and store synthesis (cursor_chat_io split module)."""
from __future__ import annotations

import base64
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cursor_chat_io_common import *
from cursor_chat_io_headers import *
from cursor_chat_io_agent_kv import *
from cursor_chat_io_golden import *
from cursor_chat_io_store_rows import *

def iter_conversation_jsonl_files(conversation_dir: Path) -> list[Path]:
    if not conversation_dir.is_dir():
        return []
    return sorted(conversation_dir.rglob("*.jsonl"))

def remap_disk_kv_snapshot_for_destination(
    snapshot: dict[str, Any],
    conversation_id: str,
    workspace_identifier: dict[str, Any] | None,
) -> dict[str, str]:
    from cursor_chat_io_common import rebind_disk_kv_row_value

    rows_out: dict[str, str] = {}
    for row in snapshot.get("rows") or []:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key", ""))
        value = str(row.get("value", ""))
        if not key:
            continue
        if not is_disk_kv_key_in_conversation_scope(key, conversation_id):
            continue
        value = rebind_disk_kv_row_value(key, value, conversation_id, workspace_identifier)
        rows_out[key] = value
    return rows_out


def build_bundle(conversation_id: str, state_db: Path | None) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    store_snapshot = None
    store_info = find_store_db(conversation_id)
    if store_info:
        store_path, ws_key = store_info
        raw = store_path.read_bytes()
        store_snapshot = {
            "content": base64.b64encode(raw).decode("ascii"),
            "encoding": "base64",
            "checksum": sha256_hex(raw),
            "sizeBytes": len(raw),
            "sourceWorkspaceKey": ws_key,
        }
    else:
        warnings.append(
            f"store.db not found for {conversation_id}; only transcripts will be exported."
        )

    sidebar_snapshot = None
    db_candidates = [state_db] if state_db else list_state_db_candidates()
    for db in db_candidates:
        if db is None or not db.is_file():
            continue
        try:
            rows = read_composer_rows(db)
            if rows:
                sidebar_snapshot = {"conversationId": conversation_id, "stateDbPath": str(db)}
                if isinstance(rows.get("composerHeaders"), dict):
                    sidebar_snapshot["composerHeaders"] = filter_composer_headers_for_conversation(
                        rows["composerHeaders"], conversation_id
                    )
                if isinstance(rows.get("composerData"), dict):
                    sidebar_snapshot["composerData"] = filter_composer_data_for_conversation(
                        rows["composerData"], conversation_id
                    )
                if not (sidebar_snapshot.get("composerHeaders") or {}).get("allComposers"):
                    warnings.append(
                        f"{conversation_id} not in composer.composerHeaders at {db}; "
                        "import will synthesize a sidebar row from the bundle title."
                    )
                break
        except sqlite3.Error as e:
            warnings.append(f"state read failed ({db}): {e}")
    if sidebar_snapshot is None and db_candidates:
        warnings.append("composer.* not found in state.vscdb; sidebar metadata skipped.")

    disk_kv_snapshot = None
    global_db = global_state_db_path()
    try:
        disk_kv_snapshot = export_disk_kv_snapshot(global_db, conversation_id)
    except sqlite3.Error as e:
        warnings.append(f"diskKv export failed: {e}")
    if disk_kv_snapshot is None:
        warnings.append(
            f"No cursorDiskKV rows for {conversation_id}; "
            "import will synthesize text-only composer bubbles."
        )

    transcript_files: list[dict[str, Any]] = []
    proot = projects_root()
    if proot.is_dir():
        for proj in sorted(proot.iterdir()):
            if not proj.is_dir():
                continue
            tdir = proj / "agent-transcripts" / conversation_id
            if not tdir.is_dir():
                continue
            for jf in iter_conversation_jsonl_files(tdir):
                rel_suffix = jf.relative_to(tdir).as_posix()
                raw = jf.read_bytes()
                transcript_files.append(
                    {
                        "relativePath": f"{proj.name}/agent-transcripts/{conversation_id}/{rel_suffix}",
                        "content": base64.b64encode(raw).decode("ascii"),
                        "encoding": "base64",
                        "checksum": sha256_hex(raw),
                        "sizeBytes": len(raw),
                    }
                )

    if not transcript_files and not store_snapshot:
        raise SystemExit(
            f"No data for conversation {conversation_id}. Check ID under agent-transcripts or chats."
        )

    title = conversation_id
    if transcript_files:
        first = base64.b64decode(transcript_files[0]["content"])
        hint = first_user_text_from_bytes(first)
        if hint:
            title = hint[:120]

    schema_version = SCHEMA_VERSION if disk_kv_snapshot is None else 2
    bundle: dict[str, Any] = {
        "schemaVersion": schema_version,
        "type": BUNDLE_TYPE,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "conversationId": conversation_id,
        "title": title,
        "subtitle": f"{len(transcript_files)} file(s)",
        "previewText": title,
        "sidebarSnapshot": sidebar_snapshot,
        "storeSnapshot": store_snapshot,
        "transcriptFiles": transcript_files,
    }
    if disk_kv_snapshot is not None:
        bundle["diskKvSnapshot"] = disk_kv_snapshot

    agent_kv_snapshot = None
    try:
        agent_kv_snapshot = export_agent_kv_snapshot(global_db, conversation_id)
    except sqlite3.Error as e:
        warnings.append(f"agentKv export failed: {e}")
    if agent_kv_snapshot is not None:
        bundle["agentKvSnapshot"] = agent_kv_snapshot
        for w in agent_kv_snapshot.get("warnings") or []:
            warnings.append(w)

    return bundle, warnings

def merge_state_db(
    db_path: Path,
    bundle: dict[str, Any],
    dry_run: bool,
    pin_recent: bool = True,
    workspace_ctx: WorkspaceContext | None = None,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    snap = bundle.get("sidebarSnapshot")
    if not isinstance(snap, dict):
        warnings.append("No sidebarSnapshot in bundle; state merge skipped.")
        return False, warnings

    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData')"
        )
        existing_headers: str | None = None
        existing_data: str | None = None
        for key, value in cur.fetchall():
            if key == "composer.composerHeaders":
                existing_headers = item_table_value_as_text(value)
            if key == "composer.composerData":
                existing_data = item_table_value_as_text(value)

        headers_payload = headers_payload_for_import(bundle)
        cid = bundle.get("conversationId")
        if not isinstance(cid, str) or not cid.strip():
            warnings.append("Bundle missing conversationId; state merge skipped.")
            return False, warnings
        cid = cid.strip()

        scripts: list[str] = ["BEGIN IMMEDIATE;"]
        if headers_payload:
            merged = merge_headers_chain(existing_headers, [headers_payload])
            if pin_recent:
                merged = pin_composer_as_most_recent(merged, cid)
            if workspace_ctx is not None:
                merged = stamp_workspace_identifier_on_headers(
                    merged, cid, workspace_ctx.workspace_identifier
                )
            escaped = escape_sql_literal(json.dumps(merged, separators=(",", ":")))
            scripts.append(
                f"UPDATE ItemTable SET value = '{escaped}' WHERE key = 'composer.composerHeaders';"
            )
            scripts.append(
                f"INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '{escaped}' "
                "WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');"
            )

        merged_data = composer_data_for_focus(cid, existing_data)
        if isinstance(snap, dict) and isinstance(snap.get("composerData"), dict):
            extra = filter_composer_data_for_conversation(snap["composerData"], cid)
            if extra:
                merged_data = merge_data_additive(
                    json.dumps(merged_data, separators=(",", ":")), [extra]
                )
        if workspace_ctx is not None:
            from cursor_chat_io_common import stamp_workspace_on_item_table_composer_data

            merged_data = stamp_workspace_on_item_table_composer_data(
                merged_data, cid, workspace_ctx.workspace_identifier
            )
        escaped_d = escape_sql_literal(json.dumps(merged_data, separators=(",", ":")))
        scripts.append(
            f"UPDATE ItemTable SET value = '{escaped_d}' WHERE key = 'composer.composerData';"
        )
        scripts.append(
            f"INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '{escaped_d}' "
            "WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');"
        )
        scripts.append("COMMIT;")
        if len(scripts) <= 2:
            warnings.append("Nothing to merge into state.vscdb.")
            return False, warnings
        if dry_run:
            return True, warnings
        cur.executescript("\n".join(scripts))
        conn.commit()
        row = cur.execute(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1"
        ).fetchone()
        merged_headers = parse_headers_blob(
            item_table_value_as_text(row[0]) if row else None
        )
        composers = merged_headers.get("allComposers")
        in_list = isinstance(composers, list) and any(
            isinstance(e, dict) and e.get("composerId") == cid for e in composers
        )
        agent_debug_log(
            "H",
            "cursor_chat_io_bundle.py:merge_state_db",
            "sidebar headers merged",
            {
                "conversationId": cid,
                "dbPath": str(db_path),
                "allComposersCount": len(composers) if isinstance(composers, list) else 0,
                "conversationInHeaders": in_list,
                "hadHeadersPayload": bool(headers_payload),
            },
        )
        return True, warnings
    finally:
        conn.close()
