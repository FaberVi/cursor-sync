"""Composer header filter, merge, and pin (cursor_chat_io split module)."""
from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from typing import Any

def filter_composer_headers_for_conversation(
    headers: dict[str, Any], conversation_id: str
) -> dict[str, Any]:
    """Keep only sidebar rows for this chat (matches transcripts.ts export filter)."""
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return {"allComposers": []}
    kept = [
        c
        for c in composers
        if isinstance(c, dict) and c.get("composerId") == conversation_id
    ]
    return {"allComposers": kept}


def filter_composer_data_for_conversation(
    data: dict[str, Any], conversation_id: str
) -> dict[str, Any]:
    if not data:
        return {}
    out: dict[str, Any] = {}
    for key, value in data.items():
        if key == "allComposers" and isinstance(value, list):
            out[key] = [
                e
                for e in value
                if isinstance(e, dict) and e.get("composerId") == conversation_id
            ]
        elif key == conversation_id:
            out[key] = value
        elif not re.match(
            r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
            key,
            re.I,
        ):
            out[key] = value
    return out


def composer_timestamp_ms(record: dict[str, Any]) -> int:
    """Parse Cursor sidebar timestamps (epoch ms as number or string)."""
    best = 0
    for field in ("lastUpdatedAt", "lastOpenedAt", "createdAt"):
        raw = record.get(field)
        if isinstance(raw, (int, float)) and raw > 0:
            v = int(raw)
            best = max(best, v if v >= 1_000_000_000_000 else v * 1000)
        elif isinstance(raw, str) and raw.strip():
            if raw.strip().isdigit():
                v = int(raw.strip())
                best = max(best, v if v >= 1_000_000_000_000 else v * 1000)
            else:
                try:
                    d = datetime.fromisoformat(raw.replace("Z", "+00:00"))
                    best = max(best, int(d.timestamp() * 1000))
                except ValueError:
                    pass
    return best


def max_composer_timestamp_ms(headers: dict[str, Any]) -> int:
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return 0
    return max((composer_timestamp_ms(c) for c in composers if isinstance(c, dict)), default=0)


def pin_composer_as_most_recent(headers: dict[str, Any], conversation_id: str) -> dict[str, Any]:
    """Set imported chat timestamps above every other sidebar row."""
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return headers
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    pin_ms = max(max_composer_timestamp_ms(headers), now_ms) + 1
    updated: list[Any] = []
    found = False
    for entry in composers:
        if not isinstance(entry, dict):
            updated.append(entry)
            continue
        if entry.get("composerId") != conversation_id:
            updated.append(entry)
            continue
        found = True
        bumped = dict(entry)
        bumped["lastUpdatedAt"] = pin_ms
        bumped["lastOpenedAt"] = pin_ms
        if not bumped.get("type"):
            bumped["type"] = "head"
        bumped["hasUnreadMessages"] = False
        bumped["isArchived"] = False
        bumped["isDraft"] = False
        updated.append(bumped)
    if not found:
        derived = derive_headers_from_bundle({"conversationId": conversation_id, "title": conversation_id})
        if derived and derived.get("allComposers"):
            row = dict(derived["allComposers"][0])
            row["lastUpdatedAt"] = pin_ms
            row["lastOpenedAt"] = pin_ms
            updated.insert(0, row)
        return {**headers, "allComposers": updated}
    pinned_row: dict[str, Any] | None = None
    rest: list[Any] = []
    for entry in updated:
        if isinstance(entry, dict) and entry.get("composerId") == conversation_id:
            pinned_row = entry
        else:
            rest.append(entry)
    if pinned_row is not None:
        return {**headers, "allComposers": [pinned_row, *rest]}
    return {**headers, "allComposers": updated}


def headers_payload_for_import(bundle: dict[str, Any]) -> dict[str, Any]:
    """
    Build the composerHeaders payload to merge on import.
    Always includes the bundle conversationId (derived entry if missing from snapshot).
    """
    snap = bundle.get("sidebarSnapshot")
    cid = bundle.get("conversationId")
    if not isinstance(cid, str) or not cid.strip():
        return derive_headers_from_bundle(bundle) or {"allComposers": []}

    payloads: list[dict[str, Any]] = []
    if isinstance(snap, dict):
        raw_headers = snap.get("composerHeaders")
        if isinstance(raw_headers, dict):
            filtered = filter_composer_headers_for_conversation(raw_headers, cid)
            if filtered.get("allComposers"):
                payloads.append(filtered)
    payloads.append(derive_headers_from_bundle(bundle) or {"allComposers": []})
    return merge_headers_chain(None, payloads)


