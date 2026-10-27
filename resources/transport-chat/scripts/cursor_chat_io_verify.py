"""Import visibility and tool-bubble verification (cursor_chat_io split module)."""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from cursor_chat_io_common import (
    count_store_db_blobs,
    global_state_db_path,
    read_composer_header_entry,
    read_composer_rows,
)
from cursor_chat_io_disk_kv import (
    cursor_disk_kv_value_as_text,
    list_disk_kv_keys_for_conversation,
    read_disk_kv_value,
)
from cursor_chat_io_workspace import WorkspaceContext, chats_root, cursor_config_root

@dataclass
class VerifyCheck:
    name: str
    status: str
    detail: str = ""

    def format_line(self) -> str:
        if self.detail:
            return f"[{self.status}] {self.name}: {self.detail}"
        return f"[{self.status}] {self.name}"

    def to_json(self) -> dict[str, str]:
        return {"check": self.name, "status": self.status, "detail": self.detail}

def sidebar_snapshot_has_composer_data(bundle: dict[str, Any], conversation_id: str) -> bool:
    snap = bundle.get("sidebarSnapshot")
    if not isinstance(snap, dict):
        return False
    cd = snap.get("composerData")
    if not isinstance(cd, dict):
        return False
    val = cd.get(conversation_id)
    return val is not None and val != {}

def composer_data_has_conversation_key(db_path: Path, conversation_id: str) -> bool | None:
    if not db_path.is_file():
        return None
    rows = read_composer_rows(db_path)
    data = rows.get("composerData")
    if not isinstance(data, dict):
        return False
    if conversation_id not in data:
        return False
    val = data[conversation_id]
    return val is not None and val != {}


def count_tool_bubbles_in_global_db(
    conversation_id: str,
    global_db: Path | None = None,
) -> int | None:
    db = global_db if global_db is not None else global_state_db_path()
    if not db.is_file():
        return None
    prefix = f"bubbleId:{conversation_id}:"
    conn = sqlite3.connect(db, timeout=20)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        try:
            keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        except sqlite3.Error:
            return None
        count = 0
        for key in keys:
            if not key.startswith(prefix):
                continue
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError:
                continue
            text = cursor_disk_kv_value_as_text(value)
            if text is None:
                continue
            try:
                if json.loads(text).get("toolFormerData"):
                    count += 1
            except json.JSONDecodeError:
                pass
        return count
    except sqlite3.Error:
        return None
    finally:
        conn.close()


def expected_tool_bubble_count_from_bundle(bundle: dict[str, Any] | None) -> int | None:
    if bundle is None:
        return None
    disk_kv = bundle.get("diskKvSnapshot")
    if not isinstance(disk_kv, dict):
        return None
    tbc = disk_kv.get("toolBubbleCount")
    if isinstance(tbc, int) and tbc > 0:
        return tbc
    return None


