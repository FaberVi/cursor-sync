"""Workspace path roots and context resolution (cursor_chat_io split module)."""
from __future__ import annotations

import hashlib
import json
import os
import platform
from dataclasses import dataclass
from pathlib import Path
from typing import Any

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


@dataclass
class WorkspaceContext:
    workspace_storage_id: str
    folder_fs_path: str
    chats_workspace_key: str
    workspace_identifier: dict[str, Any]


def md5_folder_key(folder_fs_path: str) -> str:
    return hashlib.md5(folder_fs_path.encode()).hexdigest()


def folder_path_from_workspace_uri(uri: str) -> str:
    if uri.startswith("file://"):
        from urllib.parse import unquote, urlparse
        from urllib.request import url2pathname

        parsed = urlparse(uri)
        return url2pathname(unquote(parsed.path))
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
