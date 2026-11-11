"""Golden store hydration and cursorDiskKV row synthesis (cursor_chat_io split module)."""
from __future__ import annotations

import base64
import hashlib
import json
import os
import sqlite3
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from cursor_chat_io_common import *
from cursor_chat_io_golden import *
from cursor_chat_io_agent_kv import is_disk_kv_key_in_conversation_scope

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
    conversation_id: str | None = None,
) -> tuple[bool, list[str]]:
    warnings: list[str] = []
    if conversation_id:
        scoped: dict[str, str] = {}
        for key, value in rows.items():
            if is_disk_kv_key_in_conversation_scope(key, conversation_id):
                scoped[key] = value
        rows = scoped
    if not rows:
        warnings.append("No cursorDiskKV rows to write.")
        return False, warnings
    if dry_run:
        return True, warnings
    conn = sqlite3.connect(db_path, timeout=30)
    try:
        conn.execute("PRAGMA busy_timeout=5000")
        conn.execute("BEGIN IMMEDIATE;")
        for key, value in rows.items():
            conn.execute(
                "INSERT OR REPLACE INTO cursorDiskKV(key, value) VALUES (?, ?);",
                (key, value),
            )
        conn.commit()
    except sqlite3.Error:
        conn.rollback()
        raise
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

