import { describe, it, expect } from "vitest";
import { shouldSkipChatPackaging } from "../src/chat-sync-skip.js";

describe("shouldSkipChatPackaging", () => {
  it("returns false when remote chat checksum is missing", () => {
    expect(
      shouldSkipChatPackaging({
        lastLocalChecksum: "abc",
        storedFingerprint: "fp",
        currentFingerprint: "fp",
      })
    ).toBe(false);
  });

  it("returns true when fingerprint and checksums match", () => {
    expect(
      shouldSkipChatPackaging({
        remoteChecksum: "content-hash",
        lastLocalChecksum: "content-hash",
        storedFingerprint: "fp",
        currentFingerprint: "fp",
      })
    ).toBe(true);
  });

  it("returns false when remote checksum diverged", () => {
    expect(
      shouldSkipChatPackaging({
        remoteChecksum: "remote-new",
        lastLocalChecksum: "content-hash",
        storedFingerprint: "fp",
        currentFingerprint: "fp",
      })
    ).toBe(false);
  });

  it("returns false when fingerprint changed", () => {
    expect(
      shouldSkipChatPackaging({
        remoteChecksum: "content-hash",
        lastLocalChecksum: "content-hash",
        storedFingerprint: "fp-old",
        currentFingerprint: "fp-new",
      })
    ).toBe(false);
  });
});
