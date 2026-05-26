"""Shared constants, workspace resolution, verification, discovery (cursor_chat_io split module)."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import re
import sqlite3
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

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


def cursor_config_root() -> Path:
    home = Path.home()
    system = platform.system()
    if system == "Darwin":
        return home / "Library" / "Application Support" / "Cursor" / "User"
    if system == "Windows":
        return Path(os.environ.get("APPDATA", home)) / "Cursor" / "User"
    return home / ".config" / "Cursor" / "User"


def projects_root() -> Path:
    return Path.home() / ".cursor" / "projects"


def chats_root() -> Path:
    return Path.home() / ".cursor" / "chats"


ACTIVATION_DIR = Path.home() / ".cursor" / "import-activation"
ACTIVATION_PENDING_PATH = ACTIVATION_DIR / "pending.json"
ACTIVATION_RESULT_PATH = ACTIVATION_DIR / "result.json"
COMPOSER_BRIDGE_SCRIPT = Path(__file__).resolve().parent / "cursor_composer_bridge.py"


@dataclass
class WorkspaceContext:
    workspace_storage_id: str
    folder_fs_path: str
    chats_workspace_key: str
    workspace_identifier: dict[str, Any]


@dataclass
class VerifyCheck:
    name: str
    status: str
    detail: str = ""

    def format_line(self) -> str:
        if self.detail:
            return f"[{self.status}] {self.name}: {self.detail}"
        return f"[{self.status}] {self.name}"

    def to_json(self) -> dict[str, str]:
        return {"check": self.name, "status": self.status, "detail": self.detail}


def md5_folder_key(folder_fs_path: str) -> str:
    return hashlib.md5(folder_fs_path.encode()).hexdigest()


def folder_path_from_workspace_uri(uri: str) -> str:
    if uri.startswith("file://"):
        from urllib.parse import unquote, urlparse

        parsed = urlparse(uri)
        return unquote(parsed.path)
    return uri


def resolve_workspace_context(
    state_db: Path | None = None, workspace_folder: str | None = None
) -> WorkspaceContext | None:
    folder_fs_path: str | None = None
    workspace_storage_id: str | None = None

    if workspace_folder:
        folder_fs_path = str(Path(workspace_folder).expanduser().resolve())

    if state_db is not None:
        parts = state_db.parts
        if "workspaceStorage" in parts:
            idx = parts.index("workspaceStorage")
            if idx + 1 < len(parts):
                workspace_storage_id = parts[idx + 1]
        if folder_fs_path is None and state_db.parent.name != "globalStorage":
            wj = state_db.parent / "workspace.json"
            if wj.is_file():
                try:
                    wdata = json.loads(wj.read_text(encoding="utf-8"))
                    folder = wdata.get("folder")
                    if isinstance(folder, str):
                        folder_fs_path = folder_path_from_workspace_uri(folder)
                except (OSError, json.JSONDecodeError):
                    pass

    if not folder_fs_path:
        return None

    folder_fs_path = str(Path(folder_fs_path).resolve())
    chats_key = md5_folder_key(folder_fs_path)

    if workspace_storage_id is None:
        ws_root = cursor_config_root() / "workspaceStorage"
        if ws_root.is_dir():
            for ent in ws_root.iterdir():
                wj = ent / "workspace.json"
                if not wj.is_file():
                    continue
                try:
                    wdata = json.loads(wj.read_text(encoding="utf-8"))
                    folder = wdata.get("folder")
                    if not isinstance(folder, str):
                        continue
                    if folder_path_from_workspace_uri(folder) == folder_fs_path:
                        workspace_storage_id = ent.name
                        break
                except (OSError, json.JSONDecodeError):
                    continue

    ws_id = workspace_storage_id or chats_key
    sep = 1 if platform.system() == "win32" else 47
    external = Path(folder_fs_path).as_uri()
    return WorkspaceContext(
        workspace_storage_id=ws_id,
        folder_fs_path=folder_fs_path,
        chats_workspace_key=chats_key,
        workspace_identifier={
            "id": ws_id,
            "uri": {
                "$mid": 1,
                "fsPath": folder_fs_path,
                "_sep": sep,
                "external": external,
                "path": folder_fs_path,
                "scheme": "file",
            },
        },
    )


def resolve_chats_workspace_key(
    target_workspace: str | None,
    state_db: Path | None,
    workspace_folder: str | None,
    bundle: dict[str, Any],
) -> tuple[str, list[str]]:
    warnings: list[str] = []
    ctx = resolve_workspace_context(state_db, workspace_folder)
    if ctx is not None:
        if target_workspace and target_workspace != ctx.chats_workspace_key:
            if target_workspace == ctx.workspace_storage_id:
                warnings.append(
                    f"--target-workspace {target_workspace} is workspaceStorage id; "
                    f"using chats key md5(folder)={ctx.chats_workspace_key} for store.db."
                )
            else:
                warnings.append(
                    f"--target-workspace {target_workspace} overrides resolved chats key "
                    f"{ctx.chats_workspace_key}."
                )
                return target_workspace, warnings
        return ctx.chats_workspace_key, warnings

    if target_workspace:
        return target_workspace, warnings
    snap = bundle.get("storeSnapshot") or {}
    swk = snap.get("sourceWorkspaceKey")
    if isinstance(swk, str) and swk:
        return swk, warnings
    return "imported", warnings


def stamp_workspace_identifier_on_headers(
    headers: dict[str, Any], conversation_id: str, workspace_identifier: dict[str, Any]
) -> dict[str, Any]:
    composers = headers.get("allComposers")
    if not isinstance(composers, list):
        return headers
    updated: list[Any] = []
    for entry in composers:
        if not isinstance(entry, dict):
            updated.append(entry)
            continue
        if entry.get("composerId") != conversation_id:
            updated.append(entry)
            continue
        row = dict(entry)
        row["workspaceIdentifier"] = workspace_identifier
        updated.append(row)
    return {**headers, "allComposers": updated}


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
    data = json.loads(row[0]) if isinstance(row[0], str) else row[0]
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

PARTIAL_STATE_STRIPPED = frozenset(
    {"capabilities", "conversationActionManager", "agentSessionId"}
)


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

    return partial

def sidebar_snapshot_has_composer_data(bundle: dict[str, Any], conversation_id: str) -> bool:
    snap = bundle.get("sidebarSnapshot")
    if not isinstance(snap, dict):
        return False
    cd = snap.get("composerData")
    if not isinstance(cd, dict):
        return False
    val = cd.get(conversation_id)
    return val is not None and val != {}

def composer_data_has_conversation_key(db_path: Path, conversation_id: str) -> bool | None:
    if not db_path.is_file():
        return None
    rows = read_composer_rows(db_path)
    data = rows.get("composerData")
    if not isinstance(data, dict):
        return False
    if conversation_id not in data:
        return False
    val = data[conversation_id]
    return val is not None and val != {}


def count_tool_bubbles_in_global_db(
    conversation_id: str,
    global_db: Path | None = None,
) -> int | None:
    db = global_db if global_db is not None else global_state_db_path()
    if not db.is_file():
        return None
    prefix = f"bubbleId:{conversation_id}:"
    conn = sqlite3.connect(db)
    try:
        try:
            cur = conn.execute(
                "SELECT value FROM cursorDiskKV WHERE key LIKE ?;",
                (prefix + "%",),
            )
        except sqlite3.OperationalError:
            return None
        count = 0
        for (value,) in cur.fetchall():
            if not isinstance(value, str):
                continue
            try:
                if json.loads(value).get("toolFormerData"):
                    count += 1
            except json.JSONDecodeError:
                pass
        return count
    finally:
        conn.close()


def expected_tool_bubble_count_from_bundle(bundle: dict[str, Any] | None) -> int | None:
    if bundle is None:
        return None
    disk_kv = bundle.get("diskKvSnapshot")
    if not isinstance(disk_kv, dict):
        return None
    tbc = disk_kv.get("toolBubbleCount")
    if isinstance(tbc, int) and tbc > 0:
        return tbc
    return None


def verify_import_visibility(
    conversation_id: str,
    workspace_ctx: WorkspaceContext | None,
    *,
    expect_rich_composer_data: bool = False,
    expect_store: bool = False,
    expected_tool_bubble_count: int | None = None,
    tool_bubble_global_db: Path | None = None,
) -> list[VerifyCheck]:
    checks: list[VerifyCheck] = []
    chats_key = workspace_ctx.chats_workspace_key if workspace_ctx else None
    store_path: Path | None = None
    if chats_key:
        store_path = chats_root() / chats_key / conversation_id / "store.db"
        if store_path.is_file():
            blob_n = count_store_db_blobs(store_path)
            if blob_n is None:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "WARN",
                        f"{store_path} exists but blob count unreadable",
                    )
                )
            elif blob_n > 0:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "OK",
                        f"{chats_key}/{conversation_id} ({blob_n} blobs)",
                    )
                )
            else:
                checks.append(
                    VerifyCheck(
                        "store.db",
                        "FAIL",
                        f"{store_path} has 0 blobs",
                    )
                )
        elif expect_store:
            checks.append(
                VerifyCheck(
                    "store.db",
                    "FAIL",
                    f"missing at ~/.cursor/chats/{chats_key}/{conversation_id}/",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    "store.db",
                    "SKIP",
                    f"no file at ~/.cursor/chats/{chats_key}/{conversation_id}/",
                )
            )
    elif expect_store:
        checks.append(VerifyCheck("store.db", "FAIL", "workspace context missing"))

    g = global_state_db_path()
    ent = read_composer_header_entry(g, conversation_id)
    if ent is None:
        checks.append(
            VerifyCheck(
                "global.composerHeaders",
                "FAIL",
                "sidebar row missing in globalStorage/state.vscdb",
            )
        )
    else:
        wi = (
            ent.get("workspaceIdentifier")
            if isinstance(ent.get("workspaceIdentifier"), dict)
            else {}
        )
        wi_id = wi.get("id")
        fp = (wi.get("uri") or {}).get("fsPath") if isinstance(wi.get("uri"), dict) else None
        expected = workspace_ctx.folder_fs_path if workspace_ctx else None
        expected_id = workspace_ctx.workspace_storage_id if workspace_ctx else None
        if not wi_id:
            checks.append(
                VerifyCheck("global.workspaceIdentifier", "FAIL", "id not stamped on header")
            )
        elif expected_id and wi_id != expected_id:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier",
                    "FAIL",
                    f"id={wi_id} expected workspaceStorage id {expected_id}",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier",
                    "OK",
                    f"id={wi_id}",
                )
            )
        if expected and fp != expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "FAIL",
                    f"uri.fsPath={fp!r} expected {expected!r}",
                )
            )
        elif expected and fp == expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "OK",
                    fp or "",
                )
            )
        elif expected:
            checks.append(
                VerifyCheck(
                    "global.workspaceIdentifier.fsPath",
                    "FAIL",
                    "uri.fsPath missing on header",
                )
            )
        checks.append(VerifyCheck("global.composerHeaders", "OK", conversation_id))

    if workspace_ctx:
        ws_db = (
            cursor_config_root()
            / "workspaceStorage"
            / workspace_ctx.workspace_storage_id
            / "state.vscdb"
        )
        ent_w = read_composer_header_entry(ws_db, conversation_id)
        if ent_w is None:
            checks.append(
                VerifyCheck(
                    f"workspace.composerHeaders({workspace_ctx.workspace_storage_id})",
                    "WARN",
                    "missing (global row may still be enough)",
                )
            )
        else:
            checks.append(
                VerifyCheck(
                    f"workspace.composerHeaders({workspace_ctx.workspace_storage_id})",
                    "OK",
                    conversation_id,
                )
            )

        for label, db in (("global", g), ("workspace", ws_db)):
            has_key = composer_data_has_conversation_key(db, conversation_id)
            if expect_rich_composer_data:
                if has_key:
                    checks.append(
                        VerifyCheck(
                            f"{label}.composerData[{conversation_id}]",
                            "OK",
                            "per-composer payload present",
                        )
                    )
                else:
                    checks.append(
                        VerifyCheck(
                            f"{label}.composerData[{conversation_id}]",
                            "FAIL",
                            "bundle sidebar had composerData but disk key missing",
                        )
                    )
            elif has_key:
                checks.append(
                    VerifyCheck(
                        f"{label}.composerData[{conversation_id}]",
                        "OK",
                        "per-composer payload present",
                    )
                )

    if expected_tool_bubble_count is not None and expected_tool_bubble_count > 0:
        db_for_tools = tool_bubble_global_db if tool_bubble_global_db is not None else g
        tool_count = count_tool_bubbles_in_global_db(conversation_id, db_for_tools)
        detail = (
            f"toolFormerData bubbles={tool_count} "
            f"expected>={expected_tool_bubble_count}"
        )
        if tool_count is None:
            checks.append(
                VerifyCheck(
                    "global.diskKv.toolBubbles",
                    "FAIL",
                    "global state DB unreadable or cursorDiskKV missing",
                )
            )
        elif tool_count >= expected_tool_bubble_count:
            checks.append(
                VerifyCheck("global.diskKv.toolBubbles", "OK", detail)
            )
        else:
            checks.append(
                VerifyCheck("global.diskKv.toolBubbles", "FAIL", detail)
            )

    return checks


def verify_checks_all_ok(checks: list[VerifyCheck]) -> bool:
    return all(c.status != "FAIL" for c in checks)
def print_verify_report(checks: list[VerifyCheck], *, json_lines: bool = False) -> None:
    for c in checks:
        if json_lines:
            print(json.dumps(c.to_json(), separators=(",", ":")))
        else:
            print(c.format_line())
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
