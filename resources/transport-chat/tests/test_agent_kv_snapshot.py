import base64
import json
import sqlite3
import sys
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parents[1] / "scripts"
sys.path.insert(0, str(SCRIPT_DIR))

from cursor_chat_io import (  # noqa: E402
    BUNDLE_TYPE,
    export_agent_kv_snapshot,
    merge_agent_kv_snapshot,
    merge_cursor_disk_kv,
    remap_agent_kv_snapshot_for_destination,
)
from cursor_chat_io_import import import_bundle  # noqa: E402

CID = "fixture-agentkv-00000000-0000-4000-8000-000000000002"
DEST_CID = "dest-agentkv-00000000-0000-4000-8000-000000000003"
IMPORT_CID = CID
BLOB_HASH = "ab" * 32
BLOB_PAYLOAD = b"\x00\x01fixture-agentkv-blob-payload"
CHECKPOINT_PAYLOAD = b"fixture-checkpoint-bytes"
BUBBLE_CP_PAYLOAD = b"fixture-bubble-checkpoint"


def _tilde_envelope_for_hash(blob_hash_hex: str) -> str:
    chunk = bytes.fromhex(blob_hash_hex)
    assert len(chunk) == 32
    inner = b"\x0a\x20" + chunk
    return "~" + base64.b64encode(inner).decode("ascii")


def _seed_agent_kv_global_db(db_path: Path) -> None:
    composer = {
        "_v": 16,
        "composerId": CID,
        "name": "NAL agent fixture",
        "isNAL": True,
        "isAgentic": True,
        "unifiedMode": "agent",
        "conversationState": _tilde_envelope_for_hash(BLOB_HASH),
        "fullConversationHeadersOnly": [],
        "conversationMap": {},
    }
    conn = sqlite3.connect(db_path)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);")
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"composerData:{CID}", json.dumps(composer, separators=(",", ":")).encode("utf-8")),
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"agentKv:blob:{BLOB_HASH}", sqlite3.Binary(BLOB_PAYLOAD)),
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (f"agentKv:checkpoint:{CID}", sqlite3.Binary(CHECKPOINT_PAYLOAD)),
    )
    conn.execute(
        "INSERT INTO cursorDiskKV VALUES (?, ?);",
        (
            f"agentKv:bubbleCheckpoint:{CID}:bubble-1",
            sqlite3.Binary(BUBBLE_CP_PAYLOAD),
        ),
    )
    conn.commit()
    conn.close()


def _fetch_blob(db_path: Path, key: str) -> bytes | None:
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT value FROM cursorDiskKV WHERE key = ?;", (key,)
        ).fetchone()
        if not row or row[0] is None:
            return None
        val = row[0]
        if isinstance(val, memoryview):
            return bytes(val)
        if isinstance(val, bytes):
            return val
        return val.encode("latin-1", errors="surrogateescape")
    finally:
        conn.close()


def test_export_agent_kv_snapshot_collects_blob_and_checkpoints(tmp_path):
    db = tmp_path / "state.vscdb"
    _seed_agent_kv_global_db(db)
    snap = export_agent_kv_snapshot(db, CID)
    assert snap is not None
    assert snap["blobRefCount"] >= 1
    assert snap["blobCount"] >= 1
    assert snap["checkpointCount"] >= 1
    assert snap["conversationStateKind"] == "tilde_base64_protobuf"
    keys = {r["key"] for r in snap["rows"]}
    assert f"agentKv:blob:{BLOB_HASH}" in keys
    assert f"agentKv:checkpoint:{CID}" in keys
    assert f"agentKv:bubbleCheckpoint:{CID}:bubble-1" in keys


