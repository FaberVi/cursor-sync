"""Disk KV export and agentKv snapshots (cursor_chat_io split module)."""
from __future__ import annotations

import base64
import importlib.util
import json
import re
import sqlite3
import sys
from pathlib import Path
from typing import Any

from cursor_chat_io_common import *

def is_disk_kv_key_in_conversation_scope(key: str, conversation_id: str) -> bool:
    if key == f"composerData:{conversation_id}":
        return True
    return key.startswith(f"bubbleId:{conversation_id}:")


def export_disk_kv_snapshot(global_db: Path, conversation_id: str) -> dict[str, Any] | None:
    if not global_db.is_file():
        return None
    conn = sqlite3.connect(global_db, timeout=20)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        keys = list_disk_kv_keys_for_conversation(conn, conversation_id)
        rows: list[dict[str, Any]] = []
        tool_count = 0
        for key in keys:
            try:
                value = read_disk_kv_value(conn, key)
            except sqlite3.DatabaseError:
                continue
            text = cursor_disk_kv_value_as_text(value)
            if text is None:
                continue
            rows.append(
                {
                    "key": key,
                    "value": text,
                    "checksum": sha256_hex(text.encode("utf-8")),
                }
            )
            try:
                obj = json.loads(text)
                if obj.get("toolFormerData"):
                    tool_count += 1
            except json.JSONDecodeError:
                pass
        if not rows:
            return None
        return {
            "sourceStateDbPath": str(global_db),
            "rows": rows,
            "rowCount": len(rows),
            "toolBubbleCount": tool_count,
        }
    finally:
        conn.close()


AGENT_KV_BLOB_PREFIX = "agentKv:blob:"
AGENT_KV_CHECKPOINT_PREFIX = "agentKv:checkpoint:"
AGENT_KV_BUBBLE_CHECKPOINT_PREFIX = "agentKv:bubbleCheckpoint:"
_HEX_HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")
_DETECTIVE_DECODE_TOOL = "cursor-detective/decode_conversation_state.py"


def _load_agentkv_decode_helpers() -> dict[str, Any] | None:
    script = (
        Path.home()
        / ".cursor"
        / "skills"
        / "cursor-detective"
        / "scripts"
        / "decode_conversation_state.py"
    )
    if not script.is_file():
        return None
    module_name = "cursor_detective_decode_conversation_state"
    spec = importlib.util.spec_from_file_location(module_name, script)
    if spec is None or spec.loader is None:
        return None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = mod
    spec.loader.exec_module(mod)
    return {
        "classify_conversation_state": mod.classify_conversation_state,
        "decode_tilde_envelope": mod.decode_tilde_envelope,
        "extract_blob_refs": mod.extract_blob_refs,
        "find_hex_hashes_in_json": mod.find_hex_hashes_in_json,
        "blob_prefix": getattr(mod, "BLOB_PREFIX", AGENT_KV_BLOB_PREFIX),
    }


def _read_varint(data: bytes, pos: int) -> tuple[int, int]:
    result = 0
    shift = 0
    while pos < len(data):
        b = data[pos]
        pos += 1
        result |= (b & 0x7F) << shift
        if (b & 0x80) == 0:
            return result, pos
        shift += 7
        if shift > 63:
            raise ValueError("varint too long")
    raise ValueError("truncated varint")


def _extract_blob_refs_tilde(data: bytes) -> list[str]:
    refs: list[str] = []
    pos = 0
    while pos < len(data):
        try:
            tag, pos = _read_varint(data, pos)
        except ValueError:
            break
        wire = tag & 7
        if wire == 0:
            try:
                _, pos = _read_varint(data, pos)
            except ValueError:
                break
        elif wire == 1:
            pos += 8
        elif wire == 2:
            try:
                length, pos = _read_varint(data, pos)
            except ValueError:
                break
            if pos + length > len(data):
                break
            chunk = data[pos : pos + length]
            pos += length
            if length == 32:
                refs.append(chunk.hex().lower())
        elif wire == 5:
            pos += 4
        else:
            break
    return refs


