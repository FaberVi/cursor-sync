import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as vscode from "vscode";
import { dispatchSidebarMessage } from "../src/sidebar/messages.js";
import {
  HISTORY_PAGE_SIZE,
  renderHistoryEntry,
  renderHistorySection,
  renderSyncPane,
  sliceHistoryPage,
} from "../src/sidebar/sync-tab.js";
import type { SyncTabState } from "../src/sidebar/sync-tab.js";
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
    expect(html).toContain('data-command="history:delete"');
    expect(html).toContain('class="history-delete-icon"');
    expect(html).toContain("Show files involved in this sync");
    expect(html).toContain("2 files");
  });

  it("shows changed / total when totalFileCount is present", () => {
    const entry: SyncHistoryEntry = {
      timestamp: "2026-07-19T10:00:00.000Z",
      direction: "push",
      trigger: "manual",
      fileCount: 2,
      totalFileCount: 579,
      success: true,
      files: ["a.json", "b.json"],
    };
    const html = renderHistoryEntry(entry);
    expect(html).toContain("2 / 579 files");
  });
});

function minimalSyncState(
  pendingConflicts: NonNullable<SyncTabState["pendingConflicts"]>
): SyncTabState {
  return {
    status: "synced",
    lastSyncTime: undefined,
    lastSyncDirection: undefined,
    fileCount: 0,
    gistId: undefined,
    remoteLabel: undefined,
    remoteUrl: undefined,
    destinationKind: undefined,
    extensionVersion: "0.12.1",
    history: [],
    chatsSyncEnabled: false,
    localChatCount: 0,
    remoteChatCount: undefined,
    pendingConflicts,
  };
}

describe("conflict panel rendering", () => {
  it("does not pre-select Skip and shows resolved banner after keepLocal", () => {
    const unresolved = renderSyncPane(
      minimalSyncState([{ relativeSyncKey: "cursor-user/settings.json" }])
    );
    expect(unresolved).not.toContain("pager-btn-active");
    expect(unresolved).not.toContain("conflict-resolved-banner");

    const resolved = renderSyncPane(
      minimalSyncState([
        { relativeSyncKey: "cursor-user/settings.json", resolution: "keepLocal" },
        { relativeSyncKey: "cursor-user/keybindings.json", resolution: "keepLocal" },
      ])
    );
    expect(resolved).toContain("conflict-resolved-banner");
    expect(resolved).toContain("Conflicts resolved. Press Sync Now to apply.");
    expect(resolved).toContain("pager-btn-active");
    expect(resolved).toContain('data-relative-sync-key="cursor-user/settings.json"');
    expect(resolved).toContain('data-relative-sync-key="cursor-user/keybindings.json"');
  });
});

describe("history pagination", () => {
  function entry(i: number): SyncHistoryEntry {
    return {
      timestamp: `2026-07-19T10:00:0${i}.000Z`,
      direction: i % 2 === 0 ? "push" : "pull",
      trigger: "manual",
      fileCount: i,
      success: true,
    };
  }

  it("shows at most HISTORY_PAGE_SIZE entries per page", () => {
    const history = Array.from({ length: 12 }, (_, i) => entry(i));
    const page0 = sliceHistoryPage(history, 0);
    expect(page0).toHaveLength(HISTORY_PAGE_SIZE);
    expect(page0[0]!.fileCount).toBe(0);
    expect(page0[4]!.fileCount).toBe(4);

    const page1 = sliceHistoryPage(history, 1);
    expect(page1).toHaveLength(HISTORY_PAGE_SIZE);
    expect(page1[0]!.fileCount).toBe(5);

    const page2 = sliceHistoryPage(history, 2);
    expect(page2).toHaveLength(2);
  });

  it("renders pager only when history exceeds page size", () => {
    const short = renderHistorySection(Array.from({ length: 5 }, (_, i) => entry(i)));
    expect(short).not.toContain("history:prev");
    expect(short).toContain("history-entry");

    const long = renderHistorySection(Array.from({ length: 6 }, (_, i) => entry(i)), 0);
    expect(long).toContain('data-command="history:prev"');
    expect(long).toContain('data-command="history:next"');
    expect(long).toContain("1 / 2");
    expect((long.match(/class="history-entry"/g) || []).length).toBe(HISTORY_PAGE_SIZE);
  });
});

describe("sync history storage", () => {
  let storageRoot: string;

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-hist-store-"));
  });

  it("removeSyncHistoryEntry deletes by timestamp", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    const ctx = {
      globalStorageUri: { fsPath: storageRoot },
    } as import("vscode").ExtensionContext;

    const a: SyncHistoryEntry = {
      timestamp: "2026-07-19T10:00:00.000Z",
      direction: "push",
      trigger: "manual",
      fileCount: 1,
      success: true,
    };
    const b: SyncHistoryEntry = {
      timestamp: "2026-07-19T10:00:01.000Z",
      direction: "pull",
      trigger: "manual",
      fileCount: 1,
      success: true,
    };
    await diagnostics.addSyncHistoryEntry(ctx, a);
    await diagnostics.addSyncHistoryEntry(ctx, b);

    const removed = await diagnostics.removeSyncHistoryEntry(ctx, b.timestamp);
    expect(removed).toBe(true);
    const history = await diagnostics.loadSyncHistory(ctx);
    expect(history).toHaveLength(1);
    expect(history[0]?.timestamp).toBe(a.timestamp);
  });

  it("clearSyncHistory empties the file", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    const ctx = {
      globalStorageUri: { fsPath: storageRoot },
    } as import("vscode").ExtensionContext;

    await diagnostics.addSyncHistoryEntry(ctx, {
      timestamp: "2026-07-19T10:00:00.000Z",
      direction: "push",
      trigger: "manual",
      fileCount: 1,
      success: true,
    });
    await diagnostics.clearSyncHistory(ctx);
    expect(await diagnostics.loadSyncHistory(ctx)).toEqual([]);
  });
});

