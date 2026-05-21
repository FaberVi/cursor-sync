import { describe, expect, it } from "vitest";

describe("humanWorkspaceLabel", () => {
  it("strips 40-char hex suffix", async () => {
    const { humanWorkspaceLabel } = await import("../src/chat-workspace-label.js");
    expect(humanWorkspaceLabel("my-repo-deadbeefdeadbeefdeadbeefdeadbeefdeadbeef")).toBe(
      "my-repo"
    );
  });

  it("strips 8-char hex suffix", async () => {
    const { humanWorkspaceLabel } = await import("../src/chat-workspace-label.js");
    expect(humanWorkspaceLabel("workspace-abcdef12")).toBe("workspace");
  });

  it("returns folder name when no hash suffix", async () => {
    const { humanWorkspaceLabel } = await import("../src/chat-workspace-label.js");
    expect(humanWorkspaceLabel("plain-name")).toBe("plain-name");
  });
});
