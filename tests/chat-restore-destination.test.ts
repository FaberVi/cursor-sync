import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expandUserFolder } from "../src/chat-workspace-context.js";
import {
  createRestoreDestinationCache,
  isOpenWorkspaceFolder,
  pathsReferToSameFolder,
  resolveRestoreWorkspaceFolder,
} from "../src/chat-restore-destination.js";

vi.mock("vscode", () => ({
  workspace: {
    workspaceFolders: [] as Array<{ uri: { fsPath: string } }>,
  },
  window: {
    showQuickPick: vi.fn(),
  },
}));

describe("restore destination routing", () => {
  let tempHome: string;

  beforeEach(async () => {
    tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-dest-"));
  });

  afterEach(async () => {
    await fs.rm(tempHome, { recursive: true, force: true });
  });

  it("expandUserFolder maps ~/path under the given home", () => {
    const expanded = expandUserFolder("~/Documents/foo", tempHome);
    expect(path.resolve(expanded)).toBe(path.resolve(path.join(tempHome, "Documents", "foo")));
  });

  it("resolves sourceFolderTilde to an existing directory without prompting", async () => {
    const dest = path.join(tempHome, "proj-a");
    await fs.mkdir(dest, { recursive: true });
    const prompt = vi.fn();
    const folder = await resolveRestoreWorkspaceFolder(
      { sourceFolderTilde: "~/proj-a" },
      { homeDir: tempHome, promptMissingFolder: prompt }
    );
    expect(folder && path.resolve(folder)).toBe(path.resolve(dest));
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts once per tilde and caches the pick when the folder is missing", async () => {
    const picked = path.join(tempHome, "mapped");
    await fs.mkdir(picked, { recursive: true });
    const prompt = vi.fn(async () => picked);
    const cache = createRestoreDestinationCache();
    const first = await resolveRestoreWorkspaceFolder(
      { sourceFolderTilde: "~/missing-proj" },
      { homeDir: tempHome, cache, promptMissingFolder: prompt }
    );
    const second = await resolveRestoreWorkspaceFolder(
      { sourceFolderTilde: "~/missing-proj" },
      { homeDir: tempHome, cache, promptMissingFolder: prompt }
    );
    expect(first && path.resolve(first)).toBe(path.resolve(picked));
    expect(second && path.resolve(second)).toBe(path.resolve(picked));
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("isOpenWorkspaceFolder is case-insensitive on Windows", () => {
    const open = [{ uri: { fsPath: path.join(tempHome, "Open") } }];
    const candidate = path.join(tempHome, "open");
    if (process.platform === "win32") {
      expect(isOpenWorkspaceFolder(candidate, open)).toBe(true);
    } else {
      expect(pathsReferToSameFolder(open[0]!.uri.fsPath, open[0]!.uri.fsPath)).toBe(true);
    }
  });
});
