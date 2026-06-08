import json
import sqlite3
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from cursor_chat_io_bundle import merge_state_db  # noqa: E402
from cursor_chat_io_common import WorkspaceContext, read_composer_header_entry  # noqa: E402

CID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
DEST_WS_ID = "dest-ws-storage-id000000000001"
DEST_FOLDER = "/tmp/dest-workspace-folder"
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
DEST_CTX = WorkspaceContext(
    workspace_storage_id=DEST_WS_ID,
    folder_fs_path=DEST_FOLDER,
    chats_workspace_key="abc123",
    workspace_identifier=DEST_WORKSPACE_IDENTIFIER,
)


def _seed_blob_item_table(db_path: Path) -> None:
    headers = json.dumps(
        {"allComposers": [{"composerId": CID, "name": "existing", "type": "head"}]}
    )
    data = json.dumps({"selectedComposerIds": [], "lastFocusedComposerIds": []})
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)")
    conn.execute(
        "INSERT INTO ItemTable VALUES (?, ?)",
        ("composer.composerHeaders", headers.encode("utf-8")),
    )
    conn.execute(
        "INSERT INTO ItemTable VALUES (?, ?)",
        ("composer.composerData", data.encode("utf-8")),
    )
    conn.commit()
    conn.close()


def test_read_composer_header_entry_reads_blob_item_table(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_blob_item_table(db)
    ent = read_composer_header_entry(db, CID)
    assert ent is not None
    assert ent.get("composerId") == CID


def test_merge_state_db_reads_blob_item_table(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_blob_item_table(db)
    bundle = {
        "conversationId": CID,
        "sidebarSnapshot": {
            "composerHeaders": {
                "allComposers": [
                    {
                        "composerId": CID,
                        "name": "imported",
                        "type": "head",
                        "lastUpdatedAt": 1,
                    }
                ]
            }
        },
    }
    ok, _warnings = merge_state_db(db, bundle, dry_run=False)
    assert ok
    conn = sqlite3.connect(db)
    try:
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'"
        ).fetchone()
        assert row is not None
        raw = row[0]
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        parsed = json.loads(raw)
        ids = [c.get("composerId") for c in parsed.get("allComposers") or []]
        assert CID in ids
    finally:
        conn.close()


def test_merge_state_db_rebinds_item_table_composer_data_workspace(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_blob_item_table(db)
    bundle = {
        "conversationId": CID,
        "sidebarSnapshot": {
            "composerHeaders": {
                "allComposers": [
                    {
                        "composerId": CID,
                        "name": "imported",
                        "type": "head",
                        "lastUpdatedAt": 1,
                        "workspaceIdentifier": {
                            "id": "source-ws-id",
                            "uri": {"fsPath": "/source/repo"},
                        },
                    }
                ]
            },
            "composerData": {
                CID: {
                    "composerId": CID,
                    "agentSessionId": "source-session",
                    "workspaceIdentifier": {
                        "id": "source-ws-id",
                        "uri": {"fsPath": "/source/repo"},
                    },
                }
            },
        },
    }
    ok, _warnings = merge_state_db(
        db, bundle, dry_run=False, workspace_ctx=DEST_CTX
    )
    assert ok
    conn = sqlite3.connect(db)
    try:
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerData'"
        ).fetchone()
        assert row is not None
        raw = row[0]
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        parsed = json.loads(raw)
        blob = parsed[CID]
        assert blob["workspaceIdentifier"]["id"] == DEST_WS_ID
        assert blob["workspaceIdentifier"]["uri"]["fsPath"] == DEST_FOLDER
        assert "agentSessionId" not in blob
        headers_row = conn.execute(
            "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders'"
        ).fetchone()
        headers = json.loads(
            headers_row[0].decode("utf-8")
            if isinstance(headers_row[0], bytes)
            else headers_row[0]
        )
        header = next(
            c for c in headers["allComposers"] if c.get("composerId") == CID
        )
        assert header["workspaceIdentifier"]["id"] == DEST_WS_ID
    finally:
        conn.close()
