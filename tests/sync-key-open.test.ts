import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";

const userRoot = vi.hoisted(() => `${process.env.TEMP ?? process.env.TMPDIR ?? "/tmp"}/cursor-sync-open-user`);

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({ cursorUser: userRoot, dotCursor: userRoot }),
}));
vi.mock("../src/sync-clone.js", () => ({
  readRepoIdentity: () => undefined,
  getSyncClonePath: () => "/tmp/clone",
}));

import * as vscode from "vscode";
import { openSyncKeyFile, syncKeyOpenCandidates } from "../src/sync-key-picker.js";

describe("syncKeyOpenCandidates", () => {
  it("lists the Cursor file before the clone copy", () => {
    const candidates = syncKeyOpenCandidates(
      "cursor-user/settings.json",
      { cursorUser: path.join("C:", "Cursor", "User"), dotCursor: path.join("C:", "dot") },
      { clonePath: path.join("C:", "clone"), basePath: "cursor-sync" }
    );
    expect(candidates).toEqual([
      path.resolve(path.join("C:", "Cursor", "User", "settings.json")),
      path.resolve(path.join("C:", "clone", "cursor-sync", "cursor-user", "settings.json")),
    ]);
  });

  it("drops keys that climb out of the sync roots", () => {
    expect(
      syncKeyOpenCandidates(
        "cursor-user/../../outside.txt",
        { cursorUser: path.join("C:", "Cursor", "User"), dotCursor: path.join("C:", "dot") },
        { clonePath: path.join("C:", "clone"), basePath: "cursor-sync" }
      )
    ).toEqual([]);
  });

  it("opens the local file in the main editor", async () => {
    const filePath = path.join(userRoot, "settings.json");
    await fs.mkdir(userRoot, { recursive: true });
    await fs.writeFile(filePath, "{}\n", "utf-8");
    const showTextDocument = vi.fn(async () => ({}));
    (vscode.window as { showTextDocument: typeof showTextDocument }).showTextDocument =
      showTextDocument;

    await openSyncKeyFile("cursor-user/settings.json");

    expect(showTextDocument).toHaveBeenCalledWith(
      expect.objectContaining({ fsPath: filePath }),
      expect.objectContaining({ viewColumn: vscode.ViewColumn.One, preview: true })
    );
    await fs.rm(userRoot, { recursive: true, force: true });
  });
});
