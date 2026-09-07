import { describe, expect, it } from "vitest";
import {
  isLegacyChatBundleDocument,
  isNativeChatJsonDocument,
  parseNativeChatJson,
} from "../src/native-chat-json/parse.js";
import { NATIVE_CHAT_JSON_VERSION } from "../src/native-chat-json/types.js";

describe("native-chat-json", () => {
  it("accepts version 1 document", () => {
    const doc = {
      version: NATIVE_CHAT_JSON_VERSION,
      conversationId: "00000000-0000-4000-8000-000000000001",
      conversationState: "~abc",
      blobs: [{ hash: "h1", content: "c1" }],
    };
    expect(isNativeChatJsonDocument(doc)).toBe(true);
    expect(parseNativeChatJson(JSON.stringify(doc))).toEqual(doc);
  });

  it("rejects legacy chat bundle as native", () => {
    const legacy = {
      schemaVersion: 2,
      type: "chat-persistence",
      conversationId: "x",
    };
    expect(isNativeChatJsonDocument(legacy)).toBe(false);
    expect(isLegacyChatBundleDocument(legacy)).toBe(true);
  });
});
