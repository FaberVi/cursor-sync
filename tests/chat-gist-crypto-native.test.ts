import { describe, expect, it } from "vitest";
import {
  decryptChatGistPayload,
  encryptChatGistPayload,
  isEncryptedChatGistPayload,
} from "../src/chat-gist-crypto.js";

describe("cursor-chat-collection encryption", () => {
  it("round-trips cursor-chat-collection plaintext", async () => {
    const plaintext = JSON.stringify({
      version: 1,
      type: "cursor-chat-collection",
      createdAt: "2026-01-01T00:00:00Z",
      chats: [],
    });
    const encrypted = await encryptChatGistPayload(
      plaintext,
      "test-password",
      "cursor-chat-collection"
    );
    expect(isEncryptedChatGistPayload(encrypted)).toBe(true);
    const decrypted = await decryptChatGistPayload(encrypted, "test-password");
    expect(decrypted).toBe(plaintext);
  });
});
