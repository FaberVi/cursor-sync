"""Shared constants, workspace resolution, verification, discovery (cursor_chat_io split module)."""
from __future__ import annotations

import hashlib
import json
import os
import re
import sqlite3
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cursor_chat_io_headers import composer_timestamp_ms, max_composer_timestamp_ms
from cursor_chat_io_workspace import *

SCHEMA_VERSION = 1
BUNDLE_TYPE = "chat-persistence"
UUID_RE = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.I,
)


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def escape_sql_literal(value: str) -> str:
    return value.replace("'", "''")

ACTIVATION_DIR = Path.home() / ".cursor" / "import-activation"
ACTIVATION_PENDING_PATH = ACTIVATION_DIR / "pending.json"
ACTIVATION_RESULT_PATH = ACTIVATION_DIR / "result.json"
COMPOSER_BRIDGE_SCRIPT = Path(__file__).resolve().parent / "cursor_composer_bridge.py"

def agent_debug_log(
    hypothesis_id: str,
    location: str,
    message: str,
    data: dict[str, Any],
    run_id: str = "repro",
) -> None:
    log_path = os.environ.get("CURSOR_SYNC_DEBUG_LOG")
    if not log_path:
        return
    try:
        payload = {
            "sessionId": os.environ.get("CURSOR_SYNC_DEBUG_SESSION", "debug"),
            "runId": run_id,
            "hypothesisId": hypothesis_id,
            "location": location,
            "message": message,
            "data": data,
            "timestamp": int(datetime.now(timezone.utc).timestamp() * 1000),
        }
        with Path(log_path).open("a", encoding="utf-8") as f:
            f.write(json.dumps(payload, separators=(",", ":")) + "\n")
    except OSError:
        pass

def composer_data_for_focus(conversation_id: str, existing_raw: str | None) -> dict[str, Any]:
    base: dict[str, Any] = {}
    if existing_raw and existing_raw.strip():
        try:
            parsed = json.loads(existing_raw)
            if isinstance(parsed, dict):
                base = parsed
        except json.JSONDecodeError:
            pass
    merged = dict(base)
    merged["selectedComposerIds"] = [conversation_id]
    merged["lastFocusedComposerIds"] = [conversation_id]
    merged.setdefault("hasMigratedComposerData", True)
    merged.setdefault("hasMigratedMultipleComposers", True)
    return merged

def global_state_db_path() -> Path:
    return cursor_config_root() / "globalStorage" / "state.vscdb"


def sqlite_integrity_ok(db_path: Path) -> bool:
    if not db_path.is_file():
        return False
    try:
        conn = sqlite3.connect(db_path, timeout=5)
        conn.execute("PRAGMA busy_timeout=3000")
        row = conn.execute("PRAGMA integrity_check").fetchone()
        conn.close()
        return bool(row and row[0] == "ok")
    except sqlite3.Error:
        return False


def list_state_db_candidates() -> list[Path]:
    root = cursor_config_root()
    out: list[Path] = []
    global_db = root / "globalStorage" / "state.vscdb"
    if global_db.is_file():
        out.append(global_db)
    ws_root = root / "workspaceStorage"
    if ws_root.is_dir():
        for ent in sorted(ws_root.iterdir()):
            if ent.is_dir():
                p = ent / "state.vscdb"
                if p.is_file():
                    out.append(p)
    return out


def find_store_db(conversation_id: str) -> tuple[Path, str] | None:
    root = chats_root()
    if not root.is_dir():
        return None
    for ws in sorted(root.iterdir()):
        if not ws.is_dir():
            continue
        candidate = ws / conversation_id / "store.db"
        if candidate.is_file():
            return candidate, ws.name
    return None


def human_label(folder_name: str) -> str:
    parts = folder_name.split("-")
    if len(parts) <= 1:
        return folder_name
    last = parts[-1]
    trimmed = parts[:-1] if len(last) in (8, 40) else parts
    return "-".join(trimmed)
def merge_targets_for_import(
    state_db: Path | None, sync_global: bool
) -> list[Path]:
    targets: list[Path] = []
    seen: set[str] = set()
    if state_db is not None and state_db.is_file():
        p = state_db.resolve()
        targets.append(p)
        seen.add(str(p))
    if sync_global:
        g = global_state_db_path()
        if g.is_file():
            gp = g.resolve()
            if str(gp) not in seen:
                targets.append(gp)
                seen.add(str(gp))
    if not targets:
        for c in list_state_db_candidates():
            cp = c.resolve()
            if str(cp) not in seen:
                targets.append(cp)
                seen.add(str(cp))
                break
    return targets

from cursor_chat_io_disk_kv import *

def read_composer_rows(db_path: Path) -> dict[str, Any]:
    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData')"
        )
        out: dict[str, Any] = {}
        for key, value in cur.fetchall():
            short = key.replace("composer.", "", 1)
            if isinstance(value, bytes):
                value = value.decode("utf-8", errors="replace")
            if isinstance(value, str):
                try:
                    out[short] = json.loads(value)
                except json.JSONDecodeError:
                    out[short] = value
            else:
                out[short] = value
        return out
    finally:
        conn.close()
