import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: () => undefined,
    }),
  },
}));

import { encryptChatGistPayload, decryptChatGistPayload } from "../src/chat-gist-crypto.js";
import { parseChatBundleOrCollection } from "../src/chat-bundle-format.js";

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const plainSingle = readFileSync(
  path.join(testsDir, "fixtures", "chat-gist-encryption", "plain-single-bundle.json"),
  "utf-8"
);

describe("chat gist encryption round-trip parse", () => {
  it("encrypted envelope decrypts to parseable chat bundle", async () => {
    const envelope = await encryptChatGistPayload(plainSingle, "e2e-pass", "chat-bundle");
    const decrypted = await decryptChatGistPayload(envelope, "e2e-pass");
    const parsed = parseChatBundleOrCollection(decrypted);
    expect(parsed.kind).toBe("single");
    if (parsed.kind === "single") {
      expect(parsed.bundle.conversationId).toBe("conv-crypto-fixture-001");
    }
  });
});
