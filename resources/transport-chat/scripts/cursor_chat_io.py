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

from datetime import datetime, timezone
import subprocess

from cursor_chat_io_common import *
from cursor_chat_io_bundle import *
from cursor_chat_io_import import *
from cursor_chat_io_cli import main

if __name__ == "__main__":
    main()