def read_composer_header_entry(db_path: Path, conversation_id: str) -> dict[str, Any] | None:
    if not db_path.is_file():
        return None
    conn = sqlite3.connect(db_path)
    try:
        row = conn.execute(
            "SELECT value FROM ItemTable WHERE key='composer.composerHeaders'"
        ).fetchone()
    finally:
        conn.close()
    if not row or not row[0]:
        return None
    raw = item_table_value_as_text(row[0])
    if not raw:
        return None
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return None
    for c in data.get("allComposers") or []:
        if isinstance(c, dict) and c.get("composerId") == conversation_id:
            return c
    return None


def count_store_db_blobs(store_path: Path) -> int | None:
    if not store_path.is_file():
        return None
    conn = sqlite3.connect(f"file:{store_path.resolve()}?mode=ro", uri=True)
    try:
        tables = {
            r[0]
            for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
        }
        if "blobs" not in tables:
            return 0
        row = conn.execute("SELECT COUNT(*) FROM blobs").fetchone()
        return int(row[0]) if row else 0
    except sqlite3.Error:
        return None
    finally:
        conn.close()

def decode_store_db_index(store_bytes: bytes) -> dict[str, Any]:
    """Read meta key/value rows and blob count from store.db bytes (index only, no blob decode)."""
    out: dict[str, Any] = {"meta": {}, "blobCount": 0}
    if not store_bytes:
        return out

    try:
        with tempfile.NamedTemporaryFile(suffix=".db") as tmp:
            tmp.write(store_bytes)
            tmp.flush()
            conn = sqlite3.connect(f"file:{Path(tmp.name).resolve()}?mode=ro", uri=True)
            try:
                tables = {
                    r[0]
                    for r in conn.execute(
                        "SELECT name FROM sqlite_master WHERE type='table'"
                    ).fetchall()
                }
                if "meta" in tables:
                    meta_out: dict[str, Any] = {}
                    for key, value in conn.execute("SELECT key, value FROM meta"):
                        parsed: Any = value
                        if isinstance(value, str):
                            try:
                                parsed = json.loads(value)
                            except json.JSONDecodeError:
                                pass
                        meta_out[str(key)] = parsed
                    out["meta"] = meta_out
                if "blobs" in tables:
                    row = conn.execute("SELECT COUNT(*) FROM blobs").fetchone()
                    out["blobCount"] = int(row[0]) if row else 0
            finally:
                conn.close()
    except (sqlite3.Error, OSError):
        out["error"] = "unreadable"
    return out

@dataclass
class ConversationRef:
    conversation_id: str
    project_key: str | None
    has_transcript: bool
    has_store: bool
    store_workspace_key: str | None
    title_hint: str


def first_user_text(jsonl_path: Path) -> str:
    try:
        with jsonl_path.open("r", encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                obj = json.loads(line)
                if obj.get("role") != "user":
                    continue
                msg = obj.get("message") or {}
                content = msg.get("content")
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and block.get("type") == "text":
                            text = block.get("text", "")
                            if isinstance(text, str) and text.strip():
                                return text.strip()[:80]
                if isinstance(content, str) and content.strip():
                    return content.strip()[:80]
    except (OSError, json.JSONDecodeError):
        pass
    return ""


def discover_conversations() -> list[ConversationRef]:
    by_id: dict[str, ConversationRef] = {}
    proot = projects_root()
    if proot.is_dir():
        for proj in sorted(proot.iterdir()):
            if not proj.is_dir():
                continue
            at = proj / "agent-transcripts"
            if not at.is_dir():
                continue
            for conv in sorted(at.iterdir()):
                if not conv.is_dir():
                    continue
                cid = conv.name
                if not UUID_RE.match(cid):
                    continue
                jsonls = list(conv.glob("*.jsonl"))
                if not jsonls:
                    continue
                hint = first_user_text(jsonls[0]) or cid
                ref = by_id.get(cid)
                if ref is None:
                    by_id[cid] = ConversationRef(
                        conversation_id=cid,
                        project_key=proj.name,
                        has_transcript=True,
                        has_store=False,
                        store_workspace_key=None,
                        title_hint=hint,
                    )
                else:
                    ref.has_transcript = True
                    if ref.project_key is None:
                        ref.project_key = proj.name
    croot = chats_root()
    if croot.is_dir():
        for ws in sorted(croot.iterdir()):
            if not ws.is_dir():
                continue
            for conv in sorted(ws.iterdir()):
                if not conv.is_dir():
                    continue
                cid = conv.name
                if not (conv / "store.db").is_file():
                    continue
                ref = by_id.get(cid)
                if ref is None:
                    by_id[cid] = ConversationRef(
                        conversation_id=cid,
                        project_key=None,
                        has_transcript=False,
                        has_store=True,
                        store_workspace_key=ws.name,
                        title_hint=cid,
                    )
                else:
                    ref.has_store = True
                    ref.store_workspace_key = ws.name
    return sorted(by_id.values(), key=lambda r: r.conversation_id)

from cursor_chat_io_partial import *
from cursor_chat_io_verify import *