def test_import_agent_kv_merges_after_disk_kv(tmp_path, monkeypatch):
    source_db = tmp_path / "source.vscdb"
    _seed_agent_kv_global_db(source_db)
    agent_snap = export_agent_kv_snapshot(source_db, CID)
    assert agent_snap is not None

    disk_snap = {
        "sourceStateDbPath": str(source_db),
        "rows": [
            {
                "key": f"composerData:{CID}",
                "value": json.dumps(
                    {
                        "_v": 16,
                        "composerId": CID,
                        "conversationState": _tilde_envelope_for_hash(BLOB_HASH),
                    }
                ),
                "checksum": "00",
            }
        ],
        "rowCount": 1,
        "toolBubbleCount": 0,
    }

    bundle_path = tmp_path / "bundle.json"
    bundle = {
        "schemaVersion": 2,
        "type": BUNDLE_TYPE,
        "conversationId": IMPORT_CID,
        "title": "agent kv",
        "transcriptFiles": [],
        "diskKvSnapshot": disk_snap,
        "agentKvSnapshot": agent_snap,
    }
    bundle_path.write_text(json.dumps(bundle), encoding="utf-8")

    dest_db = tmp_path / "dest-global.vscdb"
    conn = sqlite3.connect(dest_db)
    conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);")
    conn.execute("CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value TEXT);")
    conn.commit()
    conn.close()

    merge_order: list[str] = []

    def track_disk_merge(*args, **kwargs):
        merge_order.append("diskKv")
        return merge_cursor_disk_kv(*args, **kwargs)

    def track_agent_merge(*args, **kwargs):
        merge_order.append("agentKv")
        return merge_agent_kv_snapshot(*args, **kwargs)

    ws_ctx = type(
        "Ctx",
        (),
        {
            "workspace_storage_id": "dest-ws",
            "folder_fs_path": "/tmp/agent-kv-dest",
            "chats_workspace_key": "deadbeef" * 4,
            "workspace_identifier": None,
        },
    )()

    monkeypatch_targets = {
        "cursor_chat_io_import.resolve_workspace_context": lambda *_a, **_k: ws_ctx,
        "cursor_chat_io_import.global_state_db_path": lambda: dest_db,
        "cursor_chat_io_import.merge_targets_for_import": lambda *_a, **_k: [dest_db],
        "cursor_chat_io_import.verify_import_visibility": lambda *_a, **_k: [],
        "cursor_chat_io_import.verify_checks_all_ok": lambda *_a, **_k: True,
    }

    monkeypatch.setattr(
        "cursor_chat_io_import.merge_cursor_disk_kv", track_disk_merge
    )
    monkeypatch.setattr(
        "cursor_chat_io_import.merge_agent_kv_snapshot", track_agent_merge
    )
    for target, fn in monkeypatch_targets.items():
        monkeypatch.setattr(target, fn)

    import_bundle(
        bundle_path,
        target_project=None,
        target_workspace=None,
        state_db=None,
        dry_run=False,
        workspace_folder="/tmp/agent-kv-dest",
        sync_global=True,
    )

    assert merge_order == ["diskKv", "agentKv"]
    assert _fetch_blob(dest_db, f"agentKv:blob:{BLOB_HASH}") == BLOB_PAYLOAD
    assert (
        _fetch_blob(dest_db, f"agentKv:checkpoint:{IMPORT_CID}") == CHECKPOINT_PAYLOAD
    )
    assert (
        _fetch_blob(dest_db, f"agentKv:bubbleCheckpoint:{IMPORT_CID}:bubble-1")
        == BUBBLE_CP_PAYLOAD
    )


def test_remap_agent_kv_snapshot_remaps_checkpoint_keys(tmp_path):
    source_db = tmp_path / "source.vscdb"
    _seed_agent_kv_global_db(source_db)
    snap = export_agent_kv_snapshot(source_db, CID)
    assert snap is not None
    rows = remap_agent_kv_snapshot_for_destination(snap, CID, DEST_CID)
    assert f"agentKv:blob:{BLOB_HASH}" in rows
    assert f"agentKv:checkpoint:{DEST_CID}" in rows
    assert f"agentKv:checkpoint:{CID}" not in rows
    assert f"agentKv:bubbleCheckpoint:{DEST_CID}:bubble-1" in rows
