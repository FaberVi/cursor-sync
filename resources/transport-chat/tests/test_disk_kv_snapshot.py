import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from cursor_chat_io import (  # noqa: E402
    BUNDLE_TYPE,
    SUPPORTED_BUNDLE_SCHEMA_VERSIONS,
    build_cursor_disk_kv_rows_from_bundle,
    count_tool_bubbles_in_global_db,
    export_disk_kv_snapshot,
    is_disk_kv_key_in_conversation_scope,
    merge_cursor_disk_kv,
    remap_disk_kv_snapshot_for_destination,
    verify_checks_all_ok,
    verify_import_visibility,
)
from cursor_chat_io_import import import_bundle  # noqa: E402

FIXTURE = Path(__file__).resolve().parent / "fixtures" / "disk-kv-tool-bubbles"
CID = "fixture-tool-mcp-00000000-0000-4000-8000-000000000001"
DEST_WS_ID = "dest-workspace-hash00000000000001"
DEST_FOLDER = "/tmp/cursor-sync-dest-fixture"
DEST_WORKSPACE_IDENTIFIER = {
    "id": DEST_WS_ID,
    "uri": {
        "$mid": 1,
        "fsPath": DEST_FOLDER,
        "_sep": 47,
        "external": f"file://{DEST_FOLDER}",
        "path": DEST_FOLDER,
        "scheme": "file",
    },
}


def _seed_global_db(db_path: Path) -> None:
    composer = json.loads((FIXTURE / "composerData.json").read_text())
    bubble_tool = (FIXTURE / "bubble-tool.json").read_text()
    bubble_text = (FIXTURE / "bubble-text.json").read_text()
    headers = composer["fullConversationHeadersOnly"]
    bid_tool = headers[1]["bubbleId"]
    bid_text = headers[0]["bubbleId"]
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"composerData:{CID}", json.dumps(composer, separators=(",", ":"))),
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"bubbleId:{CID}:{bid_text}", bubble_text),
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"bubbleId:{CID}:{bid_tool}", bubble_tool),
    )
    conn.commit()
    conn.close()


def test_export_disk_kv_snapshot_includes_tool_bubbles(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_global_db(db)
    snap = export_disk_kv_snapshot(db, CID)
    assert snap is not None
    assert snap["rowCount"] == 3
    assert snap["toolBubbleCount"] >= 1
    keys = {r["key"] for r in snap["rows"]}
    assert f"composerData:{CID}" in keys
    assert any(k.startswith(f"bubbleId:{CID}:") for k in keys)


def test_export_disk_kv_snapshot_reads_blob_column_values(tmp_path):
    composer = json.loads((FIXTURE / "composerData.json").read_text())
    bubble_text = (FIXTURE / "bubble-text.json").read_text()
    db = tmp_path / "blob-state.vscdb"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);")
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"composerData:{CID}", json.dumps(composer, separators=(",", ":")).encode("utf-8")),
    )
    headers = composer["fullConversationHeadersOnly"]
    bid_text = headers[0]["bubbleId"]
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"bubbleId:{CID}:{bid_text}", bubble_text.encode("utf-8")),
    )
    conn.commit()
    conn.close()
    snap = export_disk_kv_snapshot(db, CID)
    assert snap is not None
    assert snap["rowCount"] == 2


def _tool_bubble_count(db_path: Path) -> int:
    conn = sqlite3.connect(db_path)
    try:
        count = 0
        for _key, value in conn.execute(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?;",
            (f"bubbleId:{CID}:%",),
        ):
            try:
                if json.loads(value).get("toolFormerData"):
                    count += 1
            except json.JSONDecodeError:
                pass
        return count
    finally:
        conn.close()


def test_remap_disk_kv_snapshot_drops_out_of_scope_keys(tmp_path):
    source_db = tmp_path / "source.vscdb"
    _seed_global_db(source_db)
    snap = export_disk_kv_snapshot(source_db, CID)
    assert snap is not None
    other_cid = "00000000-0000-4000-8000-000000000099"
    snap["rows"].append(
        {
            "key": f"composerData:{other_cid}",
            "value": "{}",
            "checksum": "0" * 64,
        }
    )
    rows = remap_disk_kv_snapshot_for_destination(snap, CID, DEST_WORKSPACE_IDENTIFIER)
    assert f"composerData:{other_cid}" not in rows
    assert f"composerData:{CID}" in rows


def test_merge_cursor_disk_kv_filters_out_of_scope_keys(tmp_path):
    dest_db = tmp_path / "dest-global.vscdb"
    conn = sqlite3.connect(dest_db)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
    conn.commit()
    conn.close()
    other_cid = "00000000-0000-4000-8000-000000000099"
    rows = {
        f"composerData:{CID}": "{}",
        f"composerData:{other_cid}": '{"evil": true}',
    }
    merge_cursor_disk_kv(dest_db, rows, dry_run=False, conversation_id=CID)
    conn = sqlite3.connect(dest_db)
    try:
        keys = {r[0] for r in conn.execute("SELECT key FROM cursorDiskKV;")}
    finally:
        conn.close()
    assert f"composerData:{CID}" in keys
    assert f"composerData:{other_cid}" not in keys


def test_is_disk_kv_key_in_conversation_scope():
    assert is_disk_kv_key_in_conversation_scope(f"composerData:{CID}", CID)
    assert is_disk_kv_key_in_conversation_scope(f"bubbleId:{CID}:abc", CID)
    assert not is_disk_kv_key_in_conversation_scope("composerData:other", CID)


