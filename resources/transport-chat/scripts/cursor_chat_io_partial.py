"""ChatBundle to createComposer partialState (cursor_chat_io split module)."""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from cursor_chat_io_disk_kv import (
    PARTIAL_STATE_STRIPPED,
    clear_session_binding_in_tree,
    rebind_composer_record,
)
from cursor_chat_io_headers import composer_timestamp_ms

def _bundle_created_at_ms(bundle: dict[str, Any]) -> int:
    raw_ts = bundle.get("createdAt")
    if isinstance(raw_ts, str):
        try:
            return int(
                datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).timestamp() * 1000
            )
        except ValueError:
            pass
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def _sidebar_header_row(
    sidebar_snapshot: dict[str, Any] | None, conversation_id: str
) -> dict[str, Any] | None:
    if not isinstance(sidebar_snapshot, dict):
        return None
    headers = sidebar_snapshot.get("composerHeaders")
    if not isinstance(headers, dict):
        return None
    for entry in headers.get("allComposers") or []:
        if isinstance(entry, dict) and entry.get("composerId") == conversation_id:
            return entry
    return None


def _sidebar_rich_composer_blob(
    sidebar_snapshot: dict[str, Any] | None, conversation_id: str
) -> dict[str, Any] | None:
    if not isinstance(sidebar_snapshot, dict):
        return None
    data = sidebar_snapshot.get("composerData")
    if not isinstance(data, dict):
        return None
    keyed = data.get(conversation_id)
    if isinstance(keyed, dict) and keyed:
        return keyed
    composers = data.get("allComposers")
    if isinstance(composers, list):
        for entry in composers:
            if isinstance(entry, dict) and entry.get("composerId") == conversation_id:
                return entry
    return None


def _merge_rich_composer_into_partial(
    partial: dict[str, Any], rich: dict[str, Any], conversation_id: str
) -> None:
    for key, value in rich.items():
        if key in PARTIAL_STATE_STRIPPED:
            continue
        if key == "composerId":
            continue
        partial[key] = value
    partial["composerId"] = conversation_id


def bundle_to_partial_state(
    bundle: dict[str, Any],
    conversation_id: str,
    *,
    workspace_identifier: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Build createComposer-style partialState from a ChatBundle (v1: preserve conversationId).
    Decodes storeSnapshot index only; does not rewrite store.db blobs.
    """
    cid = conversation_id.strip()
    snap = bundle.get("sidebarSnapshot")
    snap_dict = snap if isinstance(snap, dict) else None
    header = _sidebar_header_row(snap_dict, cid)

    title = bundle.get("title") if isinstance(bundle.get("title"), str) else None
    name = title or (header.get("name") if header else None) or cid

    ts = _bundle_created_at_ms(bundle)
    if header:
        ts = composer_timestamp_ms(header) or ts

    partial: dict[str, Any] = {
        "composerId": cid,
        "name": name,
        "type": (header.get("type") if header else None) or "head",
        "unifiedMode": (header.get("unifiedMode") if header else None) or "agent",
        "forceMode": (header.get("forceMode") if header else None) or "edit",
        "createdAt": header.get("createdAt") if header and header.get("createdAt") is not None else ts,
        "lastUpdatedAt": header.get("lastUpdatedAt")
        if header and header.get("lastUpdatedAt") is not None
        else ts,
        "lastOpenedAt": header.get("lastOpenedAt")
        if header and header.get("lastOpenedAt") is not None
        else ts,
    }

    wi = workspace_identifier
    if wi is None and isinstance(bundle.get("workspaceIdentifier"), dict):
        wi = bundle["workspaceIdentifier"]
    if wi is None and header and isinstance(header.get("workspaceIdentifier"), dict):
        wi = header["workspaceIdentifier"]
    if wi is not None:
        partial["workspaceIdentifier"] = wi

    if header:
        for field in (
            "subtitle",
            "hasUnreadMessages",
            "isArchived",
            "isDraft",
            "contextUsagePercent",
            "filesChangedCount",
            "conversationCheckpointLastUpdatedAt",
        ):
            if field in header:
                partial[field] = header[field]

    rich = _sidebar_rich_composer_blob(snap_dict, cid)
    if rich:
        _merge_rich_composer_into_partial(partial, rich, cid)

    wi_final = partial.get("workspaceIdentifier")
    if not isinstance(wi_final, dict):
        wi_final = workspace_identifier
    cleared = clear_session_binding_in_tree(partial)
    if isinstance(cleared, dict):
        partial = cleared
    if isinstance(wi_final, dict):
        partial = rebind_composer_record(partial, wi_final)
    return partial