def parse_headers_blob(raw: str | None) -> dict[str, Any]:
    if not raw:
        return {"allComposers": []}
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError:
        return {"allComposers": []}
    if isinstance(parsed, dict) and isinstance(parsed.get("allComposers"), list):
        return parsed
    return {"allComposers": []}


def composer_id(record: dict[str, Any]) -> str:
    cid = record.get("composerId")
    return cid if isinstance(cid, str) and cid else ""


def merge_headers_additive(
    existing: dict[str, Any], imported: dict[str, Any]
) -> dict[str, Any]:
    by_id: dict[str, dict[str, Any]] = {}
    for c in existing.get("allComposers") or []:
        if isinstance(c, dict):
            i = composer_id(c)
            if i:
                by_id[i] = dict(c)
    for c in imported.get("allComposers") or []:
        if not isinstance(c, dict):
            continue
        i = composer_id(c)
        if not i:
            continue
        if i in by_id:
            merged = dict(by_id[i])
            merged.update(c)
            by_id[i] = merged
        else:
            by_id[i] = dict(c)
    result = []
    for entry in by_id.values():
        if not entry.get("type"):
            entry = {**entry, "type": "head"}
        result.append(entry)
    return {"allComposers": result}


def merge_headers_chain(existing_raw: str | None, payloads: list[dict[str, Any]]) -> dict[str, Any]:
    acc = parse_headers_blob(existing_raw)
    for p in payloads:
        acc = merge_headers_additive(acc, p)
    return acc


def merge_data_additive(existing_raw: str | None, payloads: list[dict[str, Any]]) -> dict[str, Any]:
    def parse_blob(raw: str | None) -> dict[str, Any]:
        if not raw or not raw.strip():
            return {}
        try:
            parsed = json.loads(raw)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}

    def merge_array(base: Any, imp: Any) -> list[dict[str, Any]] | None:
        if not isinstance(base, list) or not isinstance(imp, list):
            return None
        by_id: dict[str, dict[str, Any]] = {}
        for entry in base:
            if isinstance(entry, dict):
                i = composer_id(entry)
                if i:
                    by_id[i] = dict(entry)
        for entry in imp:
            if isinstance(entry, dict):
                i = composer_id(entry)
                if i:
                    if i in by_id:
                        m = dict(by_id[i])
                        m.update(entry)
                        by_id[i] = m
                    else:
                        by_id[i] = dict(entry)
        return list(by_id.values())

    merged = parse_blob(existing_raw)
    for imported in payloads:
        nxt = dict(merged)
        for key, value in imported.items():
            if key not in nxt:
                nxt[key] = value
                continue
            arr = merge_array(nxt[key], value)
            if arr is not None:
                nxt[key] = arr
        merged = nxt
    return merged


def derive_headers_from_bundle(bundle: dict[str, Any]) -> dict[str, Any] | None:
    cid = bundle.get("conversationId")
    if not isinstance(cid, str) or not cid.strip():
        return None
    title = bundle.get("title") if isinstance(bundle.get("title"), str) else cid
    raw_ts = bundle.get("createdAt")
    if isinstance(raw_ts, str):
        try:
            ts = int(datetime.fromisoformat(raw_ts.replace("Z", "+00:00")).timestamp() * 1000)
        except ValueError:
            ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    else:
        ts = int(datetime.now(timezone.utc).timestamp() * 1000)
    return {
        "allComposers": [
            {
                "type": "head",
                "composerId": cid,
                "name": title,
                "subtitle": bundle.get("subtitle") or "",
                "lastUpdatedAt": ts,
                "lastOpenedAt": ts,
                "createdAt": ts,
                "hasUnreadMessages": False,
                "isArchived": False,
                "isDraft": False,
                "unifiedMode": "agent",
                "forceMode": "edit",
            }
        ]
    }
