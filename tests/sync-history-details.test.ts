import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as vscode from "vscode";
import { dispatchSidebarMessage } from "../src/sidebar/messages.js";
import { __resetStatusPreviewPanelForTests } from "../src/status-preview-panel.js";
import {
  formatHistoryError,
  HISTORY_PAGE_SIZE,
  renderHistoryEntry,
  renderHistorySection,
  renderSyncPane,
  sliceHistoryPage,
} from "../src/sidebar/sync-tab.js";
import { t } from "../src/sidebar/i18n.js";
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
    expect(html).toContain("history-delete-icon");
    expect(html).toContain("<svg");
    expect(html).toContain("Show files involved in this sync");
    expect(html).toContain("2 files");
  });

  it("localizes known failure codes in the history detail line", () => {
    const entry: SyncHistoryEntry = {
      timestamp: "2026-07-19T10:00:00.000Z",
      direction: "pull",
      trigger: "manual",
      fileCount: 0,
      success: false,
      error: "cancelled",
      files: [],
    };
    const html = renderHistoryEntry(entry);
    expect(html).toContain(formatHistoryError("cancelled"));
    expect(html).not.toContain(">cancelled<");
    expect(formatHistoryError("canceled")).toBe(t("historyErrorCancelled", undefined, "en"));
    expect(formatHistoryError("pull required")).toBe(t("historyErrorPullRequired", undefined, "en"));
    expect(t("historyErrorCancelled", undefined, "it")).toBe("Annullato");
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

function minimalSyncState(): SyncTabState {
  return {
    status: "synced",
    lastSyncTime: undefined,
    lastSyncDirection: undefined,
    fileCount: 0,
    remoteLabel: undefined,
    remoteUrl: undefined,
    destinationKind: undefined,
    extensionVersion: "0.12.1",
    history: [],
    chatsSyncEnabled: false,
    localChatCount: 0,
    remoteChatCount: undefined,
  };
}

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
    };
    const html = renderSyncPane(state, 0);
    expect(html).toContain('status-card loading');
    expect(html).toContain("Loading");
    expect(html).not.toContain("Never");
    expect(html).not.toContain("Not linked");
    expect(html).not.toContain("No sync history yet");
  });
});

describe("renderSyncPane actions", () => {
  it("keeps folder shortcuts out of the action grid", () => {
    const html = renderSyncPane(minimalSyncState(), 0);
    const actions = html.slice(
      html.indexOf('class="action-grid"'),
      html.indexOf('class="shortcut-row"')
    );
    expect(actions).toContain('data-command="push"');
    expect(actions).toContain('data-command="pull"');
    expect(actions).toContain('data-command="resetToRemote"');
    expect(actions).not.toContain("openSyncClone");
    expect(actions).not.toContain("openCursorFolder");
    expect(html).toContain('class="shortcut-btn"');
    expect(html).toContain("Folders");
  });
});

describe("renderSyncPane remote ahead", () => {
  it("shows a behind warning inside the status card and a single Sync Now", () => {
    const state: SyncTabState = {
      ...minimalSyncState(),
      status: "behind",
      behindCount: 2,
    };
    const html = renderSyncPane(state, 0);
    expect(html).toContain('data-remote-ahead="behind"');
    expect(html).toContain('data-preview-kind="incoming"');
    expect(html).toContain('data-preview-kind="localOnly"');
    expect(html).toContain("status-warning-link");
    expect(html).toContain("updates");
    expect(html).not.toContain("remote-ahead-banner");
    expect(html.match(/data-command="syncNow"/g)?.length).toBe(1);
    expect(html).toContain("Sync Now");
  });

  it("shows a diverged warning inside the status card without a second reset", () => {
    const html = renderSyncPane({ ...minimalSyncState(), status: "diverged" }, 0);
    expect(html).toContain('data-remote-ahead="diverged"');
    expect(html).toContain('data-preview-kind="diverged"');
    expect(html).toContain("status-warning-link");
    expect(html).not.toContain("remote-ahead-banner");
    expect(html.match(/data-command="resetToRemote"/g)?.length).toBe(1);
  });

  it("shows local unsynced copy inside the status card", () => {
    const html = renderSyncPane({ ...minimalSyncState(), status: "not-synced" }, 0);
    expect(html).toContain("status-card not-synced");
    expect(html).toContain('data-preview-kind="local"');
    expect(html).toContain("local changes");
    expect(html).toContain("status-warning-link");
    expect(html).toContain("not yet in the repository.");
    expect(html).toContain("status-warning");
    expect(html).not.toContain("remote-ahead-banner");
    expect(html.match(/data-command="syncNow"/g)?.length).toBe(1);
  });
});

