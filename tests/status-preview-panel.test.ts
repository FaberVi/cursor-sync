import { afterEach, describe, expect, it, vi } from "vitest";

const listStatusPreviewEntries = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/status-preview.js", () => ({
  listStatusPreviewEntries,
  STATUS_PREVIEW_KINDS: ["local", "incoming", "localOnly", "diverged"],
  isStatusPreviewKind: (value: string | undefined) =>
    ["local", "incoming", "localOnly", "diverged"].includes(value ?? ""),
}));

import * as vscode from "vscode";
import {
  __resetStatusPreviewPanelForTests,
  openStatusPreviewPanel,
  renderStatusPreviewHtml,
} from "../src/status-preview-panel.js";

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
  });
});

describe("openStatusPreviewPanel", () => {
  afterEach(() => {
    __resetStatusPreviewPanelForTests();
    vi.restoreAllMocks();
    listStatusPreviewEntries.mockReset();
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
});
