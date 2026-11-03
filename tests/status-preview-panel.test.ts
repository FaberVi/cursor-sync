import { afterEach, describe, expect, it, vi } from "vitest";

const listStatusPreviewEntries = vi.hoisted(() => vi.fn());
const openSyncKeyComparison = vi.hoisted(() => vi.fn(async () => {}));
const openSyncKeyFile = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/sync-key-diff.js", () => ({
  openSyncKeyComparison,
}));
vi.mock("../src/sync-key-picker.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync-key-picker.js")>();
  return {
    ...actual,
    openSyncKeyFile,
  };
});
vi.mock("../src/status-preview.js", () => ({
  listStatusPreviewEntries,
  STATUS_PREVIEW_KINDS: ["local", "incoming", "localOnly", "diverged"],
  isStatusPreviewKind: (value: string | undefined) =>
    ["local", "incoming", "localOnly", "diverged"].includes(value ?? ""),
}));

import * as vscode from "vscode";
import * as diagnostics from "../src/diagnostics.js";
import {
  __resetStatusPreviewPanelForTests,
  historyPreviewEntries,
  openHistoryFilesPanel,
  openStatusPreviewPanel,
  renderStatusPreviewHtml,
} from "../src/status-preview-panel.js";
import { syncHistoryFromOperations } from "../src/diagnostics.js";
import type { SyncHistoryEntry } from "../src/types.js";

function context(): vscode.ExtensionContext {
  return {
    extensionUri: { fsPath: "/ext" },
    globalStorageUri: { fsPath: "/tmp/status-preview-panel" },
  } as unknown as vscode.ExtensionContext;
}

function stubPanel() {
  const htmlWrites: string[] = [];
  const reveal = vi.fn();
  let disposed: (() => void) | undefined;
  let messageHandler: ((raw: unknown) => void) | undefined;
  const webview = {
    _html: "",
    cspSource: "https://mock",
    asWebviewUri: (uri: { fsPath?: string }) => ({
      toString: () => uri.fsPath ?? "uri",
    }),
    onDidReceiveMessage: (cb: (raw: unknown) => void) => {
      messageHandler = cb;
      return { dispose: () => {} };
    },
    postMessage: async () => true,
    get html() {
      return this._html;
    },
    set html(value: string) {
      this._html = value;
      htmlWrites.push(value);
    },
  };
  const panel = {
    title: "",
    webview,
    reveal,
    dispose: () => {
      disposed?.();
    },
    onDidDispose: (cb: () => void) => {
      disposed = cb;
      return { dispose: () => {} };
    },
  };
  vi.spyOn(vscode.window, "createWebviewPanel").mockReturnValue(
    panel as unknown as vscode.WebviewPanel
  );
  return { htmlWrites, reveal, panel, getMessageHandler: () => messageHandler };
}

