import * as vscode from "vscode";

export const DEFAULT_EXCLUDE_JSON_KEYS = ["python.defaultInterpreterPath"];

export function readExcludeJsonKeys(): string[] {
  const raw = vscode.workspace.getConfiguration("cursorSync").get("excludeJsonKeys");
  if (!Array.isArray(raw)) {
    return [...DEFAULT_EXCLUDE_JSON_KEYS];
  }
  return raw.filter((key): key is string => typeof key === "string" && key.length > 0);
}

export function stripExcludedJsonKeys(buf: Buffer, keys: string[]): Buffer {
  if (keys.length === 0) {
    return buf;
  }
  const text = buf.toString("utf8");
  const obj = parseJsonObject(text);
  if (!obj) {
    return buf;
  }
  let changed = false;
  const next: Record<string, unknown> = { ...obj };
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(next, key)) {
      delete next[key];
      changed = true;
    }
  }
  if (!changed) {
    return buf;
  }
  return Buffer.from(stringifyJson(next, text), "utf8");
}

export function restoreExcludedJsonKeys(
  remoteBuf: Buffer,
  localBuf: Buffer,
  keys: string[]
): Buffer {
  const stripped = stripExcludedJsonKeys(remoteBuf, keys);
  if (keys.length === 0 || localBuf.length === 0) {
    return stripped;
  }
  const remoteObj = parseJsonObject(stripped.toString("utf8"));
  if (!remoteObj) {
    return remoteBuf;
  }
  const localObj = parseJsonObject(localBuf.toString("utf8"));
  if (!localObj) {
    return stripped;
  }
  let copied = false;
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(localObj, key)) {
      remoteObj[key] = localObj[key];
      copied = true;
    }
  }
  if (!copied) {
    return stripped;
  }
  return Buffer.from(stringifyJson(remoteObj, remoteBuf.toString("utf8")), "utf8");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function detectIndent(text: string): number | string {
  const match = text.match(/\n([ \t]+)"/);
  if (!match) {
    return 4;
  }
  const ws = match[1]!;
  if (/^\t+$/.test(ws)) {
    return ws;
  }
  if (/^ +$/.test(ws)) {
    return ws.length <= 10 ? ws.length : 10;
  }
  return 4;
}

function stringifyJson(obj: Record<string, unknown>, sourceText: string): string {
  const body = JSON.stringify(obj, null, detectIndent(sourceText));
  return sourceText.endsWith("\n") ? `${body}\n` : body;
}
