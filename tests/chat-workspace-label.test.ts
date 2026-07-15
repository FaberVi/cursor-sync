import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

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
    const result = formatDisplayPath(abs, "/home/user");
    expect(result.replace(/\\/g, "/").replace(/^[A-Za-z]:/, "")).toBe(abs);
  });
});

import { md5FolderKey } from "../src/chat-workspace-context.js";

describe("workspaceQuickPickLabel", () => {
  it("uses tilde path when key resolves in map", async () => {
    const { workspaceQuickPickLabel } = await import("../src/chat-workspace-label.js");
    const home = os.homedir();
    const folder = path.join(home, "dev", "app");
    const key = md5FolderKey(folder);
    const map = new Map([[key, folder]]);
    const row = workspaceQuickPickLabel(key, map, home);
    expect(row.label).toBe("~/dev/app");
    expect(row.description).toBe(key);
  });

  it("falls back to humanWorkspaceLabel for unknown key", async () => {
    const { workspaceQuickPickLabel, humanWorkspaceLabel } = await import(
      "../src/chat-workspace-label.js"
    );
    const key = "573b4babd5b2f206e06d748cd840b177";
    const row = workspaceQuickPickLabel(key, new Map(), os.homedir());
    expect(row.label).toBe(humanWorkspaceLabel(key));
    expect(row.description).toBe(key);
  });
});

describe("projectQuickPickLabel", () => {
  it("uses decoded folder label when project dir matches map folder basename", async () => {
    const { projectQuickPickLabel } = await import("../src/chat-workspace-label.js");
    const home = os.homedir();
    const folder = path.join(home, "dev", "cursor-sync");
    const map = new Map([[md5FolderKey(folder), folder]]);
    const projectDir = "home-user-dev-cursor-sync-abcdef12";
    expect(projectQuickPickLabel(projectDir, map, home)).toBe("home-user-dev-cursor-sync");
  });

  it("falls back to humanWorkspaceLabel when no match", async () => {
    const { projectQuickPickLabel, humanWorkspaceLabel } = await import(
      "../src/chat-workspace-label.js"
    );
    const name = "orphan-project-abcdef12";
    expect(projectQuickPickLabel(name, new Map(), os.homedir())).toBe(
      humanWorkspaceLabel(name)
    );
  });
});

describe("decodeCursorProjectFolderName", () => {
  it("decodes c-Users-* project folders to repo title", async () => {
    const { decodeCursorProjectFolderName } = await import("../src/chat-workspace-label.js");
    expect(
      decodeCursorProjectFolderName("c-Users-Utente-Documents-GitHub-Web-cursor-sync")
    ).toBe("cursor-sync");
    expect(
      decodeCursorProjectFolderName("c-Users-Utente-Documents-GitHub-Web-formamente-webservice")
    ).toBe("formamente-webservice");
  });

  it("labels numeric workspace folders", async () => {
    const { decodeCursorProjectFolderName } = await import("../src/chat-workspace-label.js");
    expect(decodeCursorProjectFolderName("1779313625545")).toBe("Workspace 1779313625545");
  });
});