describe("renderStatusPreviewHtml", () => {
  it("renders empty and error copy and list rows", () => {
    const empty = renderStatusPreviewHtml({
      heading: "Local changes",
      body: { kind: "empty" },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(empty).toContain("No files to list for this warning.");
    expect(empty).toContain('data-command="refresh"');
    expect(empty).toContain("Refresh");
    expect(empty).not.toContain(" disabled");

    const error = renderStatusPreviewHtml({
      heading: "Local changes",
      body: { kind: "error", error: "boom" },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(error).toContain("Could not list files: boom");

    const list = renderStatusPreviewHtml({
      heading: "Local changes",
      body: {
        kind: "list",
        entries: [{ syncKey: "cursor-user/settings.json", change: "modified" }],
      },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(list).toContain('data-sync-key="cursor-user/settings.json"');
    expect(list).toContain('class="preview-path">settings.json<');
    expect(list).not.toContain('class="preview-path">cursor-user/settings.json<');
    expect(list).toContain('data-prefix="cursor-user"');
    expect(list).toContain('class="preview-change preview-change-modified"');
    expect(list).toContain('data-command="refresh"');
    expect(list).toContain("1 changed");
    expect(list).toContain("0 local only");
    expect(list).toContain("0 missing locally");
  });

  it("counts mixed local change kinds including deletions", () => {
    const html = renderStatusPreviewHtml({
      heading: "Local changes",
      body: {
        kind: "list",
        entries: [
          { syncKey: "a.json", change: "modified" },
          { syncKey: "b.json", change: "modified" },
          { syncKey: "c.json", change: "added" },
          { syncKey: "d.json", change: "removed" },
        ],
      },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain("2 changed");
    expect(html).toContain("1 local only");
    expect(html).toContain("1 missing locally");
    expect(html).toContain('preview-change-modified');
    expect(html).toContain('preview-change-added');
    expect(html).toContain('preview-change-removed');
  });

  it("shows the recorded action for each history file", () => {
    const recorded = syncHistoryFromOperations({
      created: ["dot-cursor/skills/foo/NEW.md"],
      updated: ["cursor-user/settings.json"],
      deleted: ["dot-cursor/skills/foo/old.txt", "cursor-user/settings.json"],
    });
    expect(recorded.fileCount).toBe(3);
    expect(recorded.operations?.find((row) => row.syncKey === "cursor-user/settings.json")?.action).toBe(
      "updated"
    );
    const entry: SyncHistoryEntry = {
      timestamp: "2026-10-05T12:00:00.000Z",
      direction: "pull",
      trigger: "manual",
      fileCount: recorded.fileCount,
      success: true,
      files: recorded.files,
      operations: recorded.operations,
    };
    const html = renderStatusPreviewHtml({
      heading: "Pull",
      body: { kind: "list", entries: historyPreviewEntries(entry) },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain("Updated");
    expect(html).toContain("Added");
    expect(html).toContain("Deleted");
    expect(html).toContain("1 updated");
    expect(html).toContain("1 added");
    expect(html).toContain("1 deleted");
    expect(html).toContain('preview-change-incoming');
    expect(html).toContain('preview-change-added');
    expect(html).toContain('preview-change-removed');
  });

  it("renders nested sync keys as folders and keeps duplicate keys", () => {
    const nested = renderStatusPreviewHtml({
      heading: "Local changes",
      body: {
        kind: "list",
        entries: [
          { syncKey: "cursor-user/skills/foo/SKILL.md", change: "modified" },
        ],
      },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(nested).toContain('data-prefix="cursor-user"');
    expect(nested).toContain('data-prefix="cursor-user/skills"');
    expect(nested).toContain('data-prefix="cursor-user/skills/foo"');
    expect(nested).toContain('class="preview-path">SKILL.md<');
    expect(nested).not.toContain('class="preview-path">cursor-user/skills/foo/SKILL.md<');
    expect(nested).toContain('data-sync-key="cursor-user/skills/foo/SKILL.md"');
    expect(nested).toContain("preview-change-modified");
    expect(nested).toContain('aria-label="Expand or collapse folder"');

    const duplicated = renderStatusPreviewHtml({
      heading: "Pull",
      body: {
        kind: "list",
        entries: [
          { syncKey: "cursor-user/settings.json", change: "updated" },
          { syncKey: "cursor-user/settings.json", change: "deleted" },
        ],
      },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    const keyMatches = duplicated.match(/data-sync-key="cursor-user\/settings.json"/g) ?? [];
    expect(keyMatches).toHaveLength(2);
    expect(duplicated).toContain("preview-change-incoming");
    expect(duplicated).toContain("preview-change-removed");
  });
});

describe("openStatusPreviewPanel", () => {
  afterEach(() => {
    __resetStatusPreviewPanelForTests();
    vi.restoreAllMocks();
    listStatusPreviewEntries.mockReset();
    openSyncKeyComparison.mockClear();
    openSyncKeyFile.mockClear();
  });

  it("assigns loading HTML before the listing promise resolves", async () => {
    const { htmlWrites } = stubPanel();
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    let resolveList!: (value: unknown) => void;
    listStatusPreviewEntries.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );

    const pending = openStatusPreviewPanel(context(), "local");
    expect(htmlWrites[0]).toContain("Loading…");
    expect(htmlWrites[0]).toContain("preview-spinner");
    expect(htmlWrites[0]).toContain("disabled");
    expect(listStatusPreviewEntries).toHaveBeenCalledTimes(1);
    expect(quickPick).not.toHaveBeenCalled();

    resolveList([{ syncKey: "cursor-user/settings.json", change: "modified" }]);
    await pending;
    expect(htmlWrites.at(-1)).toContain('data-sync-key="cursor-user/settings.json"');
  });

  it("does not list again on a second same-kind click while loading", async () => {
    const { htmlWrites, reveal } = stubPanel();
    let resolveList!: (value: unknown) => void;
    listStatusPreviewEntries.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );

    const pending = openStatusPreviewPanel(context(), "local");
    await openStatusPreviewPanel(context(), "local");
    expect(listStatusPreviewEntries).toHaveBeenCalledTimes(1);
    expect(reveal).toHaveBeenCalled();
    expect(vscode.window.createWebviewPanel).toHaveBeenCalledTimes(1);

    resolveList([]);
    await pending;
    expect(htmlWrites.at(-1)).toContain("No files to list for this warning.");
  });

  it("ignores a stale list after switching kind", async () => {
    const { htmlWrites } = stubPanel();
    let resolveLocal!: (value: unknown) => void;
    let resolveIncoming!: (value: unknown) => void;
    listStatusPreviewEntries
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveLocal = resolve;
          })
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveIncoming = resolve;
          })
      );

    const first = openStatusPreviewPanel(context(), "local");
    const second = openStatusPreviewPanel(context(), "incoming");
    expect(listStatusPreviewEntries).toHaveBeenCalledTimes(2);
    expect(htmlWrites.at(-1)).toContain("Loading…");

    resolveLocal([{ syncKey: "stale.json", change: "modified" }]);
    await first;
    expect(htmlWrites.join("\n")).not.toContain("stale.json");

    resolveIncoming([{ syncKey: "incoming.json", change: "incoming" }]);
    await second;
    expect(htmlWrites.at(-1)).toContain('data-sync-key="incoming.json"');
    expect(htmlWrites.at(-1)).not.toContain("stale.json");
  });

  it("renders thrown listing errors in the panel", async () => {
    const { htmlWrites } = stubPanel();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    listStatusPreviewEntries.mockRejectedValue(new Error("disk full"));
    await openStatusPreviewPanel(context(), "local");
    expect(htmlWrites.at(-1)).toContain("Could not list files: disk full");
    expect(warn).not.toHaveBeenCalled();
  });

  it("reloads the file list when the panel posts refresh", async () => {
    const { htmlWrites, getMessageHandler } = stubPanel();
    listStatusPreviewEntries
      .mockResolvedValueOnce([{ syncKey: "old.json", change: "modified" }])
      .mockResolvedValueOnce([{ syncKey: "new.json", change: "added" }]);

    await openStatusPreviewPanel(context(), "local");
    expect(htmlWrites.at(-1)).toContain('data-sync-key="old.json"');

    const handler = getMessageHandler();
    expect(handler).toBeTypeOf("function");
    await handler!({ type: "refresh" });
    expect(listStatusPreviewEntries).toHaveBeenCalledTimes(2);
    expect(htmlWrites.some((html) => html.includes("Loading…") && html.includes("disabled"))).toBe(
      true
    );
    expect(htmlWrites.at(-1)).toContain('data-sync-key="new.json"');
    expect(htmlWrites.at(-1)).not.toContain("old.json");
  });

  it("ignores refresh while the first listing is still loading", async () => {
    const { getMessageHandler } = stubPanel();
    let resolveList!: (value: unknown) => void;
    listStatusPreviewEntries.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveList = resolve;
        })
    );

    const pending = openStatusPreviewPanel(context(), "local");
    getMessageHandler()?.({ type: "refresh" });
    expect(listStatusPreviewEntries).toHaveBeenCalledTimes(1);
    resolveList([]);
    await pending;
    expect(listStatusPreviewEntries).toHaveBeenCalledTimes(1);
  });

  it("compares local rows and opens history rows as a single file", async () => {
    const { htmlWrites, getMessageHandler } = stubPanel();
    listStatusPreviewEntries.mockResolvedValue([
      { syncKey: "cursor-user/settings.json", change: "modified" },
    ]);
    await openStatusPreviewPanel(context(), "local");
    expect(htmlWrites.at(-1)).toContain("only when both sides exist");
    getMessageHandler()?.({ type: "open", syncKey: "cursor-user/settings.json" });
    expect(openSyncKeyComparison).toHaveBeenCalledWith(
      "cursor-user/settings.json",
      expect.anything(),
      "local"
    );
    expect(openSyncKeyFile).not.toHaveBeenCalled();

    __resetStatusPreviewPanelForTests();
    openSyncKeyComparison.mockClear();
    vi.spyOn(diagnostics, "loadSyncHistory").mockResolvedValue([
      {
        timestamp: "2026-11-02T00:00:00.000Z",
        direction: "pull",
        trigger: "manual",
        fileCount: 1,
        success: true,
        files: ["cursor-user/settings.json"],
      },
    ]);
    await openHistoryFilesPanel(context(), "2026-11-02T00:00:00.000Z");
    getMessageHandler()?.({ type: "open", syncKey: "cursor-user/settings.json" });
    expect(openSyncKeyFile).toHaveBeenCalledWith(
      "cursor-user/settings.json",
      expect.anything()
    );
    expect(openSyncKeyComparison).not.toHaveBeenCalled();
  });

  it("opens local-only rows as a single file", async () => {
    const { getMessageHandler } = stubPanel();
    listStatusPreviewEntries.mockResolvedValue([
      { syncKey: "dot-cursor/skills/foo/SKILL.md", change: "added" },
    ]);
    await openStatusPreviewPanel(context(), "localOnly");
    getMessageHandler()?.({ type: "open", syncKey: "dot-cursor/skills/foo/SKILL.md" });
    expect(openSyncKeyFile).toHaveBeenCalledWith(
      "dot-cursor/skills/foo/SKILL.md",
      expect.anything()
    );
    expect(openSyncKeyComparison).not.toHaveBeenCalled();
  });
});