describe("renderSyncPane loading shell", () => {
  it("shows loading instead of never-synced placeholders during startup", () => {
    const state: SyncTabState = {
      status: "loading",
      lastSyncTime: undefined,
      lastSyncDirection: undefined,
      fileCount: 0,
      gistId: undefined,
      remoteLabel: undefined,
      remoteUrl: undefined,
      destinationKind: undefined,
      extensionVersion: "1.0.0",
      history: [],
      historyLoading: true,
      chatsSyncEnabled: false,
      localChatCount: 0,
      remoteChatCount: undefined,
      chatCountsLoading: true,
      pendingConflicts: [],
    };
    const html = renderSyncPane(state, 0);
    expect(html).toContain('status-card loading');
    expect(html).toContain("Loading");
    expect(html).not.toContain("Never");
    expect(html).not.toContain("Not linked");
    expect(html).not.toContain("No sync history yet");
  });
});

describe("renderSyncPane history header", () => {
  it("shows clear-all control when history has entries", () => {
    const state = minimalSyncState([]);
    state.history = [
      {
        timestamp: "2026-07-19T10:00:00.000Z",
        direction: "push",
        trigger: "manual",
        fileCount: 1,
        success: true,
      },
    ];
    const html = renderSyncPane(state, 0);
    expect(html).toContain('data-command="history:clearAll"');
    expect(html).toContain("history-section-header");
  });

  it("hides clear-all when history is empty", () => {
    const html = renderSyncPane(minimalSyncState([]), 0);
    expect(html).not.toContain('data-command="history:clearAll"');
  });
});

describe("dispatchSidebarMessage - history delete", () => {
  let storageRoot: string;
  let refreshSidebar: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { __resetMessageMocks, __setShowWarningMessageResult } = await import(
      "./__mocks__/vscode.js"
    );
    __resetMessageMocks();
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-history-del-"));
    const sidebar = await import("../src/sidebar/index.js");
    refreshSidebar = vi.spyOn(sidebar, "refreshSidebar").mockImplementation(() => {});
  });

  afterEach(() => {
    refreshSidebar.mockRestore();
  });

  it("removes one entry after modal confirmation", async () => {
    const { __setShowWarningMessageResult } = await import("./__mocks__/vscode.js");
    __setShowWarningMessageResult("Delete");

    const keep: SyncHistoryEntry = {
      timestamp: "2026-07-19T12:00:00.000Z",
      direction: "pull",
      trigger: "manual",
      fileCount: 1,
      success: true,
    };
    const remove: SyncHistoryEntry = {
      timestamp: "2026-07-19T11:00:00.000Z",
      direction: "push",
      trigger: "manual",
      fileCount: 1,
      success: true,
    };
    await fs.writeFile(
      path.join(storageRoot, "sync-history.json"),
      JSON.stringify([keep, remove], null, 2),
      "utf-8"
    );

    const ctx = {
      globalStorageUri: { fsPath: storageRoot },
      globalState: { get: () => undefined, update: async () => {} },
      extensionUri: { fsPath: "/fake" },
    } as any;

    await dispatchSidebarMessage(ctx, mockWebview(), {
      command: "history:delete",
      timestamp: remove.timestamp,
    });

    const { loadSyncHistory } = await import("../src/diagnostics.js");
    const history = await loadSyncHistory(ctx);
    expect(history).toHaveLength(1);
    expect(history[0]?.timestamp).toBe(keep.timestamp);
    expect(refreshSidebar).toHaveBeenCalled();
  });

  it("clears all entries after modal confirmation", async () => {
    const { __setShowWarningMessageResult } = await import("./__mocks__/vscode.js");
    __setShowWarningMessageResult("Clear");

    await fs.writeFile(
      path.join(storageRoot, "sync-history.json"),
      JSON.stringify(
        [
          {
            timestamp: "2026-07-19T12:00:00.000Z",
            direction: "pull",
            trigger: "manual",
            fileCount: 1,
            success: true,
          },
        ],
        null,
        2
      ),
      "utf-8"
    );

    const ctx = {
      globalStorageUri: { fsPath: storageRoot },
      globalState: { get: () => undefined, update: async () => {} },
      extensionUri: { fsPath: "/fake" },
    } as any;

    await dispatchSidebarMessage(ctx, mockWebview(), {
      command: "history:clearAll",
    });

    const { loadSyncHistory } = await import("../src/diagnostics.js");
    expect(await loadSyncHistory(ctx)).toEqual([]);
    expect(refreshSidebar).toHaveBeenCalled();
  });

  it("does not remove when confirmation is cancelled", async () => {
    const { __setShowWarningMessageResult } = await import("./__mocks__/vscode.js");
    __setShowWarningMessageResult("Cancel");

    const entry: SyncHistoryEntry = {
      timestamp: "2026-07-19T12:00:00.000Z",
      direction: "pull",
      trigger: "manual",
      fileCount: 1,
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
      command: "history:delete",
      timestamp: entry.timestamp,
    });

    const { loadSyncHistory } = await import("../src/diagnostics.js");
    expect(await loadSyncHistory(ctx)).toHaveLength(1);
    expect(refreshSidebar).not.toHaveBeenCalled();
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
    expect(items).toMatchObject([
      { label: "settings.json", syncKey: "settings.json" },
      { label: "keybindings.json", syncKey: "keybindings.json" },
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
