import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as vscode from "vscode";
import { dispatchSidebarMessage } from "../src/sidebar/messages.js";
import { renderHistoryEntry } from "../src/sidebar/sync-tab.js";
import type { SyncHistoryEntry } from "../src/types.js";

function mockWebview() {
  return {
    postMessage: vi.fn().mockResolvedValue(undefined),
  } as any;
}

describe("renderHistoryEntry", () => {
  it("marks entries clickable with history:details command", () => {
    const entry: SyncHistoryEntry = {
      timestamp: "2026-07-19T10:00:00.000Z",
      direction: "push",
      trigger: "manual",
      fileCount: 2,
      success: true,
      files: ["settings.json", "keybindings.json"],
    };
    const html = renderHistoryEntry(entry);
    expect(html).toContain('data-command="history:details"');
    expect(html).toContain('data-timestamp="2026-07-19T10:00:00.000Z"');
    expect(html).toContain("Show files involved in this sync");
  });
});

describe("dispatchSidebarMessage - history:details", () => {
  let storageRoot: string;
  let showQuickPick: ReturnType<typeof vi.spyOn>;
  let showInformationMessage: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-history-"));
    showQuickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    showInformationMessage = vi
      .spyOn(vscode.window, "showInformationMessage")
      .mockResolvedValue(undefined);
  });

  afterEach(() => {
    showQuickPick.mockRestore();
    showInformationMessage.mockRestore();
  });

  it("shows QuickPick with files for a matching history entry", async () => {
    const entry: SyncHistoryEntry = {
      timestamp: "2026-07-19T12:00:00.000Z",
      direction: "pull",
      trigger: "manual",
      fileCount: 2,
      success: true,
      files: ["settings.json", "keybindings.json"],
    };
    await fs.writeFile(
      path.join(storageRoot, "sync-history.json"),
      JSON.stringify([entry], null, 2),
      "utf-8"
    );

    const ctx = {
      globalStorageUri: { fsPath: storageRoot },
      globalState: { get: () => undefined, update: async () => {} },
      extensionUri: { fsPath: "/fake" },
    } as any;

    await dispatchSidebarMessage(ctx, mockWebview(), {
      command: "history:details",
      timestamp: entry.timestamp,
    });

    expect(showQuickPick).toHaveBeenCalledOnce();
    const [items, options] = showQuickPick.mock.calls[0]!;
    expect(items).toEqual([
      { label: "settings.json" },
      { label: "keybindings.json" },
    ]);
    expect(options).toMatchObject({
      title: "Pull · 2 files",
      placeHolder: "Files involved in this sync",
    });
  });

  it("informs when file list was not recorded", async () => {
    const entry: SyncHistoryEntry = {
      timestamp: "2026-07-19T11:00:00.000Z",
      direction: "push",
      trigger: "scheduled",
      fileCount: 3,
      success: true,
    };
    await fs.writeFile(
      path.join(storageRoot, "sync-history.json"),
      JSON.stringify([entry], null, 2),
      "utf-8"
    );

    const ctx = {
      globalStorageUri: { fsPath: storageRoot },
      globalState: { get: () => undefined, update: async () => {} },
      extensionUri: { fsPath: "/fake" },
    } as any;

    await dispatchSidebarMessage(ctx, mockWebview(), {
      command: "history:details",
      timestamp: entry.timestamp,
    });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenCalledWith(
      expect.stringContaining("File list was not recorded")
    );
  });
});
