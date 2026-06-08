import base64
import json
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(
    0,
    str(Path(__file__).resolve().parents[1] / "resources" / "transport-chat" / "scripts"),
)

from cursor_chat_io import (  # noqa: E402
    bundle_to_partial_state,
    decode_store_db_index,
    sha256_hex,
)

CID = "43aae2fb-71fc-4e9c-9add-3e995caaaa80"
WS_ID = "f038a5d2e2e5594b5e779064d4feac57"
WORKSPACE_IDENTIFIER = {
    "id": WS_ID,
    "uri": {
        "$mid": 1,
        "fsPath": "/home/user/proj",
        "_sep": 47,
        "external": "file:///home/user/proj",
        "path": "/home/user/proj",
        "scheme": "file",
    },
}


def _make_store_db_bytes(
    *,
    agent_id: str = "ff80027c-12b6-4fe5-bb1a-e4d88bd2db05",
    blob_count: int = 2,
) -> bytes:
    meta = json.dumps(
        {
            "agentId": agent_id,
            "latestRootBlobId": "root-blob-1",
            "name": "New Agent",
            "mode": "default",
            "isRunEverywhere": True,
            "createdAt": 1779369862871,
        },
        separators=(",", ":"),
    )
    with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
        conn = sqlite3.connect(tmp.name)
        try:
            conn.execute("CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)")
            conn.execute("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)")
            conn.execute("INSERT INTO meta (key, value) VALUES ('0', ?)", (meta,))
            for i in range(blob_count):
                conn.execute(
                    "INSERT INTO blobs (id, data) VALUES (?, ?)",
                    (f"blob-{i}", b"\x00\x01"),
                )
            conn.commit()
        finally:
            conn.close()
        return Path(tmp.name).read_bytes()


class TestPartialState(unittest.TestCase):
    def test_header_only_bundle_minimal_partial_state(self):
        bundle = {
            "schemaVersion": 1,
            "type": "chat-persistence",
            "createdAt": "2026-05-21T10:00:00+00:00",
            "conversationId": CID,
            "title": "Orchestrator chat",
            "sidebarSnapshot": {
                "composerHeaders": {
                    "allComposers": [
                        {
                            "type": "head",
                            "composerId": CID,
                            "name": "Orchestrator chat",
                            "unifiedMode": "agent",
                            "forceMode": "edit",
                            "createdAt": 1716283200000,
                            "lastUpdatedAt": 1716283200000,
                            "lastOpenedAt": 1716283200000,
                        }
                    ]
                },
                "composerData": {
                    "selectedComposerIds": [CID],
                    "lastFocusedComposerIds": [CID],
                },
            },
        }
        partial = bundle_to_partial_state(
            bundle, CID, workspace_identifier=WORKSPACE_IDENTIFIER
        )
        self.assertEqual(partial["composerId"], CID)
        self.assertEqual(partial["name"], "Orchestrator chat")
        self.assertEqual(partial["type"], "head")
        self.assertEqual(partial["unifiedMode"], "agent")
        self.assertEqual(partial["forceMode"], "edit")
        self.assertEqual(partial["workspaceIdentifier"], WORKSPACE_IDENTIFIER)
        self.assertNotIn("conversationMap", partial)
        self.assertNotIn("fullConversationHeadersOnly", partial)
        self.assertNotIn("agentSessionId", partial)

    def test_full_sidebar_and_store_bundle(self):
        store_raw = _make_store_db_bytes()
        rich_blob = {
            "composerId": CID,
            "fullConversationHeadersOnly": [{"bubbleId": "b1", "type": 1}],
            "conversationMap": {"b1": {"id": "b1"}},
            "conversationState": "encrypted-placeholder",
            "hasLoaded": True,
            "status": "completed",
            "modelConfig": {"modelName": "default"},
            "agentSessionId": "must-strip",
            "capabilities": {"x": 1},
            "requestId": "source-session-request-must-clear",
            "workspaceUris": ["/old/workspace"],
        }
        bundle = {
            "schemaVersion": 1,
            "type": "chat-persistence",
            "createdAt": "2026-05-21T10:00:00+00:00",
            "conversationId": CID,
            "title": "Store-backed chat",
            "sidebarSnapshot": {
                "composerHeaders": {
                    "allComposers": [
                        {
                            "type": "head",
                            "composerId": CID,
                            "name": "Store-backed chat",
                            "unifiedMode": "agent",
                            "forceMode": "edit",
                            "createdAt": 1716283200000,
                            "lastUpdatedAt": 1716283300000,
                            "lastOpenedAt": 1716283300000,
                        }
                    ]
                },
                "composerData": {CID: rich_blob},
            },
            "storeSnapshot": {
                "content": base64.b64encode(store_raw).decode("ascii"),
                "encoding": "base64",
                "checksum": sha256_hex(store_raw),
                "sizeBytes": len(store_raw),
                "sourceWorkspaceKey": WS_ID,
            },
        }
        partial = bundle_to_partial_state(
            bundle, CID, workspace_identifier=WORKSPACE_IDENTIFIER
        )
        self.assertEqual(partial["composerId"], CID)
        self.assertEqual(partial["conversationMap"], rich_blob["conversationMap"])
        self.assertEqual(
            partial["fullConversationHeadersOnly"],
            rich_blob["fullConversationHeadersOnly"],
        )
        self.assertEqual(partial["conversationState"], "encrypted-placeholder")
        self.assertTrue(partial["hasLoaded"])
        self.assertEqual(partial["status"], "completed")
        self.assertNotIn("agentSessionId", partial)
        self.assertNotIn("capabilities", partial)
        self.assertEqual(partial.get("requestId"), "")
        self.assertEqual(partial.get("workspaceUris"), [])
        self.assertEqual(
            partial.get("workspaceIdentifier", {}).get("id"),
            WORKSPACE_IDENTIFIER["id"],
        )

        index = decode_store_db_index(store_raw)
        self.assertEqual(index["blobCount"], 2)
        self.assertIn("0", index["meta"])
        meta_row = index["meta"]["0"]
        self.assertIsInstance(meta_row, dict)
        self.assertEqual(meta_row.get("agentId"), "ff80027c-12b6-4fe5-bb1a-e4d88bd2db05")
        self.assertEqual(meta_row.get("latestRootBlobId"), "root-blob-1")


if __name__ == "__main__":
    unittest.main()
