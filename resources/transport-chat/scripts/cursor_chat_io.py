#!/usr/bin/env python3
"""
Cursor chat import/export (offline, no Cursor UI required).

Mirrors cursor-sync's ChatBundle (src/chat-persistence.ts) and restore paths used by
transcript import (src/transcripts.ts). Use this to explore on-disk layout before
implementing the same flow in the extension.

Data model (three layers)
-------------------------
1. Transcripts (human-readable log)
   ~/.cursor/projects/<project-key>/agent-transcripts/<conversation-id>/*.jsonl
   JSONL lines: role + message content (export preserves exact UTF-8 bytes).

2. Conversation store (Cursor runtime state per chat)
   ~/.cursor/chats/<workspace-key>/<conversation-id>/store.db
   SQLite with blobs/meta tables. workspace-key is md5(absolute workspace folder path), NOT
   workspaceStorage/<id> (that id is only for state.vscdb + workspaceIdentifier.id).

3. Sidebar / composer list (what Cursor shows in the chat history UI)
   state.vscdb ItemTable keys:
     - composer.composerHeaders  (list entries: composerId, name, type:"head", timestamps as ms)
     - composer.composerData     (optional richer payload)
   Paths (Linux): ~/.config/Cursor/User/globalStorage/state.vscdb
                 ~/.config/Cursor/User/workspaceStorage/<id>/state.vscdb

Import merges headers/data additively (by composerId), same as composer-merge.ts.
By default import sets lastUpdatedAt/lastOpenedAt above all other chats (most recent).
Reload Cursor after import if sidebar does not update (SQLite is not hot-reloaded).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import platform
import re
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
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


def verify_import_visibility(
    conversation_id: str,
    workspace_ctx: WorkspaceContext | None,
    *,
    expect_rich_composer_data: bool = False,
    expect_store: bool = False,
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

    return checks


def verify_checks_all_ok(checks: list[VerifyCheck]) -> bool:
    return all(c.status != "FAIL" for c in checks)


def build_activation_manifest(
    bundle: dict[str, Any],
    conversation_id: str,
    workspace_ctx: WorkspaceContext,
    *,
    open_in_new_tab: bool = True,
) -> dict[str, Any]:
    partial = bundle_to_partial_state(
        bundle,
        conversation_id,
        workspace_identifier=workspace_ctx.workspace_identifier,
    )
    return {
        "partialState": partial,
        "workspaceFolder": workspace_ctx.folder_fs_path,
        "openInNewTab": open_in_new_tab,
    }


def _parse_bridge_stdout(stdout: str) -> str | None:
    text = (stdout or "").strip()
    if not text:
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    if not isinstance(data, dict):
        return None
    cid = data.get("composerId")
    if isinstance(cid, str) and cid.strip():
        return cid.strip()
    return None


def invoke_composer_bridge(
    manifest: dict[str, Any],
    *,
    wait_result_s: float = 0.0,
    dry_run: bool = False,
) -> tuple[int, str | None]:
    if dry_run:
        print(
            f"[dry-run] would run bridge: {COMPOSER_BRIDGE_SCRIPT} --manifest <tmp>",
            file=sys.stderr,
        )
        return 0, manifest.get("partialState", {}).get("composerId")

    if not COMPOSER_BRIDGE_SCRIPT.is_file():
        print(f"error: bridge script missing: {COMPOSER_BRIDGE_SCRIPT}", file=sys.stderr)
        return 1, None

    tmp_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".json", delete=False, encoding="utf-8"
        ) as tf:
            json.dump(manifest, tf, indent=2, ensure_ascii=False)
            tf.write("\n")
            tmp_path = Path(tf.name)

        cmd = [
            sys.executable,
            str(COMPOSER_BRIDGE_SCRIPT),
            "--manifest",
            str(tmp_path),
        ]
        if wait_result_s > 0:
            cmd.extend(["--wait-result", str(wait_result_s)])

        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.stderr:
            for line in proc.stderr.strip().splitlines():
                print(f"  bridge: {line}", file=sys.stderr)
        composer_id = _parse_bridge_stdout(proc.stdout or "")
        if composer_id is None and proc.returncode == 0:
            partial = manifest.get("partialState")
            if isinstance(partial, dict):
                raw = partial.get("composerId")
                if isinstance(raw, str) and raw.strip():
                    composer_id = raw.strip()
        return proc.returncode, composer_id
    finally:
        if tmp_path is not None:
            try:
                tmp_path.unlink()
            except OSError:
                pass


def ping_server_probe(*, conversation_id: str) -> None:
    print(
        f"note: --ping-server probe not implemented for {conversation_id} "
        "(no agentClient HTTP contract in v1; see activation-architecture.md)",
        file=sys.stderr,
    )


def verify_activation_checks(conversation_id: str) -> list[VerifyCheck]:
    checks: list[VerifyCheck] = []

    pending_cid: str | None = None
    if ACTIVATION_PENDING_PATH.is_file():
        try:
            pending = json.loads(ACTIVATION_PENDING_PATH.read_text(encoding="utf-8"))
            if isinstance(pending, dict):
                raw = pending.get("composerId")
                if isinstance(raw, str):
                    pending_cid = raw.strip()
                if not pending_cid:
                    partial = pending.get("partialState")
                    if isinstance(partial, dict):
                        pc = partial.get("composerId")
                        if isinstance(pc, str):
                            pending_cid = pc.strip()
        except (OSError, json.JSONDecodeError):
            checks.append(
                VerifyCheck("activation.pending", "WARN", "pending.json unreadable")
            )
        else:
            if pending_cid == conversation_id:
                checks.append(
                    VerifyCheck(
                        "activation.pending",
                        "OK",
                        f"staged for {conversation_id}",
                    )
                )
            elif pending_cid:
                checks.append(
                    VerifyCheck(
                        "activation.pending",
                        "WARN",
                        f"pending composerId={pending_cid!r} (expected {conversation_id})",
                    )
                )
            else:
                checks.append(
                    VerifyCheck("activation.pending", "WARN", "pending.json has no composerId")
                )
    else:
        checks.append(VerifyCheck("activation.pending", "SKIP", "no pending.json"))

    result_cid: str | None = None
    result_ok = False
    if ACTIVATION_RESULT_PATH.is_file():
        try:
            result = json.loads(ACTIVATION_RESULT_PATH.read_text(encoding="utf-8"))
            if isinstance(result, dict) and result.get("ok") is not False:
                raw = result.get("composerId")
                if isinstance(raw, str) and raw.strip():
                    result_cid = raw.strip()
                    result_ok = True
        except (OSError, json.JSONDecodeError):
            checks.append(
                VerifyCheck("activation.result", "WARN", "result.json unreadable")
            )
        else:
            if result_ok and result_cid == conversation_id:
                checks.append(
                    VerifyCheck(
                        "activation.result",
                        "OK",
                        f"composerId={result_cid}",
                    )
                )
            elif result_cid:
                checks.append(
                    VerifyCheck(
                        "activation.result",
                        "WARN",
                        f"composerId={result_cid!r} (expected {conversation_id})",
                    )
                )
            else:
                checks.append(
                    VerifyCheck("activation.result", "WARN", "result.json missing composerId")
                )
    else:
        checks.append(
            VerifyCheck(
                "activation.result",
                "PENDING",
                "awaiting IDE hook, CURSOR_COMPOSER_BRIDGE_COMMAND, or --bridge-wait-result",
            )
        )

    if result_ok and result_cid == conversation_id:
        checks.append(VerifyCheck("activation.status", "OK", "completed"))
    elif pending_cid == conversation_id:
        checks.append(
            VerifyCheck(
                "activation.status",
                "PENDING",
                "manifest staged; IDE activation not confirmed",
            )
        )
    else:
        checks.append(
            VerifyCheck(
                "activation.status",
                "SKIP",
                "no matching activation artifacts for this conversation",
            )
        )

    return checks


def run_post_import_activation(
    bundle: dict[str, Any],
    conversation_id: str,
    workspace_ctx: WorkspaceContext,
    *,
    activate_strict: bool = False,
    bridge_wait_result: float = 0.0,
    dry_run: bool = False,
) -> None:
    manifest = build_activation_manifest(bundle, conversation_id, workspace_ctx)
    print(f"Activating composer {conversation_id} via bridge ...", file=sys.stderr)
    code, composer_id = invoke_composer_bridge(
        manifest,
        wait_result_s=bridge_wait_result,
        dry_run=dry_run,
    )
    if code == 0:
        cid = composer_id or conversation_id
        print(f"Activation OK: composerId={cid}", file=sys.stderr)
        return
    if code == 1:
        print("error: bridge failed (invalid manifest or missing script)", file=sys.stderr)
        raise SystemExit(1)
    if code == 2:
        msg = (
            "Activation staged only (exit 2): manifest at "
            f"{ACTIVATION_PENDING_PATH}; Cursor must be open on the workspace. "
            "Set CURSOR_COMPOSER_BRIDGE_COMMAND or write result.json."
        )
        print(f"  warning: {msg}", file=sys.stderr)
        if activate_strict:
            print("error: --activate-strict requires bridge exit 0", file=sys.stderr)
            raise SystemExit(1)
        return
    print(f"error: bridge exited {code}", file=sys.stderr)
    raise SystemExit(1)


def print_verify_report(checks: list[VerifyCheck], *, json_lines: bool = False) -> None:
    for c in checks:
        if json_lines:
            print(json.dumps(c.to_json(), separators=(",", ":")))
        else:
            print(c.format_line())


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
            updated.append(row)
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


def build_bundle(conversation_id: str, state_db: Path | None) -> tuple[dict[str, Any], list[str]]:
    warnings: list[str] = []
    store_snapshot = None
    store_info = find_store_db(conversation_id)
    if store_info:
        store_path, ws_key = store_info
        raw = store_path.read_bytes()
        store_snapshot = {
            "content": base64.b64encode(raw).decode("ascii"),
            "encoding": "base64",
            "checksum": sha256_hex(raw),
            "sizeBytes": len(raw),
            "sourceWorkspaceKey": ws_key,
        }
    else:
        warnings.append(
            f"store.db not found for {conversation_id}; only transcripts will be exported."
        )

    sidebar_snapshot = None
    db_candidates = [state_db] if state_db else list_state_db_candidates()
    for db in db_candidates:
        if db is None or not db.is_file():
            continue
        try:
            rows = read_composer_rows(db)
            if rows:
                sidebar_snapshot = {"conversationId": conversation_id, "stateDbPath": str(db)}
                if isinstance(rows.get("composerHeaders"), dict):
                    sidebar_snapshot["composerHeaders"] = filter_composer_headers_for_conversation(
                        rows["composerHeaders"], conversation_id
                    )
                if isinstance(rows.get("composerData"), dict):
                    sidebar_snapshot["composerData"] = filter_composer_data_for_conversation(
                        rows["composerData"], conversation_id
                    )
                if not (sidebar_snapshot.get("composerHeaders") or {}).get("allComposers"):
                    warnings.append(
                        f"{conversation_id} not in composer.composerHeaders at {db}; "
                        "import will synthesize a sidebar row from the bundle title."
                    )
                break
        except sqlite3.Error as e:
            warnings.append(f"state read failed ({db}): {e}")
    if sidebar_snapshot is None and db_candidates:
        warnings.append("composer.* not found in state.vscdb; sidebar metadata skipped.")

    transcript_files: list[dict[str, Any]] = []
    proot = projects_root()
    if proot.is_dir():
        for proj in sorted(proot.iterdir()):
            if not proj.is_dir():
                continue
            tdir = proj / "agent-transcripts" / conversation_id
            if not tdir.is_dir():
                continue
            for jf in sorted(tdir.glob("*.jsonl")):
                raw = jf.read_bytes()
                transcript_files.append(
                    {
                        "relativePath": f"{proj.name}/agent-transcripts/{conversation_id}/{jf.name}",
                        "content": base64.b64encode(raw).decode("ascii"),
                        "encoding": "base64",
                        "checksum": sha256_hex(raw),
                        "sizeBytes": len(raw),
                    }
                )

    if not transcript_files and not store_snapshot:
        raise SystemExit(
            f"No data for conversation {conversation_id}. Check ID under agent-transcripts or chats."
        )

    title = conversation_id
    if transcript_files:
        first = base64.b64decode(transcript_files[0]["content"])
        hint = first_user_text_from_bytes(first)
        if hint:
            title = hint[:120]

    bundle = {
        "schemaVersion": SCHEMA_VERSION,
        "type": BUNDLE_TYPE,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "conversationId": conversation_id,
        "title": title,
        "subtitle": f"{len(transcript_files)} file(s)",
        "previewText": title,
        "sidebarSnapshot": sidebar_snapshot,
        "storeSnapshot": store_snapshot,
        "transcriptFiles": transcript_files,
    }
    return bundle, warnings


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


def hydrate_golden_store_template(
    template_path: Path,
    output_path: Path,
    chat: dict[str, Any],
) -> list[str]:
    warnings: list[str] = []
    assert_golden_template_layout(template_path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_bytes(template_path.read_bytes())

    message_blobs = build_cursor_message_blob_bytes(chat)
    if not message_blobs:
        fallback = json.dumps(
            {"role": "user", "content": [{"type": "text", "text": chat.get("title", "")}]},
            separators=(",", ":"),
            ensure_ascii=False,
        ).encode("utf-8")
        message_blobs = [fallback]
    message_hashes = [hashlib.sha256(b).hexdigest() for b in message_blobs]
    tree_blob = build_cursor_tree_blob(message_hashes)
    tree_hash = hashlib.sha256(tree_blob).hexdigest()

    meta_obj = {
        "agentId": chat["chat_id"],
        "latestRootBlobId": tree_hash,
        "name": chat["title"],
        "mode": "default",
        "isRunEverything": True,
        "createdAt": chat_timestamp_ms(chat),
    }
    meta_json = json.dumps(meta_obj, separators=(",", ":"), ensure_ascii=False)

    conn = sqlite3.connect(output_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        conn.execute("INSERT INTO meta(key, value) VALUES (?, ?);", ("0", meta_json))
        seen: set[str] = set()
        for hex_id, blob_bytes in zip(message_hashes, message_blobs):
            if hex_id in seen:
                continue
            seen.add(hex_id)
            conn.execute(
                "INSERT INTO blobs(id, data) VALUES (?, ?);",
                (hex_id, sqlite3.Binary(blob_bytes)),
            )
        if tree_hash not in seen:
            conn.execute(
                "INSERT INTO blobs(id, data) VALUES (?, ?);",
                (tree_hash, sqlite3.Binary(tree_blob)),
            )
        conn.commit()
    finally:
        conn.close()
    warnings.append(
        "Synthesized store.db from golden template (bundle had no store.db snapshot)."
    )
    warnings.append(
        "Golden template hydration is best-effort; Cursor upgrades may change store.db layout."
    )
    return warnings


def _uuid4_hex() -> str:
    return str(uuid.uuid4())


def _random_b64_key(num_bytes: int = 32) -> str:
    return base64.b64encode(os.urandom(num_bytes)).decode("ascii")


def _iso_from_ms(ms: int) -> str:
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).isoformat().replace("+00:00", "Z")


def _bubble_type_for_role(role: str) -> int:
    return 2 if role in ("assistant", "tool") else 1


def build_bubble_row(
    bubble_id: str,
    role: str,
    text: str,
    created_at_ms: int,
) -> dict[str, Any]:
    return {
        "_v": 3,
        "bubbleId": bubble_id,
        "type": _bubble_type_for_role(role),
        "unifiedMode": 2,
        "createdAt": _iso_from_ms(created_at_ms),
        "text": text,
        "richText": "",
        "requestId": "",
        "conversationState": "~",
        "isAgentic": False,
        "isRefunded": False,
        "existedPreviousTerminalCommand": False,
        "existedSubsequentTerminalCommand": False,
        "attachedHumanChanges": False,
        "cursorCommandsExplicitlySet": False,
        "pastChatsExplicitlySet": False,
        "tokenCount": {"inputTokens": 0, "outputTokens": 0},
        "codeBlocks": [],
        "approximateLintErrors": [],
        "lints": [],
        "codebaseContextChunks": [],
        "commits": [],
        "pullRequests": [],
        "attachedCodeChunks": [],
        "assistantSuggestedDiffs": [],
        "gitDiffs": [],
        "interpreterResults": [],
        "images": [],
        "attachedFolders": [],
        "attachedFoldersNew": [],
        "attachedFoldersListDirResults": [],
        "attachedFileCodeChunksMetadataOnly": [],
        "userResponsesToSuggestedCodeBlocks": [],
        "suggestedCodeBlocks": [],
        "diffsForCompressingFiles": [],
        "relevantFiles": [],
        "toolResults": [],
        "notepads": [],
        "capabilities": [],
        "multiFileLinterErrors": [],
        "diffHistories": [],
        "recentLocationsHistory": [],
        "recentlyViewedFiles": [],
        "fileDiffTrajectories": [],
        "docsReferences": [],
        "webReferences": [],
        "aiWebSearchResults": [],
        "humanChanges": [],
        "summarizedComposers": [],
        "cursorRules": [],
        "cursorCommands": [],
        "pastChats": [],
        "contextPieces": [],
        "editTrailContexts": [],
        "allThinkingBlocks": [],
        "diffsSinceLastApply": [],
        "deletedFiles": [],
        "supportedTools": [],
        "consoleLogs": [],
        "uiElementPicked": [],
        "knowledgeItems": [],
        "documentationSelections": [],
        "externalLinks": [],
        "projectLayouts": [],
        "capabilityContexts": [],
        "todos": [],
        "mcpDescriptors": [],
        "workspaceUris": [],
    }


def build_composer_data_row(
    cid: str,
    title: str,
    created_at_ms: int,
    headers: list[dict[str, Any]],
    workspace_identifier: dict[str, Any] | None,
) -> dict[str, Any]:
    return {
        "_v": 16,
        "composerId": cid,
        "name": title,
        "richText": "",
        "text": "",
        "hasLoaded": True,
        "fullConversationHeadersOnly": headers,
        "conversationMap": {},
        "status": "completed",
        "context": {
            "composers": [],
            "selectedCommits": [],
            "selectedPullRequests": [],
            "selectedImages": [],
            "folderSelections": [],
            "fileSelections": [],
            "selections": [],
            "terminalSelections": [],
            "selectedDocs": [],
            "externalLinks": [],
            "cursorRules": [],
            "cursorCommands": [],
            "gitPRDiffSelections": [],
            "subagentSelections": [],
            "browserSelections": [],
            "mentions": {
                "composers": {},
                "selectedCommits": {},
                "selectedPullRequests": {},
                "gitDiff": [],
                "gitDiffFromBranchToMain": [],
                "selectedImages": {},
                "folderSelections": {},
                "fileSelections": {},
                "terminalFiles": {},
                "selections": {},
                "terminalSelections": {},
                "selectedDocs": {},
                "externalLinks": {},
                "diffHistory": [],
                "cursorRules": {},
                "cursorCommands": {},
                "uiElementSelections": [],
                "consoleLogs": [],
                "ideEditorsState": [],
                "gitPRDiffSelections": {},
                "subagentSelections": {},
                "browserSelections": {},
            },
        },
        "generatingBubbleIds": [],
        "isReadingLongFile": False,
        "codeBlockData": {},
        "originalFileStates": {},
        "newlyCreatedFiles": [],
        "newlyCreatedFolders": [],
        "createdAt": created_at_ms,
        "hasChangedContext": False,
        "activeTabsShouldBeReactive": True,
        "capabilities": [],
        "isFileListExpanded": False,
        "browserChipManuallyDisabled": False,
        "browserChipManuallyEnabled": False,
        "unifiedMode": "agent",
        "forceMode": "agent",
        "usageData": {},
        "allAttachedFileCodeChunksUris": [],
        "modelConfig": {"modelName": "default", "maxMode": False},
        "subComposerIds": [],
        "subagentComposerIds": [],
        "capabilityContexts": [],
        "todos": [],
        "isQueueExpanded": True,
        "hasUnreadMessages": False,
        "gitHubPromptDismissed": False,
        "totalLinesAdded": 0,
        "totalLinesRemoved": 0,
        "addedFiles": 0,
        "removedFiles": 0,
        "isDraft": False,
        "isCreatingWorktree": False,
        "isApplyingWorktree": False,
        "isUndoingWorktree": False,
        "applied": False,
        "pendingCreateWorktree": False,
        "worktreeStartedReadOnly": False,
        "isBestOfNSubcomposer": False,
        "isBestOfNParent": False,
        "bestOfNJudgeWinner": False,
        "isSpec": False,
        "isProject": False,
        "isSpecSubagentDone": False,
        "isContinuationInProgress": False,
        "stopHookLoopCount": 0,
        "speculativeSummarizationEncryptionKey": _random_b64_key(),
        "blobEncryptionKey": _random_b64_key(),
        "isNAL": True,
        "planModeSuggestionUsed": False,
        "debugModeSuggestionUsed": False,
        "conversationState": "~",
        "queueItems": [],
        "isAgentic": True,
        "workspaceIdentifier": workspace_identifier,
    }


def build_cursor_disk_kv_rows_from_bundle(
    bundle: dict[str, Any],
    cid: str,
    workspace_identifier: dict[str, Any] | None,
) -> dict[str, str]:
    chat = chat_manifest_from_bundle(bundle)
    base_ms = chat_timestamp_ms(chat)
    headers: list[dict[str, Any]] = []
    rows: dict[str, str] = {}
    for i, m in enumerate(chat.get("content") or []):
        if not isinstance(m, dict):
            continue
        bid = _uuid4_hex()
        role = m.get("role") or "user"
        text = str(m.get("content", ""))
        msg_ms = base_ms + i
        bubble = build_bubble_row(bid, role, text, msg_ms)
        rows[f"bubbleId:{cid}:{bid}"] = json.dumps(bubble, separators=(",", ":"), ensure_ascii=False)
        headers.append(
            {
                "bubbleId": bid,
                "type": _bubble_type_for_role(role),
                "grouping": {"isRenderable": True, "hasText": bool(text)},
            }
        )
    composer_data = build_composer_data_row(
        cid=cid,
        title=chat["title"],
        created_at_ms=base_ms,
        headers=headers,
        workspace_identifier=workspace_identifier,
    )
    rows[f"composerData:{cid}"] = json.dumps(composer_data, separators=(",", ":"), ensure_ascii=False)
    return rows


def merge_cursor_disk_kv(
    db_path: Path,
    rows: dict[str, str],
    dry_run: bool,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    if not rows:
        warnings.append("No cursorDiskKV rows to write.")
        return False, warnings
    if dry_run:
        return True, warnings
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("BEGIN IMMEDIATE;")
        for key, value in rows.items():
            conn.execute(
                "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?);",
                (key, value),
            )
        conn.commit()
    finally:
        conn.close()
    return True, warnings


def synthesize_store_db_from_bundle(
    bundle: dict[str, Any],
    chats_workspace_key: str,
    conversation_id: str,
    *,
    dry_run: bool,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    template = resolve_golden_store_template_path()
    if template is None:
        warnings.append(
            "Golden store template missing; cannot synthesize store.db "
            f"(expected {skill_resources_dir() / 'golden-chat-store.template.db'})."
        )
        return False, warnings
    target = chats_root() / chats_workspace_key / conversation_id / "store.db"
    if dry_run:
        print(
            f"[dry-run] would synthesize store {target} from golden template ({template})",
            file=sys.stderr,
        )
        return True, warnings
    try:
        chat = chat_manifest_from_bundle(bundle)
        warnings.extend(hydrate_golden_store_template(template, target, chat))
        print(f"Wrote synthesized store {target} ({target.stat().st_size} bytes)")
        return True, warnings
    except (RuntimeError, sqlite3.Error, OSError) as e:
        warnings.append(f"Golden store synthesis failed: {e}")
        return False, warnings


def merge_state_db(
    db_path: Path,
    bundle: dict[str, Any],
    dry_run: bool,
    pin_recent: bool = True,
    workspace_ctx: WorkspaceContext | None = None,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    snap = bundle.get("sidebarSnapshot")
    if not isinstance(snap, dict):
        warnings.append("No sidebarSnapshot in bundle; state merge skipped.")
        return False, warnings

    conn = sqlite3.connect(db_path)
    try:
        cur = conn.cursor()
        cur.execute(
            "SELECT key, value FROM ItemTable WHERE key IN ('composer.composerHeaders', 'composer.composerData')"
        )
        existing_headers: str | None = None
        existing_data: str | None = None
        for key, value in cur.fetchall():
            if key == "composer.composerHeaders":
                existing_headers = value if isinstance(value, str) else json.dumps(value)
            if key == "composer.composerData":
                existing_data = value if isinstance(value, str) else json.dumps(value)

        headers_payload = headers_payload_for_import(bundle)
        cid = bundle.get("conversationId")
        if not isinstance(cid, str) or not cid.strip():
            warnings.append("Bundle missing conversationId; state merge skipped.")
            return False, warnings
        cid = cid.strip()

        scripts: list[str] = ["BEGIN IMMEDIATE;"]
        if headers_payload:
            merged = merge_headers_chain(existing_headers, [headers_payload])
            if pin_recent:
                merged = pin_composer_as_most_recent(merged, cid)
            if workspace_ctx is not None:
                merged = stamp_workspace_identifier_on_headers(
                    merged, cid, workspace_ctx.workspace_identifier
                )
            escaped = escape_sql_literal(json.dumps(merged, separators=(",", ":")))
            scripts.append(
                f"UPDATE ItemTable SET value = '{escaped}' WHERE key = 'composer.composerHeaders';"
            )
            scripts.append(
                f"INSERT INTO ItemTable (key, value) SELECT 'composer.composerHeaders', '{escaped}' "
                "WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerHeaders');"
            )

        merged_data = composer_data_for_focus(cid, existing_data)
        if isinstance(snap, dict) and isinstance(snap.get("composerData"), dict):
            extra = filter_composer_data_for_conversation(snap["composerData"], cid)
            if extra:
                merged_data = merge_data_additive(
                    json.dumps(merged_data, separators=(",", ":")), [extra]
                )
        escaped_d = escape_sql_literal(json.dumps(merged_data, separators=(",", ":")))
        scripts.append(
            f"UPDATE ItemTable SET value = '{escaped_d}' WHERE key = 'composer.composerData';"
        )
        scripts.append(
            f"INSERT INTO ItemTable (key, value) SELECT 'composer.composerData', '{escaped_d}' "
            "WHERE NOT EXISTS (SELECT 1 FROM ItemTable WHERE key = 'composer.composerData');"
        )
        scripts.append("COMMIT;")
        if len(scripts) <= 2:
            warnings.append("Nothing to merge into state.vscdb.")
            return False, warnings
        if dry_run:
            return True, warnings
        cur.executescript("\n".join(scripts))
        conn.commit()
        return True, warnings
    finally:
        conn.close()


def import_bundle(
    bundle_path: Path,
    target_project: str | None,
    target_workspace: str | None,
    state_db: Path | None,
    dry_run: bool,
    pin_recent: bool = True,
    workspace_folder: str | None = None,
    sync_global: bool = True,
    *,
    activate: bool = False,
    activate_strict: bool = False,
    ping_server: bool = False,
    bridge_wait_result: float = 0.0,
) -> None:
    if not workspace_folder or not str(workspace_folder).strip():
        print(
            "error: --workspace-folder is required for import\n"
            "  Sets ~/.cursor/chats/<md5(folder)> store.db path and stamps "
            "workspaceIdentifier on composer headers (global + workspace state).",
            file=sys.stderr,
        )
        raise SystemExit(1)

    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    if bundle.get("type") != BUNDLE_TYPE or bundle.get("schemaVersion") != SCHEMA_VERSION:
        raise SystemExit("Unsupported bundle: expected schemaVersion=1 type=chat-persistence")

    cid = bundle["conversationId"]
    warnings: list[str] = []
    transcripts_written = 0
    store_written = False
    sidebar_merged = False

    project_map: dict[str, str] = {}
    for tf in bundle.get("transcriptFiles") or []:
        rel = tf.get("relativePath", "")
        seg = rel.split("/")
        if seg:
            src = seg[0]
            project_map[src] = target_project or src

    if (bundle.get("transcriptFiles") or []) and not target_project:
        keys = sorted(project_map.keys())
        print(
            "Note: pass --target-project <folder-under-~/.cursor/projects> to remap transcripts.",
            file=sys.stderr,
        )
        print(f"  Source project key(s) in bundle: {', '.join(keys)}", file=sys.stderr)

    proot = projects_root()
    for tf in bundle.get("transcriptFiles") or []:
        rel = tf["relativePath"]
        seg = rel.split("/")
        mapped = "/".join([project_map.get(seg[0], seg[0]), *seg[1:]]) if seg else rel
        target = proot / mapped
        raw = decode_artifact(tf["content"], tf.get("encoding"))
        if sha256_hex(raw) != tf.get("checksum"):
            warnings.append(f"Checksum mismatch: {rel} (skipped)")
            continue
        if dry_run:
            print(f"[dry-run] would write transcript {target} ({len(raw)} bytes)")
            transcripts_written += 1
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(raw)
        print(f"Wrote transcript {target}")
        transcripts_written += 1

    ws_ctx = resolve_workspace_context(state_db, workspace_folder)
    if ws_ctx is None:
        print(
            f"error: could not resolve workspace for --workspace-folder {workspace_folder!r}\n"
            "  Open this folder in Cursor once, or pass --state-db for its workspaceStorage entry.",
            file=sys.stderr,
        )
        raise SystemExit(1)
    print(
        f"Workspace folder: {ws_ctx.folder_fs_path}\n"
        f"  store.db -> ~/.cursor/chats/{ws_ctx.chats_workspace_key}/\n"
        f"  workspaceIdentifier.id -> {ws_ctx.workspace_storage_id}",
        file=sys.stderr,
    )

    snap = bundle.get("storeSnapshot")
    bundle_had_store = bool(snap and snap.get("content"))
    store_synthesized = False
    if snap:
        dest_ws, ws_warnings = resolve_chats_workspace_key(
            target_workspace, state_db, workspace_folder, bundle
        )
        warnings.extend(ws_warnings)
        raw = decode_artifact(snap["content"], snap.get("encoding"))
        if sha256_hex(raw) != snap.get("checksum"):
            warnings.append("store.db checksum mismatch (skipped)")
        else:
            target = chats_root() / dest_ws / cid / "store.db"
            if dry_run:
                print(f"[dry-run] would write store {target} ({len(raw)} bytes)")
                store_written = True
            else:
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(raw)
                print(f"Wrote store {target}")
                store_written = True
    elif not store_written:
        written, synth_warnings = synthesize_store_db_from_bundle(
            bundle,
            ws_ctx.chats_workspace_key,
            cid,
            dry_run=dry_run,
        )
        warnings.extend(synth_warnings)
        if written:
            store_written = True
            store_synthesized = True

    do_sync_global = sync_global
    merge_targets = merge_targets_for_import(state_db, sync_global=do_sync_global)

    if bundle.get("sidebarSnapshot"):
        if dry_run:
            for db in merge_targets:
                print(f"[dry-run] would merge sidebar into {db}")
            sidebar_merged = True
        else:
            for db in merge_targets:
                ok, w = merge_state_db(
                    db, bundle, dry_run=False, pin_recent=pin_recent, workspace_ctx=ws_ctx
                )
                warnings.extend(w)
                if ok:
                    sidebar_merged = True
                    pin_note = " (pinned as most recent)" if pin_recent else ""
                    label = "global" if "globalStorage" in str(db) else "workspace"
                    print(f"Merged composer state into {db} [{label}]{pin_note}")
            if global_state_db_path() not in merge_targets:
                warnings.append(
                    "Global state.vscdb was not updated (--no-global-state); "
                    "sidebar may not show this chat for this workspace."
                )
    else:
        warnings.append("No sidebarSnapshot in bundle; sidebar merge skipped.")

    global_db = global_state_db_path()
    if global_db in merge_targets:
        ws_identifier = ws_ctx.workspace_identifier if ws_ctx is not None else None
        disk_kv_rows = build_cursor_disk_kv_rows_from_bundle(bundle, cid, ws_identifier)
        ok_kv, kv_warnings = merge_cursor_disk_kv(global_db, disk_kv_rows, dry_run=dry_run)
        warnings.extend(kv_warnings)
        if ok_kv and not dry_run:
            print(
                f"Wrote {len(disk_kv_rows)} cursorDiskKV rows into {global_db} "
                f"(composerData + {len(disk_kv_rows) - 1} bubbles)"
            )

    if bundle_had_store and not store_written:
        print(
            "error: bundle includes storeSnapshot but store.db was not written "
            "(checksum mismatch or skipped write)",
            file=sys.stderr,
        )
        raise SystemExit(1)

    print(
        f"Done: conversation={cid} transcripts={transcripts_written} "
        f"store={store_written} sidebar_merged={sidebar_merged}"
    )
    for w in warnings:
        print(f"  warning: {w}", file=sys.stderr)
    expect_rich = sidebar_snapshot_has_composer_data(bundle, cid)
    expect_store = bundle_had_store or store_written or store_synthesized
    verify_checks = verify_import_visibility(
        cid,
        ws_ctx,
        expect_rich_composer_data=expect_rich,
        expect_store=expect_store,
    )
    for c in verify_checks:
        print(f"  verify: {c.format_line()}", file=sys.stderr)
    if not dry_run and not verify_checks_all_ok(verify_checks):
        print("error: import verify failed (see verify lines above)", file=sys.stderr)
        raise SystemExit(1)

    if activate:
        run_post_import_activation(
            bundle,
            cid,
            ws_ctx,
            activate_strict=activate_strict,
            bridge_wait_result=bridge_wait_result,
            dry_run=dry_run,
        )

    if ping_server:
        if dry_run:
            print(
                f"[dry-run] would run --ping-server probe for {cid}",
                file=sys.stderr,
            )
        else:
            ping_server_probe(conversation_id=cid)

    if activate:
        activation_checks = verify_activation_checks(cid)
        for c in activation_checks:
            print(f"  verify: {c.format_line()}", file=sys.stderr)
        verify_checks.extend(activation_checks)

    if not dry_run:
        if not verify_checks_all_ok(verify_checks):
            print("error: import verify failed (see verify lines above)", file=sys.stderr)
            raise SystemExit(1)
        if sidebar_merged:
            print("Reload Cursor to refresh the chat sidebar.", file=sys.stderr)


def cmd_list(_: argparse.Namespace) -> None:
    refs = discover_conversations()
    if not refs:
        print("No conversations found.")
        return
    print(f"{'ID':<38} {'transcript':<10} {'store':<6} {'project / workspace'}")
    for r in refs:
        proj = r.project_key or "-"
        ws = r.store_workspace_key or "-"
        extra = proj if r.has_transcript else ws
        print(
            f"{r.conversation_id}  "
            f"{'yes' if r.has_transcript else 'no':<10} "
            f"{'yes' if r.has_store else 'no':<6} "
            f"{extra}  {r.title_hint[:50]}"
        )


def cmd_export(args: argparse.Namespace) -> None:
    state_db = Path(args.state_db).expanduser() if args.state_db else None
    bundle, warnings = build_bundle(args.conversation_id, state_db)
    out = Path(args.output).expanduser()
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(bundle, indent=2), encoding="utf-8")
    print(f"Exported bundle -> {out}")
    print(
        f"  transcripts={len(bundle.get('transcriptFiles') or [])} "
        f"store={'yes' if bundle.get('storeSnapshot') else 'no'} "
        f"sidebar={'yes' if bundle.get('sidebarSnapshot') else 'no'}"
    )
    for w in warnings:
        print(f"  warning: {w}", file=sys.stderr)


def cmd_verify(args: argparse.Namespace) -> None:
    bundle_path = Path(args.bundle).expanduser() if args.bundle else None
    bundle: dict[str, Any] | None = None
    if bundle_path and bundle_path.is_file():
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
        cid = bundle["conversationId"]
    else:
        cid = args.conversation_id
    if not cid:
        raise SystemExit("Pass --bundle or --conversation-id")
    if not args.workspace_folder or not str(args.workspace_folder).strip():
        print(
            "error: --workspace-folder is required for verify (expected fsPath match)",
            file=sys.stderr,
        )
        raise SystemExit(1)
    ws_ctx = resolve_workspace_context(
        Path(args.state_db).expanduser() if args.state_db else None,
        args.workspace_folder,
    )
    if ws_ctx is None:
        raise SystemExit(
            f"Could not resolve workspace for --workspace-folder {args.workspace_folder!r}"
        )
    expect_rich = (
        sidebar_snapshot_has_composer_data(bundle, cid)
        if bundle is not None
        else False
    )
    expect_store = bool(bundle and bundle.get("storeSnapshot", {}).get("content"))
    checks = verify_import_visibility(
        cid,
        ws_ctx,
        expect_rich_composer_data=expect_rich,
        expect_store=expect_store,
    )
    if args.post_activate:
        checks.extend(verify_activation_checks(cid))
    print_verify_report(checks, json_lines=args.json_lines)
    if not verify_checks_all_ok(checks):
        raise SystemExit(1)


def cmd_import(args: argparse.Namespace) -> None:
    import_bundle(
        Path(args.bundle).expanduser(),
        args.target_project,
        args.target_workspace,
        Path(args.state_db).expanduser() if args.state_db else None,
        args.dry_run,
        pin_recent=not args.no_pin_recent,
        workspace_folder=args.workspace_folder,
        sync_global=not args.no_global_state,
        activate=args.activate,
        activate_strict=args.activate_strict,
        ping_server=args.ping_server,
        bridge_wait_result=max(0.0, float(args.bridge_wait_result)),
    )


def cmd_inspect(args: argparse.Namespace) -> None:
    bundle = json.loads(Path(args.bundle).expanduser().read_text(encoding="utf-8"))
    print(json.dumps({k: bundle.get(k) for k in (
        "schemaVersion", "type", "createdAt", "conversationId", "title",
        "subtitle", "previewText",
    )}, indent=2))
    tfs = bundle.get("transcriptFiles") or []
    print(f"transcriptFiles: {len(tfs)}")
    for tf in tfs[:20]:
        print(f"  - {tf.get('relativePath')} ({tf.get('sizeBytes')} bytes)")
    if len(tfs) > 20:
        print(f"  ... and {len(tfs) - 20} more")
    store = bundle.get("storeSnapshot")
    if store:
        print(
            f"storeSnapshot: {store.get('sizeBytes')} bytes, "
            f"workspace={store.get('sourceWorkspaceKey')}"
        )
    side = bundle.get("sidebarSnapshot")
    if isinstance(side, dict):
        keys = sorted(side.keys())
        print(f"sidebarSnapshot keys: {', '.join(keys)}")


def cmd_paths(args: argparse.Namespace) -> None:
    print("projects_root:", projects_root())
    print("chats_root:", chats_root())
    print("cursor_config:", cursor_config_root())
    print("state_db candidates:")
    for p in list_state_db_candidates():
        print(" ", p)
    folder = getattr(args, "workspace_folder", None)
    if folder:
        ctx = resolve_workspace_context(workspace_folder=folder)
        if ctx:
            print("\nresolved for --workspace-folder:")
            print("  folder:", ctx.folder_fs_path)
            print("  chats key (store.db):", ctx.chats_workspace_key)
            print("  workspaceStorage id (typical):", ctx.workspace_storage_id)


def cmd_resolve(args: argparse.Namespace) -> None:
    state_db = Path(args.state_db).expanduser() if args.state_db else None
    ctx = resolve_workspace_context(state_db, args.workspace_folder)
    if not ctx:
        raise SystemExit("Could not resolve workspace (pass --state-db or --workspace-folder).")
    print(json.dumps(
        {
            "folderFsPath": ctx.folder_fs_path,
            "chatsWorkspaceKey": ctx.chats_workspace_key,
            "workspaceStorageId": ctx.workspace_storage_id,
            "workspaceIdentifier": ctx.workspace_identifier,
            "suggestedImport": (
                f"python3 scripts/cursor_chat_io.py import <bundle.json> "
                f"--state-db ~/.config/Cursor/User/workspaceStorage/"
                f"{ctx.workspace_storage_id}/state.vscdb "
                f"--workspace-folder {ctx.folder_fs_path}"
            ),
        },
        indent=2,
    ))


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Export/import Cursor agent chats offline (cursor-sync ChatBundle format).",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    sub = parser.add_subparsers(dest="command", required=True)

    p_list = sub.add_parser("list", help="List known conversation IDs on this machine")
    p_list.set_defaults(func=cmd_list)

    p_paths = sub.add_parser("paths", help="Print resolved Cursor data paths")
    p_paths.add_argument("--workspace-folder", help="Show md5 chats key for this folder")
    p_paths.set_defaults(func=cmd_paths)

    p_res = sub.add_parser(
        "resolve",
        help="Print chats store key + workspaceStorage id for import (from --state-db or --workspace-folder)",
    )
    p_res.add_argument("--state-db", help="Path to workspaceStorage/.../state.vscdb")
    p_res.add_argument("--workspace-folder", help="Absolute path to opened workspace folder")
    p_res.set_defaults(func=cmd_resolve)

    p_exp = sub.add_parser("export", help="Export one conversation to a JSON bundle")
    p_exp.add_argument("conversation_id", help="UUID folder name")
    p_exp.add_argument("-o", "--output", required=True, help="Output .json path")
    p_exp.add_argument("--state-db", help="Explicit state.vscdb for sidebar snapshot")
    p_exp.set_defaults(func=cmd_export)

    p_imp = sub.add_parser("import", help="Import a JSON bundle")
    p_imp.add_argument("bundle", help="Bundle .json path")
    p_imp.add_argument("--target-project", help="Remap source project key to this projects/ folder name")
    p_imp.add_argument("--target-workspace", help="Restore store.db under this ~/.cursor/chats/ key")
    p_imp.add_argument("--state-db", help="state.vscdb to merge composer.* into")
    p_imp.add_argument(
        "--workspace-folder",
        required=True,
        help="Required: opened repo path; sets store.db chats key (md5) and workspaceIdentifier",
    )
    p_imp.add_argument("--dry-run", action="store_true", help="Show planned writes only")
    p_imp.add_argument(
        "--no-pin-recent",
        action="store_true",
        help="Keep original lastUpdatedAt instead of bumping to top of sidebar",
    )
    p_imp.add_argument(
        "--no-global-state",
        action="store_true",
        help="Do not merge into globalStorage/state.vscdb (not recommended)",
    )
    p_imp.add_argument(
        "--activate",
        action="store_true",
        help=(
            "After disk restore, build partialState and run cursor_composer_bridge.py "
            "(requires Cursor open on --workspace-folder)"
        ),
    )
    p_imp.add_argument(
        "--activate-strict",
        action="store_true",
        help="Fail import if bridge exits 2 (staged only, no hook/CLI activation)",
    )
    p_imp.add_argument(
        "--ping-server",
        action="store_true",
        help="Optional agentClient probe (v1 stub: logs not implemented)",
    )
    p_imp.add_argument(
        "--bridge-wait-result",
        type=float,
        default=0.0,
        metavar="SECONDS",
        help=(
            "With --activate, pass --wait-result to the bridge "
            "(poll ~/.cursor/import-activation/result.json)"
        ),
    )
    p_imp.set_defaults(func=cmd_import)

    p_ver = sub.add_parser("verify", help="Check whether an import should appear in the sidebar")
    p_ver.add_argument("--bundle", help="Bundle JSON (uses conversationId from it)")
    p_ver.add_argument("--conversation-id", help="Conversation UUID")
    p_ver.add_argument("--state-db", help="Workspace state.vscdb used for import")
    p_ver.add_argument(
        "--workspace-folder",
        required=True,
        help="Required: expected workspace folder path (fsPath match)",
    )
    p_ver.add_argument(
        "--json-lines",
        action="store_true",
        help="Emit verify report as JSON lines instead of [OK]/[FAIL] labels",
    )
    p_ver.add_argument(
        "--post-activate",
        action="store_true",
        help=(
            "Include activation checks (pending.json, result.json composerId) "
            "after import --activate"
        ),
    )
    p_ver.set_defaults(func=cmd_verify)

    p_insp = sub.add_parser("inspect", help="Summarize a bundle file")
    p_insp.add_argument("bundle")
    p_insp.set_defaults(func=cmd_inspect)

    args = parser.parse_args()
    args.func(args)


if __name__ == "__main__":
    main()
