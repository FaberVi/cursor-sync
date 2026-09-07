import { describe, it, expect } from "vitest";
import * as path from "node:path";
import {
  assertPathUnderRoot,
  isComposerConversationId,
  isSafePathSegment,
} from "../src/composer-id.js";

describe("composer-id path safety", () => {
  it("accepts UUID conversation ids only", () => {
    expect(
      isComposerConversationId("11111111-1111-1111-1111-111111111111")
    ).toBe(true);
    expect(isComposerConversationId("../../../.ssh")).toBe(false);
    expect(isComposerConversationId("not-a-uuid")).toBe(false);
  });

  it("rejects unsafe path segments", () => {
    expect(isSafePathSegment("abc")).toBe(true);
    expect(isSafePathSegment("..")).toBe(false);
    expect(isSafePathSegment("../evil")).toBe(false);
    expect(isSafePathSegment("a/b")).toBe(false);
  });

  it("rejects paths that escape the root", () => {
    const root = path.resolve("/tmp/agent-transcripts");
    const escaped = path.resolve(root, "../../../.ssh");
    expect(assertPathUnderRoot(escaped, root)).toBeUndefined();
    const ok = path.resolve(root, "11111111-1111-1111-1111-111111111111");
    expect(assertPathUnderRoot(ok, root)).toBe(ok);
  });
});
