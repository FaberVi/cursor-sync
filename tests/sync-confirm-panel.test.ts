import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as vscode from "vscode";
import {
  __resetSyncConfirmPanelForTests,
  openSyncConfirmPanel,
  renderSyncConfirmHtml,
} from "../src/sync-confirm-panel.js";
import { buildSyncConfirmModel } from "../src/pull-confirm.js";
import {
  beginSyncAbort,
  endSyncAbort,
  requestSyncCancel,
} from "../src/sync-abort.js";
import { disposeSyncProgress } from "../src/sync-progress-events.js";

function extensionContext(): vscode.ExtensionContext {
  return {
    extensionUri: { fsPath: "/ext" },
    globalStorageUri: { fsPath: "/tmp/sync-confirm-panel" },
  } as unknown as vscode.ExtensionContext;
}

function emptyIncoming() {
  return {
    subjects: [] as string[],
    incomingSyncKeys: [] as string[],
    incomingDisplayNames: [] as string[],
  };
}

function stubConfirmPanel() {
  const webview = {
    html: "",
    cspSource: "https://mock",
    asWebviewUri: (uri: { fsPath?: string }) => ({
      toString: () => uri.fsPath ?? "uri",
    }),
    onDidReceiveMessage: () => ({ dispose: () => {} }),
    postMessage: async () => true,
  };
  const panel = {
    webview,
    reveal: vi.fn(),
    dispose: vi.fn(),
    onDidDispose: () => ({ dispose: () => {} }),
  };
  vi.spyOn(vscode.window, "createWebviewPanel").mockReturnValue(
    panel as unknown as vscode.WebviewPanel
  );
  return panel;
}

describe("renderSyncConfirmHtml", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const incoming = {
    subjects: ["cursor-sync: sync from VincenzoMSI"],
    incomingSyncKeys: [
      "cursor-user/extensions.json",
      "dot-cursor/agents/plan-reviewer.md",
      "dot-cursor/agents/post-task-reviewer.md",
      "dot-cursor/agents/precise-image-generator.md",
      "dot-cursor/rules/coding-principles.mdc",
      "dot-cursor/rules/direttive-core.mdc",
      "dot-cursor/rules/post-task-review.mdc",
      "dot-cursor/skills/fhub-adversarial-review-workspace/SKILL.md",
      "dot-cursor/skills/extra-one.md",
      "dot-cursor/skills/extra-two.md",
      "dot-cursor/skills/extra-three.md",
      "dot-cursor/skills/extra-four.md",
    ],
    incomingDisplayNames: ["foo"],
  };

  it("lists every incoming path and never concatenates a wall of text", () => {
    const model = buildSyncConfirmModel({
      mode: "syncNow",
      incoming,
      localOnlyKeys: ["dot-cursor/skills/precise-image-gen/SKILL.md"],
      conflictKeys: ["cursor-user/settings.json"],
      n: 68,
      m: 0,
    });
    const html = renderSyncConfirmHtml({
      model,
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain("Review Sync Now");
    expect(html).toContain("68 to update");
    expect(html).not.toContain("0 to delete");
    expect(html).toContain("1 conflict");
    expect(html).toContain("1 local-only");
    expect(html).toContain("cursor-sync: sync from VincenzoMSI");
    expect(html).toContain("extensions.json");
    expect(html).toContain("extra-four.md");
    expect(html).toContain("precise-image-gen");
    expect(html).toContain("settings.json");
    expect(html).toContain('id="proceed"');
    expect(html).not.toContain('id="proceed" disabled');
    expect(html).not.toContain("and 4 more");
    expect(html).not.toContain("This will update 68");
  });

  it("uses mirror copy for Pull and lists local-only as deleted", () => {
    const html = renderSyncConfirmHtml({
      model: buildSyncConfirmModel({
        mode: "pullMirror",
        incoming: {
          subjects: [],
          incomingSyncKeys: [],
          incomingDisplayNames: [],
        },
        localOnlyKeys: ["dot-cursor/skills/bar/SKILL.md"],
        n: 2,
        m: 1,
        k: 3,
      }),
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain("Review Pull");
    expect(html).toContain("will be deleted");
    expect(html).toContain("bar/SKILL.md");
    expect(html).not.toContain("will be kept");
  });

  it("uses Reset title for resetMirror", () => {
    const html = renderSyncConfirmHtml({
      model: buildSyncConfirmModel({
        mode: "resetMirror",
        incoming: {
          subjects: [],
          incomingSyncKeys: [],
          incomingDisplayNames: [],
        },
        n: 1,
        m: 0,
      }),
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain("Review Reset");
  });

  it("uses chat-import copy for chatsOnly", () => {
    const html = renderSyncConfirmHtml({
      model: buildSyncConfirmModel({
        mode: "chatsOnly",
        incoming: {
          subjects: [],
          incomingSyncKeys: [],
          incomingDisplayNames: [],
        },
        n: 0,
        m: 0,
      }),
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain("Review chat import");
    expect(html).toContain("chat collection");
  });
});

describe("openSyncConfirmPanel abort", () => {
  afterEach(() => {
    __resetSyncConfirmPanelForTests();
    disposeSyncProgress();
    endSyncAbort();
    vi.restoreAllMocks();
  });

  it("resolves false when Stop Sync aborts the in-flight review", async () => {
    stubConfirmPanel();
    beginSyncAbort();
    const opened = openSyncConfirmPanel({
      context: extensionContext(),
      model: buildSyncConfirmModel({
        mode: "syncNow",
        incoming: emptyIncoming(),
        n: 1,
        m: 0,
      }),
    });
    expect(requestSyncCancel()).toBe(true);
    await expect(opened).resolves.toBe(false);
  });

  it("resolves false immediately when the abort signal is already aborted", async () => {
    stubConfirmPanel();
    beginSyncAbort();
    expect(requestSyncCancel()).toBe(true);
    await expect(
      openSyncConfirmPanel({
        context: extensionContext(),
        model: buildSyncConfirmModel({
          mode: "syncNow",
          incoming: emptyIncoming(),
          n: 1,
          m: 0,
        }),
      })
    ).resolves.toBe(false);
  });
});
