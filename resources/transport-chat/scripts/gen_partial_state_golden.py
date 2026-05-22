#!/usr/bin/env python3
"""Regenerate tests/fixtures/chat-partial-state/golden-python.json from Python reference."""

from __future__ import annotations

import base64
import json
import sqlite3
import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]  # transport-chat skill root
sys.path.insert(0, str(ROOT / "scripts"))

from cursor_chat_io import (  # noqa: E402
    bundle_to_partial_state,
    decode_store_db_index,
    sha256_hex,
    sidebar_snapshot_has_composer_data,
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
FIXTURE_DIR = ROOT / "tests" / "fixtures" / "chat-partial-state"


def _make_store_db_bytes() -> bytes:
    meta = json.dumps(
        {
            "agentId": "ff80027c-12b6-4fe5-bb1a-e4d88bd2db05",
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
            for i in range(2):
                conn.execute(
                    "INSERT INTO blobs (id, data) VALUES (?, ?)",
                    (f"blob-{i}", b"\x00\x01"),
                )
            conn.commit()
        finally:
            conn.close()
        return Path(tmp.name).read_bytes()


def main() -> None:
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
        "conversationActionManager": {"y": 2},
    }
    header_only = {
        "schemaVersion": 1,
        "type": "chat-persistence",
        "createdAt": "2026-05-21T10:00:00+00:00",
        "conversationId": CID,
        "title": "Orchestrator chat",
        "subtitle": "",
        "previewText": "",
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
        "storeSnapshot": None,
        "transcriptFiles": [],
    }
    full_bundle = {
        "schemaVersion": 1,
        "type": "chat-persistence",
        "createdAt": "2026-05-21T10:00:00+00:00",
        "conversationId": CID,
        "title": "Store-backed chat",
        "subtitle": "",
        "previewText": "",
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
        "transcriptFiles": [],
    }

    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    golden = {
        "conversationId": CID,
        "workspaceIdentifier": WORKSPACE_IDENTIFIER,
        "partialHeaderOnly": bundle_to_partial_state(
            header_only, CID, workspace_identifier=WORKSPACE_IDENTIFIER
        ),
        "partialFull": bundle_to_partial_state(
            full_bundle, CID, workspace_identifier=WORKSPACE_IDENTIFIER
        ),
        "storeIndex": decode_store_db_index(store_raw),
        "sidebarHasComposerDataHeaderOnly": sidebar_snapshot_has_composer_data(
            header_only, CID
        ),
        "sidebarHasComposerDataFull": sidebar_snapshot_has_composer_data(full_bundle, CID),
    }

    (FIXTURE_DIR / "header-only-bundle.json").write_text(
        json.dumps(header_only, indent=2) + "\n", encoding="utf-8"
    )
    (FIXTURE_DIR / "full-bundle.json").write_text(
        json.dumps(full_bundle, indent=2) + "\n", encoding="utf-8"
    )
    (FIXTURE_DIR / "workspace-identifier.json").write_text(
        json.dumps(WORKSPACE_IDENTIFIER, indent=2) + "\n", encoding="utf-8"
    )
    (FIXTURE_DIR / "golden-python.json").write_text(
        json.dumps(golden, indent=2) + "\n", encoding="utf-8"
    )
    (FIXTURE_DIR / "store.db.b64").write_text(
        base64.b64encode(store_raw).decode("ascii") + "\n", encoding="utf-8"
    )
    print(f"wrote fixtures to {FIXTURE_DIR}")


if __name__ == "__main__":
    main()