def _find_hex_hashes_in_json(obj: Any) -> list[str]:
    found: list[str] = []

    def walk(x: Any) -> None:
        if isinstance(x, dict):
            for v in x.values():
                walk(v)
        elif isinstance(x, list):
            for v in x:
                walk(v)
        elif isinstance(x, str) and _HEX_HASH_RE.match(x):
            found.append(x.lower())

    walk(obj)
    return sorted(set(found))


def _classify_conversation_state(value: Any) -> str:
    helpers = _load_agentkv_decode_helpers()
    if helpers is not None:
        return helpers["classify_conversation_state"](value)
    if value is None:
        return "absent"
    if isinstance(value, dict):
        return "inline_json"
    if not isinstance(value, str):
        return "other"
    if len(value) == 0:
        return "empty"
    if value == "~":
        return "placeholder"
    if value.startswith("~"):
        return "tilde_base64_protobuf"
    if value.startswith("{"):
        return "inline_json_string"
    return "opaque_string"


def _blob_refs_from_conversation_state(cs: Any) -> tuple[list[str], list[str]]:
    warnings: list[str] = []
    kind = _classify_conversation_state(cs)
    refs: list[str] = []
    helpers = _load_agentkv_decode_helpers()
    if kind == "tilde_base64_protobuf" and isinstance(cs, str):
        inner = None
        if helpers is not None:
            inner = helpers["decode_tilde_envelope"](cs)
        else:
            try:
                inner = base64.b64decode(cs[1:] + "==", validate=False)
            except Exception:
                inner = None
        if inner is None:
            warnings.append("conversationState ~ envelope failed base64 decode")
        else:
            if helpers is not None:
                refs = [h for _f, h in helpers["extract_blob_refs"](inner)]
            else:
                refs = _extract_blob_refs_tilde(inner)
    elif kind in ("inline_json",) and isinstance(cs, dict):
        if helpers is not None:
            refs = helpers["find_hex_hashes_in_json"](cs)
        else:
            refs = _find_hex_hashes_in_json(cs)
    elif kind == "inline_json_string" and isinstance(cs, str):
        try:
            parsed = json.loads(cs)
            if helpers is not None:
                refs = helpers["find_hex_hashes_in_json"](parsed)
            else:
                refs = _find_hex_hashes_in_json(parsed)
        except json.JSONDecodeError:
            warnings.append("conversationState inline JSON parse failed")
    return sorted(set(refs)), warnings


def _fetch_agentkv_row(conn: sqlite3.Connection, key: str) -> bytes | None:
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


