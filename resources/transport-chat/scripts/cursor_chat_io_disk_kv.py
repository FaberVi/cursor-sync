"""cursorDiskKV purge, probe, list, and session rebind (cursor_chat_io split module)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

def cursor_disk_kv_value_as_text(value: Any) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, memoryview):
        value = bytes(value)
    if isinstance(value, bytes):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return value.decode("utf-8", errors="replace")
    return None


def purge_disk_kv_for_conversation(
    db_path: Path,
    conversation_id: str,
    *,
    dry_run: bool = False,
) -> tuple[int, list[str]]:
    """Remove all cursorDiskKV rows for one composer before import merge (avoids stale bubbles)."""
    warnings: list[str] = []
    if not db_path.is_file():
        return 0, warnings
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        if not keys:
            return 0, warnings
        if dry_run:
            return len(keys), warnings
        conn.execute("BEGIN IMMEDIATE;")
        for key in keys:
            conn.execute("DELETE FROM cursorDiskKV WHERE key = ?;", (key,))
        conn.commit()
        return len(keys), warnings
    except sqlite3.Error as exc:
        conn.rollback()
        warnings.append(f"purge disk kv failed: {exc}")
        return 0, warnings
    finally:
        conn.close()


def probe_disk_kv_session_bindings(
    db_path: Path, conversation_id: str
) -> dict[str, Any]:
    """Post-import probe: workspace on composerData and non-empty bubble requestIds."""
    out: dict[str, Any] = {
        "keyCount": 0,
        "nonEmptyRequestIdCount": 0,
        "composerWorkspaceId": None,
        "sampleBubbleRequestId": None,
    }
    if not db_path.is_file():
        return out
    conn = sqlite3.connect(db_path, timeout=20)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        out["keyCount"] = len(keys)
        for key in keys:
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError:
                continue
            text = cursor_disk_kv_value_as_text(value)
            if not text:
                continue
            try:
                obj = json.loads(text)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            if key == f"composerData:{conversation_id}":
                wi = obj.get("workspaceIdentifier")
                if isinstance(wi, dict):
                    out["composerWorkspaceId"] = wi.get("id")
            elif key.startswith(f"bubbleId:{conversation_id}:"):
                rid = obj.get("requestId")
                if rid:
                    out["nonEmptyRequestIdCount"] += 1
                    if out["sampleBubbleRequestId"] is None:
                        out["sampleBubbleRequestId"] = rid
    finally:
        conn.close()
    return out


def list_disk_kv_keys_for_conversation(
    conn: sqlite3.Connection, conversation_id: str
) -> list[str]:
    """List keys only; bulk SELECT value on live global state.vscdb can raise DatabaseError."""
    prefix_bubble = f"bubbleId:{conversation_id}:"
    key_composer = f"composerData:{conversation_id}"
    try:
        cur = conn.execute(
            "SELECT key FROM cursorDiskKV WHERE key = ? OR key LIKE ?;",
            (key_composer, prefix_bubble + "%"),
        )
    except sqlite3.Error:
        return []
    return [str(row[0]) for row in cur.fetchall() if row and row[0]]


def read_disk_kv_value(conn: sqlite3.Connection, key: str) -> Any | None:
    row = conn.execute(
        "SELECT value FROM cursorDiskKV WHERE key = ? LIMIT 1;",
        (key,),
    ).fetchone()
    if not row:
        return None
    return row[0]


def item_table_value_as_text(value: Any) -> str | None:
    text = cursor_disk_kv_value_as_text(value)
    if text is not None:
        return text
    if isinstance(value, (dict, list)):
        try:
            return json.dumps(value)
        except (TypeError, ValueError):
            return None
    return None

PARTIAL_STATE_STRIPPED = frozenset(
    {"capabilities", "conversationActionManager", "agentSessionId"}
)

def clear_session_binding_in_tree(value: Any) -> Any:
    """Remove cloud/session bindings from composer payloads (any nesting depth)."""
    if isinstance(value, dict):
        out: dict[str, Any] = {}
        for k, v in value.items():
            if k == "requestId":
                out[k] = ""
            elif k == "workspaceUris":
                out[k] = []
            elif k in PARTIAL_STATE_STRIPPED:
                continue
            else:
                out[k] = clear_session_binding_in_tree(v)
        return out
    if isinstance(value, list):
        return [clear_session_binding_in_tree(item) for item in value]
    return value


def stamp_workspace_identifier_on_headers(
    headers: dict[str, Any], conversation_id: str, workspace_identifier: dict[str, Any]
) -> dict[str, Any]:
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return headers
    updated: list[Any] = []
    for entry in composers:
        if not isinstance(entry, dict):
            updated.append(entry)
            continue
        if entry.get("composerId") != conversation_id:
            updated.append(entry)
            continue
        row = rebind_composer_record(entry, workspace_identifier)
        updated.append(row)
    return {**headers, "allComposers": updated}


def rebind_composer_record(
    record: dict[str, Any], workspace_identifier: dict[str, Any]
) -> dict[str, Any]:
    """Re-attach a composer row/blob to the destination workspace; drop source-session fields."""
    cleared = clear_session_binding_in_tree(record)
    if not isinstance(cleared, dict):
        cleared = {}
    row = dict(cleared)
    row["workspaceIdentifier"] = workspace_identifier
    return row


def rebind_existing_conversation_disk_kv_keys(
    db_path: Path,
    conversation_id: str,
    workspace_identifier: dict[str, Any] | None,
    *,
    dry_run: bool = False,
) -> tuple[int, list[str]]:
    """Rebind every cursorDiskKV row for this conversation in place (no DELETE)."""
    warnings: list[str] = []
    if not db_path.is_file():
        return 0, warnings
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        if not keys:
            return 0, warnings
        if dry_run:
            return len(keys), warnings
        conn.execute("BEGIN IMMEDIATE;")
        updated = 0
        for key in keys:
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError as exc:
                warnings.append(f"skip disk kv rebind {key}: {exc}")
                continue
            text = cursor_disk_kv_value_as_text(value)
            if text is None:
                continue
            new_text = rebind_disk_kv_row_value(
                key, text, conversation_id, workspace_identifier
            )
            conn.execute(
                "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?);",
                (key, new_text),
            )
            updated += 1
        conn.commit()
        return updated, warnings
    except sqlite3.Error:
        conn.rollback()
        raise
    finally:
        conn.close()


def rebind_disk_kv_row_value(
    key: str,
    value: str,
    conversation_id: str,
    workspace_identifier: dict[str, Any] | None,
) -> str:
    try:
        obj = json.loads(value)
    except json.JSONDecodeError:
        return value
    if not isinstance(obj, dict):
        return value
    if key != f"composerData:{conversation_id}" and not key.startswith(
        f"bubbleId:{conversation_id}:"
    ):
        return value
    obj = clear_session_binding_in_tree(obj)
    if not isinstance(obj, dict):
        return value
    if key == f"composerData:{conversation_id}" and workspace_identifier:
        obj = rebind_composer_record(obj, workspace_identifier)
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def stamp_workspace_on_item_table_composer_data(
    data: dict[str, Any],
    conversation_id: str,
    workspace_identifier: dict[str, Any],
) -> dict[str, Any]:
    """Rebind ItemTable composer.composerData payloads for the imported conversation."""
    out = dict(data)
    blob = out.get(conversation_id)
    if isinstance(blob, dict):
        out[conversation_id] = rebind_composer_record(blob, workspace_identifier)
    composers = out.get("allComposers")
    if isinstance(composers, list):
        out["allComposers"] = [
            rebind_composer_record(entry, workspace_identifier)
            if isinstance(entry, dict) and entry.get("composerId") == conversation_id
            else entry
            for entry in composers
        ]
    return out