describe("renderSyncPane history header", () => {
  it("shows clear-all control when history has entries", () => {
    const state = minimalSyncState();
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
    const html = renderSyncPane(minimalSyncState(), 0);
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

    const webview = mockWebview();
    await dispatchSidebarMessage(ctx, webview, {
      command: "history:delete",
      timestamp: remove.timestamp,
    });

    const { loadSyncHistory } = await import("../src/diagnostics.js");
    const history = await loadSyncHistory(ctx);
    expect(history).toHaveLength(1);
    expect(history[0]?.timestamp).toBe(keep.timestamp);
    expect(refreshSidebar).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "history:update", empty: false })
    );
    const html = webview.postMessage.mock.calls[0][0].html as string;
    expect(html).toContain(keep.timestamp);
    expect(html).not.toContain(remove.timestamp);
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

    const webview = mockWebview();
    await dispatchSidebarMessage(ctx, webview, {
      command: "history:clearAll",
    });

    const { loadSyncHistory } = await import("../src/diagnostics.js");
    expect(await loadSyncHistory(ctx)).toEqual([]);
    expect(refreshSidebar).not.toHaveBeenCalled();
    expect(webview.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "history:update", empty: true })
    );
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
  let showWarningMessage: ReturnType<typeof vi.spyOn>;
  let panels: Array<{ title: string; webview: { html: string } }>;

  beforeEach(async () => {
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-history-"));
    __resetStatusPreviewPanelForTests();
    panels = [];
    showQuickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    showInformationMessage = vi
      .spyOn(vscode.window, "showInformationMessage")
      .mockResolvedValue(undefined);
    showWarningMessage = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "createWebviewPanel").mockImplementation((...args) => {
      const panel = {
        title: String(args[1] ?? ""),
        webview: {
          html: "",
          cspSource: "https://mock",
          asWebviewUri: (uri: { fsPath?: string }) => ({
            toString: () => uri.fsPath ?? "",
          }),
          onDidReceiveMessage: () => ({ dispose: () => {} }),
          postMessage: async () => true,
        },
        reveal: () => {},
        dispose: () => {},
        onDidDispose: () => ({ dispose: () => {} }),
      };
      panels.push(panel);
      return panel as unknown as vscode.WebviewPanel;
    });
  });

  afterEach(() => {
    __resetStatusPreviewPanelForTests();
    showQuickPick.mockRestore();
    showInformationMessage.mockRestore();
    showWarningMessage.mockRestore();
    vi.restoreAllMocks();
  });

  function historyContext() {
    return {
      globalStorageUri: { fsPath: storageRoot },
      globalState: { get: () => undefined, update: async () => {} },
      extensionUri: { fsPath: "/fake" },
    } as import("vscode").ExtensionContext;
  }

  it("opens the file-list panel for a matching history entry", async () => {
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

    await dispatchSidebarMessage(historyContext(), mockWebview(), {
      command: "history:details",
      timestamp: entry.timestamp,
    });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(panels).toHaveLength(1);
    expect(panels[0]?.title).toBe("Pull · 2 files");
    expect(panels[0]?.webview.html).toContain('data-sync-key="settings.json"');
    expect(panels[0]?.webview.html).toContain('data-sync-key="keybindings.json"');
    expect(panels[0]?.webview.html).toContain(">Pull · 2 files<");
  });

  it("shows an empty file list in the panel when none was recorded", async () => {
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

    await dispatchSidebarMessage(historyContext(), mockWebview(), {
      command: "history:details",
      timestamp: entry.timestamp,
    });

    expect(showQuickPick).not.toHaveBeenCalled();
    expect(showInformationMessage).not.toHaveBeenCalled();
    expect(panels[0]?.webview.html).toContain("File list was not recorded");
    expect(panels[0]?.title).toBe("Push · 0 files");
  });

  it("warns when the history entry is missing", async () => {
    await dispatchSidebarMessage(historyContext(), mockWebview(), {
      command: "history:details",
      timestamp: "missing",
    });

    expect(panels).toHaveLength(0);
    expect(showWarningMessage).toHaveBeenCalledWith("History entry not found.");
  });
});

describe("dispatchSidebarMessage - status:preview", () => {
  it("ignores unknown preview kinds", async () => {
    const showQuickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    await dispatchSidebarMessage(
      { globalStorageUri: { fsPath: "/tmp" } } as any,
      mockWebview(),
      { command: "status:preview", previewKind: "nope" }
    );
    expect(showQuickPick).not.toHaveBeenCalled();
    showQuickPick.mockRestore();
  });
});
