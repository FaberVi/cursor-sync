#!/usr/bin/env python3
"""Emit golden JSON for chat-import-merge vitest fixtures (Python reference)."""
from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))

import cursor_chat_io as io  # noqa: E402

FIX = ROOT / "tests" / "fixtures" / "chat-import-merge"


def main() -> None:
    bundle = json.loads((FIX / "bundle.json").read_text(encoding="utf-8"))
    wi = json.loads((FIX / "workspace-identifier.json").read_text(encoding="utf-8"))
    cid = bundle["conversationId"]
    existing_headers = json.loads((FIX / "existing-headers.json").read_text(encoding="utf-8"))
    existing_data = json.loads((FIX / "existing-data.json").read_text(encoding="utf-8"))

    snap = bundle["sidebarSnapshot"]
    filtered_headers = io.filter_composer_headers_for_conversation(snap["composerHeaders"], cid)
    filtered_data = io.filter_composer_data_for_conversation(snap["composerData"], cid)
    headers_payload = io.headers_payload_for_import(bundle)

    pin_ms = 1710000000001
    io.datetime = type(
        "dt",
        (),
        {
            "now": staticmethod(
                lambda tz=None: datetime(2026, 3, 30, 12, 0, 0, 1000, tzinfo=timezone.utc)
            )
        },
    )

    pinned = io.pin_composer_as_most_recent(headers_payload, cid)
    for row in pinned.get("allComposers") or []:
        if isinstance(row, dict) and row.get("composerId") == cid:
            row["lastUpdatedAt"] = pin_ms
            row["lastOpenedAt"] = pin_ms

    stamped = io.stamp_workspace_identifier_on_headers(pinned, cid, wi)
    focus = io.composer_data_for_focus(cid, json.dumps(existing_data))
    if filtered_data:
        focus = io.merge_data_additive(json.dumps(focus), [filtered_data])

    merged_chain = io.merge_headers_chain(
        json.dumps(existing_headers), [headers_payload]
    )
    merged_chain_pinned = io.pin_composer_as_most_recent(merged_chain, cid)
    for row in merged_chain_pinned.get("allComposers") or []:
        if isinstance(row, dict) and row.get("composerId") == cid:
            row["lastUpdatedAt"] = pin_ms
            row["lastOpenedAt"] = pin_ms
    prepared_headers = io.stamp_workspace_identifier_on_headers(
        merged_chain_pinned, cid, wi
    )

    out = {
        "filterComposerHeadersForConversation": filtered_headers,
        "filterComposerDataForConversation": filtered_data,
        "headersPayloadForImport": headers_payload,
        "pinComposerAsMostRecent": pinned,
        "stampWorkspaceIdentifierOnHeaders": stamped,
        "composerDataForFocus": focus,
        "prepareHeadersForImport": prepared_headers,
    }

    (FIX / "golden-python.json").write_text(
        json.dumps(out, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    print((FIX / "golden-python.json"))


if __name__ == "__main__":
    main()
