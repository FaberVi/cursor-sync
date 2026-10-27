import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { buildSyncTabState, renderSidebarShellHtml } from "../src/sidebar/html.js";
import * as chatSync from "../src/chat-sync.js";
import * as cursorDiffers from "../src/cursor-differs.js";
import * as diagnostics from "../src/diagnostics.js";
import * as paths from "../src/paths.js";

describe("sidebar boot overlay", () => {
  it("covers the shell with a spinner and the loading label", () => {
    const html = renderSidebarShellHtml(
      {
        extensionUri: { fsPath: "c:/ext" },
        extensionPath: "c:/missing-ext",
      } as import("vscode").ExtensionContext,
      {
        asWebviewUri: (uri: { fsPath: string }) => uri,
        cspSource: "https://mock.csp",
      } as unknown as import("vscode").Webview,
      3
    );

    expect(html).toContain('id="boot-overlay"');
    expect(html).toContain('data-boot="3"');
    expect(html).toContain('class="boot-spinner"');
    expect(html).toContain('<div class="boot-overlay-label">Loading</div>');
    expect(html.indexOf("boot-overlay")).toBeLessThan(html.indexOf('class="tab-bar"'));
  });

  it("reports live enumerated file count on full hydration instead of stale sync-state count", async () => {
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: "2026-10-14T09:09:03.285Z",
      lastSyncDirection: "push",
      localChecksums: {
        "cursor-user/settings.json": "1",
        "dot-cursor/rules/old-a.mdc": "2",
        "dot-cursor/rules/old-b.mdc": "3",
      },
      remoteChecksums: {},
      completedFileSync: true,
    });
    vi.spyOn(diagnostics, "loadSyncHistory").mockResolvedValue([]);
    vi.spyOn(chatSync, "countLocalDiscoveredChats").mockResolvedValue(0);
    vi.spyOn(cursorDiffers, "computeCursorDiffers").mockResolvedValue(false);
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      {
        absolutePath: "/tmp/settings.json",
        relativeSyncKey: "cursor-user/settings.json",
      },
    ]);

    const state = await buildSyncTabState(
      {
        extensionUri: { fsPath: "c:/ext" },
        extensionPath: "c:/missing-ext",
        globalStorageUri: { fsPath: "c:/storage" },
      } as import("vscode").ExtensionContext,
      { deferHeavyMetrics: false }
    );

    expect(state.fileCount).toBe(1);
    vi.restoreAllMocks();
  });

  it("reports 0 when all previously synced files are gone on full hydration", async () => {
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: "2026-10-14T09:09:03.285Z",
      lastSyncDirection: "push",
      localChecksums: {
        "dot-cursor/rules/old-a.mdc": "2",
      },
      remoteChecksums: {},
      completedFileSync: true,
    });
    vi.spyOn(diagnostics, "loadSyncHistory").mockResolvedValue([]);
    vi.spyOn(chatSync, "countLocalDiscoveredChats").mockResolvedValue(0);
    vi.spyOn(cursorDiffers, "computeCursorDiffers").mockResolvedValue(false);
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([]);

    const state = await buildSyncTabState(
      {
        extensionUri: { fsPath: "c:/ext" },
        extensionPath: "c:/missing-ext",
        globalStorageUri: { fsPath: "c:/storage" },
      } as import("vscode").ExtensionContext,
      { deferHeavyMetrics: false }
    );

    expect(state.fileCount).toBe(0);
    vi.restoreAllMocks();
  });
});
