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

import * as os from "node:os";
import * as path from "node:path";

describe("formatDisplayPath", () => {
  it("shortens paths under home with tilde", async () => {
    const { formatDisplayPath } = await import("../src/chat-workspace-label.js");
    const home = os.homedir();
    const folder = path.join(home, "dev", "private", "cursor-sync");
    expect(formatDisplayPath(folder, home)).toBe("~/dev/private/cursor-sync");
  });

  it("normalizes trailing slash before home prefix match", async () => {
    const { formatDisplayPath } = await import("../src/chat-workspace-label.js");
    const home = "/home/user";
    expect(formatDisplayPath("/home/user/proj/", home)).toBe("~/proj");
  });

  it("returns absolute path when outside home", async () => {
    const { formatDisplayPath } = await import("../src/chat-workspace-label.js");
    const abs = "/var/lib/cursor/proj";
    expect(formatDisplayPath(abs, "/home/user")).toBe(abs);
  });
});
