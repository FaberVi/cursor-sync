import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const plainSingle = readFileSync(
  path.join(testsDir, "fixtures", "chat-gist-encryption", "plain-single-bundle.json"),
  "utf-8"
);
const plainCollection = readFileSync(
  path.join(testsDir, "fixtures", "chat-gist-encryption", "plain-collection.json"),
  "utf-8"
);

describe("chat-gist-crypto", () => {
  it("round-trips single chat-bundle plaintext", async () => {
    const { encryptChatGistPayload, decryptChatGistPayload } = await import(
      "../src/chat-gist-crypto.js"
    );
    const envelopeJson = await encryptChatGistPayload(
      plainSingle,
      "test-password-123",
      "chat-bundle"
    );
    const decrypted = await decryptChatGistPayload(envelopeJson, "test-password-123");
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(plainSingle));
  });

  it("round-trips chat-bundles-collection plaintext", async () => {
    const { encryptChatGistPayload, decryptChatGistPayload } = await import(
      "../src/chat-gist-crypto.js"
    );
    const envelopeJson = await encryptChatGistPayload(
      plainCollection,
      "collection-pass",
      "chat-bundles-collection"
    );
    const decrypted = await decryptChatGistPayload(envelopeJson, "collection-pass");
    expect(JSON.parse(decrypted)).toEqual(JSON.parse(plainCollection));
  });

  it("isEncryptedChatGistPayload detects envelope vs plain", async () => {
    const { encryptChatGistPayload, isEncryptedChatGistPayload } = await import(
      "../src/chat-gist-crypto.js"
    );
    const envelopeJson = await encryptChatGistPayload(
      plainSingle,
      "pw",
      "chat-bundle"
    );
    expect(isEncryptedChatGistPayload(envelopeJson)).toBe(true);
    expect(isEncryptedChatGistPayload(plainSingle)).toBe(false);
  });

  it("decrypt fails with wrong password", async () => {
    const { encryptChatGistPayload, decryptChatGistPayload, ChatGistCryptoError } =
      await import("../src/chat-gist-crypto.js");
    const envelopeJson = await encryptChatGistPayload(plainSingle, "correct", "chat-bundle");
    await expect(decryptChatGistPayload(envelopeJson, "wrong")).rejects.toMatchObject({
      code: "DECRYPT_FAILED",
    });
    expect(ChatGistCryptoError).toBeDefined();
  });

  it("decrypt fails when auth tag is tampered", async () => {
    const { encryptChatGistPayload, decryptChatGistPayload } = await import(
      "../src/chat-gist-crypto.js"
    );
    const envelopeJson = await encryptChatGistPayload(plainSingle, "pw", "chat-bundle");
    const envelope = JSON.parse(envelopeJson) as {
      cursorSyncEncrypted: { cipher: { tag: string } };
    };
    const tagBuf = Buffer.from(envelope.cursorSyncEncrypted.cipher.tag, "base64");
    tagBuf[0] = tagBuf[0]! ^ 0xff;
    envelope.cursorSyncEncrypted.cipher.tag = tagBuf.toString("base64");
    await expect(
      decryptChatGistPayload(JSON.stringify(envelope), "pw")
    ).rejects.toMatchObject({ code: "DECRYPT_FAILED" });
  });

  it("rejects invalid envelope schema before decrypt", async () => {
    const { decryptChatGistPayload } = await import("../src/chat-gist-crypto.js");
    await expect(
      decryptChatGistPayload(JSON.stringify({ cursorSyncEncrypted: { formatVersion: 99 } }), "pw")
    ).rejects.toThrow(/invalid|unsupported/i);
  });
});