def verify_import_visibility(
    conversation_id: str,
    workspace_ctx: WorkspaceContext | None,
    *,
    expect_rich_composer_data: bool = False,
    expect_store: bool = False,
    expected_tool_bubble_count: int | None = None,
    tool_bubble_global_db: Path | None = None,
) -> list[VerifyCheck]:
    checks: list[VerifyCheck] = []
    chats_key = workspace_ctx.chats_workspace_key if workspace_ctx else None
    store_path: Path | None = None
    if chats_key:
        store_path = chats_root() / chats_key / conversation_id / "store.db"
        if store_path.is_file():
            blob_n = count_store_db_blobs(store_path)
            if blob_n is None:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "WARN",
                        f"{store_path} exists but blob count unreadable",
                    )
                )
            elif blob_n > 0:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "OK",
                        f"{chats_key}/{conversation_id} ({blob_n} blobs)",
                    )
                )
            else:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "FAIL",
                        f"{store_path} has 0 blobs",
                    )
                )
        elif expect_store:
            checks.append(
                VerifyCheck(
                    "store.db",
                    "FAIL",
                    f"missing at ~/.cursor/chats/{chats_key}/{conversation_id}/",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    "store.db",
                    "SKIP",
                    f"no file at ~/.cursor/chats/{chats_key}/{conversation_id}/",
                )
            )
    elif expect_store:
        checks.append(VerifyCheck("store.db", "FAIL", "workspace context missing"))

    g = global_state_db_path()
    ent = read_composer_header_entry(g, conversation_id)
    if ent is None:
        checks.append(
            VerifyCheck(
                "global.composerHeaders",
                "FAIL",
                "sidebar row missing in globalStorage/state.vscdb",
            )
        )
    else:
        wi = (
            ent.get("workspaceIdentifier")
            if isinstance(ent.get("workspaceIdentifier"), dict)
            else {}
        )
        wi_id = wi.get("id")
        fp = (wi.get("uri") or {}).get("fsPath") if isinstance(wi.get("uri"), dict) else None
        expected = workspace_ctx.folder_fs_path if workspace_ctx else None
        expected_id = workspace_ctx.workspace_storage_id if workspace_ctx else None
        if not wi_id:
            checks.append(
                VerifyCheck("global.workspaceIdentifier", "FAIL", "id not stamped on header")
            )
        elif expected_id and wi_id != expected_id:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier",
                    "FAIL",
                    f"id={wi_id} expected workspaceStorage id {expected_id}",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier",
                    "OK",
                    f"id={wi_id}",
                )
            )
        if expected and fp != expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "FAIL",
                    f"uri.fsPath={fp!r} expected {expected!r}",
                )
            )
        elif expected and fp == expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "OK",
                    fp or "",
                )
            )
        elif expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "FAIL",
                    "uri.fsPath missing on header",
                )
            )
        checks.append(VerifyCheck("global.composerHeaders", "OK", conversation_id))

    if workspace_ctx:
        ws_db = (
            cursor_config_root()
            / "workspaceStorage"
            / workspace_ctx.workspace_storage_id
            / "state.vscdb"
        )
        ent_w = read_composer_header_entry(ws_db, conversation_id)
        if ent_w is None:
            checks.append(
                VerifyCheck(
                    f"workspace.composerHeaders({workspace_ctx.workspace_storage_id})",
                    "WARN",
                    "missing (global row may still be enough)",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    f"workspace.composerHeaders({workspace_ctx.workspace_storage_id})",
                    "OK",
                    conversation_id,
                )
            )

        for label, db in (("global", g), ("workspace", ws_db)):
            has_key = composer_data_has_conversation_key(db, conversation_id)
            if expect_rich_composer_data:
                if has_key:
                    checks.append(
                        VerifyCheck(
                            f"{label}.composerData[{conversation_id}]",
                            "OK",
                            "per-composer payload present",
                        )
                    )
                else:
                    checks.append(
                        VerifyCheck(
                            f"{label}.composerData[{conversation_id}]",
                            "FAIL",
                            "bundle sidebar had composerData but disk key missing",
                        )
                    )
            elif has_key:
                checks.append(
                    VerifyCheck(
                        f"{label}.composerData[{conversation_id}]",
                        "OK",
                        "per-composer payload present",
                    )
                )

    if expected_tool_bubble_count is not None and expected_tool_bubble_count > 0:
        db_for_tools = tool_bubble_global_db if tool_bubble_global_db is not None else g
        tool_count = count_tool_bubbles_in_global_db(conversation_id, db_for_tools)
        detail = (
            f"toolFormerData bubbles={tool_count} "
            f"expected>={expected_tool_bubble_count}"
        )
        if tool_count is None:
            checks.append(
                VerifyCheck(
                    "global.diskKv.toolBubbles",
                    "FAIL",
                    "global state DB unreadable or cursorDiskKV missing",
                )
            )
        elif tool_count >= expected_tool_bubble_count:
            checks.append(
                VerifyCheck("global.diskKv.toolBubbles", "OK", detail)
            )
        else:
            checks.append(
                VerifyCheck("global.diskKv.toolBubbles", "FAIL", detail)
            )

    return checks


def verify_checks_all_ok(checks: list[VerifyCheck]) -> bool:
    return all(c.status != "FAIL" for c in checks)
def print_verify_report(checks: list[VerifyCheck], *, json_lines: bool = False) -> None:
    for c in checks:
        if json_lines:
            print(json.dumps(c.to_json(), separators=(",", ":")))
        else:
            print(c.format_line())
