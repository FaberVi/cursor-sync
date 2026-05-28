import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { md5FolderKey } from "./chat-workspace-context.js";
import { resolveSyncRoots } from "./paths.js";

const CHAT_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ChatEditorExportTarget {
  conversationId: string;
  workspaceKey: string;
}

export type ChatEditorExportTargetResolution =
  | { ok: true; target: ChatEditorExportTarget }
  | { ok: false; reason: "not-chat" }
  | { ok: false; reason: "store-not-found"; conversationId: string }
  | {
      ok: false;
      reason: "ambiguous";
      conversationId: string;
      workspaceKeys: string[];
    };

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function extractConversationIdFromString(value: string): string | null {
  const decoded = safeDecode(value.trim());
  if (!decoded) return null;
  if (CHAT_ID_RE.test(decoded)) return decoded;
  const withoutQuery = decoded.split(/[?#]/, 1)[0] ?? decoded;
  const parts = withoutQuery.split(/[\\/]/).filter(Boolean);
  const last = parts[parts.length - 1];
  return last && CHAT_ID_RE.test(last) ? last : null;
}

export function extractConversationIdFromTarget(target: unknown): string | null {
  if (typeof target === "string") {
    return extractConversationIdFromString(target);
  }
  if (!target || typeof target !== "object") {
    return null;
  }
  const obj = target as Record<string, unknown>;
  for (const key of ["path", "fsPath", "external"]) {
    const value = obj[key];
    if (typeof value === "string") {
      const id = extractConversationIdFromString(value);
      if (id) return id;
    }
  }
  return null;
}

export function extractConversationIdFromTabInput(input: unknown): string | null {
  if (!input || typeof input !== "object") {
    return null;
  }
  const obj = input as Record<string, unknown>;
  for (const key of ["uri", "resource", "modified", "original"]) {
    const id = extractConversationIdFromTarget(obj[key]);
    if (id) return id;
  }
  return extractConversationIdFromTarget(input);
}

function activeTabInput(): unknown {
  return vscode.window.tabGroups?.activeTabGroup.activeTab?.input;
}

function currentWorkspaceKey(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const fsPath = folder?.uri?.fsPath;
  return fsPath ? md5FolderKey(path.resolve(fsPath)) : undefined;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function findWorkspaceKeysForConversation(conversationId: string): Promise<string[]> {
  const chatsRoot = path.join(resolveSyncRoots().dotCursor, "chats");
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const storePath = path.join(chatsRoot, entry.name, conversationId, "store.db");
    if (await fileExists(storePath)) {
      matches.push(entry.name);
    }
  }
  return matches.sort((a, b) => a.localeCompare(b));
}

export async function resolveChatEditorExportTarget(
  target: unknown
): Promise<ChatEditorExportTargetResolution> {
  const conversationId =
    extractConversationIdFromTarget(target) ??
    extractConversationIdFromTabInput(activeTabInput());
  if (!conversationId) {
    return { ok: false, reason: "not-chat" };
  }

  const workspaceKeys = await findWorkspaceKeysForConversation(conversationId);
  if (workspaceKeys.length === 0) {
    return { ok: false, reason: "store-not-found", conversationId };
  }

  const currentKey = currentWorkspaceKey();
  if (currentKey && workspaceKeys.includes(currentKey)) {
    return { ok: true, target: { conversationId, workspaceKey: currentKey } };
  }

  if (workspaceKeys.length === 1) {
    return {
      ok: true,
      target: { conversationId, workspaceKey: workspaceKeys[0]! },
    };
  }

  return { ok: false, reason: "ambiguous", conversationId, workspaceKeys };
}