def export_agent_kv_snapshot(
    global_db: Path, conversation_id: str
) -> dict[str, Any] | None:
    if not global_db.is_file():
        return None
    key_composer = f"composerData:{conversation_id}"
    conn = sqlite3.connect(global_db)
    try:
        row = conn.execute(
            "SELECT value FROM cursorDiskKV WHERE key = ?;", (key_composer,)
        ).fetchone()
        if not row or not row[0]:
            return None
        raw = row[0]
        if isinstance(raw, bytes):
            raw = raw.decode("utf-8")
        try:
            composer = json.loads(raw)
        except json.JSONDecodeError:
            return None
        if not isinstance(composer, dict):
            return None

        cs = composer.get("conversationState")
        kind = _classify_conversation_state(cs)
        blob_refs, ref_warnings = _blob_refs_from_conversation_state(cs)
        embedded = _find_hex_hashes_in_json(composer)
        for h in embedded:
            if h not in blob_refs:
                blob_refs.append(h)

        rows: list[dict[str, Any]] = []
        blob_count = 0
        checkpoint_count = 0
        seen_keys: set[str] = set()

        def add_row(
            key: str,
            payload: bytes,
            ref_source: str,
        ) -> None:
            nonlocal blob_count, checkpoint_count
            if key in seen_keys:
                return
            seen_keys.add(key)
            if key.startswith(AGENT_KV_BLOB_PREFIX):
                blob_count += 1
            elif key.startswith(AGENT_KV_CHECKPOINT_PREFIX) or key.startswith(
                AGENT_KV_BUBBLE_CHECKPOINT_PREFIX
            ):
                checkpoint_count += 1
            rows.append(
                {
                    "key": key,
                    "value": base64.b64encode(payload).decode("ascii"),
                    "encoding": "base64",
                    "checksum": sha256_hex(payload),
                    "refSource": ref_source,
                }
            )

        for blob_hash in blob_refs:
            key = f"{AGENT_KV_BLOB_PREFIX}{blob_hash}"
            payload = _fetch_agentkv_row(conn, key)
            if payload is None:
                ref_warnings.append(f"missing_agentKv_blob:{blob_hash}")
                continue
            add_row(key, payload, "conversationState")

        cp_key = f"{AGENT_KV_CHECKPOINT_PREFIX}{conversation_id}"
        cp_val = _fetch_agentkv_row(conn, cp_key)
        if cp_val is not None:
            add_row(cp_key, cp_val, "checkpoint")

        prefix_bc = f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{conversation_id}:"
        for bc_key, _ in conn.execute(
            "SELECT key, value FROM cursorDiskKV WHERE key LIKE ?;",
            (prefix_bc + "%",),
        ):
            if not isinstance(bc_key, str):
                continue
            payload = _fetch_agentkv_row(conn, bc_key)
            if payload is not None:
                add_row(bc_key, payload, "bubble_checkpoint")

        if not rows:
            return None
        return {
            "sourceStateDbPath": str(global_db),
            "conversationId": conversation_id,
            "rows": rows,
            "rowCount": len(rows),
            "blobCount": blob_count,
            "checkpointCount": checkpoint_count,
            "blobRefCount": len(blob_refs),
            "conversationStateKind": kind,
            "decodeTool": _DETECTIVE_DECODE_TOOL,
            "warnings": ref_warnings,
        }
    finally:
        conn.close()


def remap_agent_kv_snapshot_for_destination(
    snapshot: dict[str, Any],
    source_conversation_id: str,
    destination_conversation_id: str,
) -> dict[str, bytes]:
    rows_out: dict[str, bytes] = {}
    for row in snapshot.get("rows") or []:
        if not isinstance(row, dict):
            continue
        key = str(row.get("key", ""))
        if not key:
            continue
        enc = row.get("encoding")
        raw_b64 = row.get("value", "")
        if enc != "base64" or not isinstance(raw_b64, str):
            continue
        try:
            payload = base64.b64decode(raw_b64)
        except (ValueError, TypeError):
            continue
        if key.startswith(AGENT_KV_BLOB_PREFIX):
            rows_out[key] = payload
            continue
        if key == f"{AGENT_KV_CHECKPOINT_PREFIX}{source_conversation_id}":
            key = f"{AGENT_KV_CHECKPOINT_PREFIX}{destination_conversation_id}"
        elif key.startswith(f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{source_conversation_id}:"):
            suffix = key[len(f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{source_conversation_id}") :]
            key = f"{AGENT_KV_BUBBLE_CHECKPOINT_PREFIX}{destination_conversation_id}{suffix}"
        rows_out[key] = payload
    return rows_out


def merge_agent_kv_snapshot(
    db_path: Path,
    rows: dict[str, bytes],
    dry_run: bool,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    if not rows:
        warnings.append("No agentKv rows to write.")
        return False, warnings
    if dry_run:
        return True, warnings
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        for key, value in rows.items():
            conn.execute(
                "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?);",
                (key, sqlite3.Binary(value)),
            )
        conn.commit()
    finally:
        conn.close()
    return True, warnings