def test_remap_disk_kv_snapshot_remaps_workspace_identifier(tmp_path):
    source_db = tmp_path / "source.vscdb"
    _seed_global_db(source_db)
    snap = export_disk_kv_snapshot(source_db, CID)
    assert snap is not None
    rows = remap_disk_kv_snapshot_for_destination(snap, CID, DEST_WORKSPACE_IDENTIFIER)
    composer = json.loads(rows[f"composerData:{CID}"])
    assert composer["workspaceIdentifier"]["id"] == DEST_WS_ID
    assert composer["workspaceIdentifier"]["uri"]["fsPath"] == DEST_FOLDER


def test_import_disk_kv_snapshot_preserves_tool_former_data(tmp_path):
    source_db = tmp_path / "source.vscdb"
    _seed_global_db(source_db)
    snap = export_disk_kv_snapshot(source_db, CID)
    assert snap is not None

    dest_db = tmp_path / "dest-global.vscdb"
    conn = sqlite3.connect(dest_db)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
    conn.commit()
    conn.close()

    rows = remap_disk_kv_snapshot_for_destination(snap, CID, DEST_WORKSPACE_IDENTIFIER)
    merge_cursor_disk_kv(dest_db, rows, dry_run=False)

    assert _tool_bubble_count(dest_db) >= 1
    conn = sqlite3.connect(dest_db)
    try:
        for _key, value in conn.execute(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?;",
            (f"bubbleId:{CID}:%",),
        ):
            obj = json.loads(value)
            if obj.get("toolFormerData"):
                assert obj["toolFormerData"]["name"] == "grep"
                assert obj["capabilityType"] == 15
                break
        else:
            raise AssertionError("no bubble with toolFormerData found")
    finally:
        conn.close()


def test_v1_bundle_without_disk_kv_uses_text_synthesis():
    bundle = {
        "schemaVersion": 1,
        "type": BUNDLE_TYPE,
        "conversationId": CID,
        "title": "text-only",
        "transcriptFiles": [],
        "sidebarSnapshot": None,
    }
    assert 1 in SUPPORTED_BUNDLE_SCHEMA_VERSIONS
    rows = build_cursor_disk_kv_rows_from_bundle(bundle, CID, DEST_WORKSPACE_IDENTIFIER)
    assert rows
    for value in rows.values():
        if value.startswith("{"):
            assert not json.loads(value).get("toolFormerData")


def test_import_with_disk_kv_snapshot_skips_synthesis(tmp_path, monkeypatch):
    source_db = tmp_path / "source.vscdb"
    _seed_global_db(source_db)
    snap = export_disk_kv_snapshot(source_db, CID)
    bundle_path = tmp_path / "bundle.json"
    bundle = {
        "schemaVersion": 2,
        "type": BUNDLE_TYPE,
        "conversationId": CID,
        "title": "tool chat",
        "transcriptFiles": [],
        "diskKvSnapshot": snap,
    }
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")

    dest_db = tmp_path / "global.vscdb"
    conn = sqlite3.connect(dest_db)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
    conn.execute(
        "CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);"
    )
    conn.commit()
    conn.close()

    ws_ctx = type(
        "Ctx",
        (),
        {
            "workspace_storage_id": DEST_WS_ID,
            "folder_fs_path": DEST_FOLDER,
            "chats_workspace_key": "deadbeef" * 4,
            "workspace_identifier": DEST_WORKSPACE_IDENTIFIER,
        },
    )()

    monkeypatch.setattr(
        "cursor_chat_io_import.resolve_workspace_context",
        lambda *_a, **_k: ws_ctx,
    )
    monkeypatch.setattr(
        "cursor_chat_io_import.global_state_db_path",
        lambda: dest_db,
    )
    monkeypatch.setattr(
        "cursor_chat_io_import.merge_targets_for_import",
        lambda *_a, **_k: [dest_db],
    )
    monkeypatch.setattr(
        "cursor_chat_io_import.verify_import_visibility",
        lambda *_a, **_k: [],
    )
    monkeypatch.setattr(
        "cursor_chat_io_import.verify_checks_all_ok",
        lambda *_a, **_k: True,
    )

    with patch(
        "cursor_chat_io_import.build_cursor_disk_kv_rows_from_bundle"
    ) as mock_build:
        import_bundle(
            bundle_path,
            target_project=None,
            target_workspace=None,
            state_db=None,
            dry_run=False,
            workspace_folder=DEST_FOLDER,
            sync_global=True,
        )
        mock_build.assert_not_called()

    assert _tool_bubble_count(dest_db) >= 1


def test_count_tool_bubbles_in_global_db(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_global_db(db)
    assert count_tool_bubbles_in_global_db(CID, db) >= 1


def _tool_bubble_check(checks):
    return next(c for c in checks if c.name == "global.diskKv.toolBubbles")


def test_verify_tool_bubbles_ok_when_present(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_global_db(db)
    snap = export_disk_kv_snapshot(db, CID)
    expected = snap["toolBubbleCount"]
    checks = verify_import_visibility(
        CID,
        None,
        expected_tool_bubble_count=expected,
        tool_bubble_global_db=db,
    )
    chk = _tool_bubble_check(checks)
    assert chk.status == "OK"
    assert "expected>=1" in chk.detail


def test_verify_tool_bubbles_fail_when_missing(tmp_path):
    db = tmp_path / "dest-empty.vscdb"
    conn = sqlite3.connect(db)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value TEXT);")
    conn.commit()
    conn.close()
    checks = verify_import_visibility(
        CID,
        None,
        expected_tool_bubble_count=1,
        tool_bubble_global_db=db,
    )
    chk = _tool_bubble_check(checks)
    assert chk.status == "FAIL"
    assert "expected>=1" in chk.detail
    assert not verify_checks_all_ok(checks)
