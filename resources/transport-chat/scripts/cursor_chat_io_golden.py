"""Golden store template helpers and transcript blob builders (cursor_chat_io split module)."""
from __future__ import annotations

import base64
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

def first_user_text_from_bytes(raw: bytes) -> str:
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        return ""
    for line in text.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            continue
        if obj.get("role") != "user":
            continue
        msg = obj.get("message") or {}
        content = msg.get("content")
        if isinstance(content, list):
            for block in content:
                if isinstance(block, dict) and block.get("type") == "text":
                    t = block.get("text", "")
                    if isinstance(t, str) and t.strip():
                        return t.strip()[:80]
    return ""


def decode_artifact(content: str, encoding: str | None) -> bytes:
    if encoding == "base64":
        return base64.b64decode(content)
    return content.encode("utf-8")


GOLDEN_STORE_TEMPLATE_VERSION = 2


def skill_resources_dir() -> Path:
    return Path(__file__).resolve().parent.parent / "resources"


def resolve_golden_store_template_path() -> Path | None:
    candidates = [
        skill_resources_dir() / "golden-chat-store.template.db",
        Path(os.environ.get("CURSOR_SYNC_GOLDEN_STORE", "")),
        Path.home() / "dev/private/cursor-sync/resources/golden-chat-store.template.db",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def read_template_user_version(db_path: Path) -> int | None:
    try:
        conn = sqlite3.connect(db_path)
        try:
            row = conn.execute("PRAGMA user_version;").fetchone()
            if row and row[0] is not None:
                return int(row[0])
        finally:
            conn.close()
    except sqlite3.Error:
        return None
    return None


def assert_golden_template_layout(db_path: Path) -> None:
    ver = read_template_user_version(db_path)
    if ver != GOLDEN_STORE_TEMPLATE_VERSION:
        raise RuntimeError(
            f"Golden store template user_version mismatch: expected "
            f"{GOLDEN_STORE_TEMPLATE_VERSION}, got {ver!r}. "
            "Regenerate resources/golden-chat-store.template.db."
        )
    conn = sqlite3.connect(db_path)
    try:
        blob_cols = {row[1] for row in conn.execute("PRAGMA table_info(blobs);").fetchall()}
        meta_cols = {row[1] for row in conn.execute("PRAGMA table_info(meta);").fetchall()}
    finally:
        conn.close()
    if "data" not in blob_cols or "value" not in meta_cols:
        raise RuntimeError(
            "Golden store template missing expected columns blobs(id,data) and meta(key,value). "
            "Regenerate resources/golden-chat-store.template.db."
        )


def bundle_created_at_ms(bundle: dict[str, Any]) -> int:
    raw = bundle.get("createdAt")
    if isinstance(raw, str) and raw.strip():
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
            return int(dt.timestamp() * 1000)
        except ValueError:
            pass
    return int(datetime.now(timezone.utc).timestamp() * 1000)


def messages_from_chat_bundle(bundle: dict[str, Any]) -> list[dict[str, str]]:
    messages: list[dict[str, str]] = []
    for tf in bundle.get("transcriptFiles") or []:
        if not isinstance(tf, dict):
            continue
        try:
            raw = decode_artifact(tf.get("content", ""), tf.get("encoding"))
            text = raw.decode("utf-8", errors="replace")
        except (ValueError, TypeError):
            continue
        for line in text.splitlines():
            row = line.strip()
            if not row:
                continue
            try:
                parsed = json.loads(row)
            except json.JSONDecodeError:
                continue
            if not isinstance(parsed, dict):
                continue
            role = parsed.get("role") or "user"
            if role not in ("user", "assistant", "tool"):
                role = "user"
            parts = (parsed.get("message") or {}).get("content") or []
            content = ""
            if isinstance(parts, list):
                content = "\n".join(
                    str(p.get("text", ""))
                    for p in parts
                    if isinstance(p, dict) and p.get("type") == "text"
                )
            if content.strip():
                messages.append({"role": role, "content": content})
    return messages


def chat_manifest_from_bundle(bundle: dict[str, Any]) -> dict[str, Any]:
    cid = str(bundle.get("conversationId", ""))
    title = str(bundle.get("title") or cid).strip() or cid
    content = messages_from_chat_bundle(bundle)
    if not content:
        preview = str(bundle.get("previewText") or title)
        content = [{"role": "user", "content": preview}]
    return {
        "chat_id": cid,
        "title": title[:120],
        "content": content,
        "timestamp": bundle_created_at_ms(bundle),
    }


def build_cursor_message_blob_bytes(chat: dict[str, Any]) -> list[bytes]:
    blobs: list[bytes] = []
    for m in chat.get("content") or []:
        if not isinstance(m, dict):
            continue
        role = m.get("role") or "user"
        if role not in ("user", "assistant", "tool"):
            role = "user"
        text = str(m.get("content", ""))
        payload = json.dumps(
            {"role": role, "content": [{"type": "text", "text": text}]},
            separators=(",", ":"),
            ensure_ascii=False,
        )
        blobs.append(payload.encode("utf-8"))
    return blobs


def build_cursor_tree_blob(ref_hashes_hex: list[str]) -> bytes:
    parts: list[bytes] = []
    for hex_hash in ref_hashes_hex:
        parts.append(b"\x0a\x20")
        parts.append(bytes.fromhex(hex_hash))
    parts.append(b"\x2a\x00")
    return b"".join(parts)


def chat_timestamp_ms(chat: dict[str, Any]) -> int:
    ts = chat.get("timestamp")
    if isinstance(ts, (int, float)):
        v = int(ts)
        return v if v >= 1_000_000_000_000 else v * 1000
    if isinstance(ts, str) and ts.strip().isdigit():
        v = int(ts.strip())
        return v if v >= 1_000_000_000_000 else v * 1000
    return bundle_created_at_ms({"createdAt": ""})

