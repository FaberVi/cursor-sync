import * as path from "node:path";

const COMPOSER_ID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isComposerConversationId(conversationId: string): boolean {
  return COMPOSER_ID_RE.test(conversationId);
}

export function isSafePathSegment(seg: string): boolean {
  if (seg.length === 0 || seg === "." || seg === "..") {
    return false;
  }
  if (seg.includes("/") || seg.includes("\\") || seg.includes("\0")) {
    return false;
  }
  return true;
}

/** Returns resolved absolute path when it stays under root; otherwise undefined. */
export function assertPathUnderRoot(
  absolutePath: string,
  root: string
): string | undefined {
  const resolved = path.resolve(absolutePath);
  const resolvedRoot = path.resolve(root);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return resolved;
}
