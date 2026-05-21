import { beforeEach, describe, expect, it, vi } from "vitest";
import * as path from "node:path";

const showQuickPickMock = vi.fn();
const showErrorMessageMock = vi.fn();

const configurationValues: Record<string, unknown> = {
  "chatImport.activateDefault": false,
  "chatImport.activateStrict": false,
  "chatImport.bridgeWaitResultSeconds": 0,
  "chatImport.pingServer": false,
};

let workspaceFolders: Array<{ uri: { fsPath: string }; name: string; index: number }> = [
  { uri: { fsPath: "/repo/a" }, name: "a", index: 0 },
];

vi.mock("vscode", () => ({
  workspace: {
    get workspaceFolders() {
      return workspaceFolders;
    },
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
    }),
  },
  window: {
    showQuickPick: showQuickPickMock,
    showErrorMessage: showErrorMessageMock,
  },
}));

describe("chat-import-ux", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    workspaceFolders = [
      { uri: { fsPath: "/repo/a" }, name: "a", index: 0 },
      { uri: { fsPath: "/repo/b" }, name: "b", index: 1 },
    ];
    configurationValues["chatImport.activateDefault"] = false;
  });

  it("pickImportWorkspaceFolder auto-selects single root", async () => {
    workspaceFolders = [{ uri: { fsPath: "/only/repo" }, name: "only", index: 0 }];
    const { pickImportWorkspaceFolder } = await import("../src/chat-import-ux.js");
    await expect(pickImportWorkspaceFolder()).resolves.toBe("/only/repo");
    expect(showQuickPickMock).not.toHaveBeenCalled();
  });

  it("pickImportWorkspaceFolder quick-picks multi-root", async () => {
    showQuickPickMock.mockResolvedValueOnce({
      label: "b",
      description: "/repo/b",
    });
    const { pickImportWorkspaceFolder } = await import("../src/chat-import-ux.js");
    await expect(pickImportWorkspaceFolder()).resolves.toBe("/repo/b");
    expect(showQuickPickMock).toHaveBeenCalledTimes(1);
  });

  it("promptChatImportOptions applies activateDefault then user override", async () => {
    workspaceFolders = [{ uri: { fsPath: "/repo/a" }, name: "a", index: 0 }];
    configurationValues["chatImport.activateDefault"] = true;
    showQuickPickMock.mockResolvedValueOnce({
      label: "Disk restore only",
      activate: false,
    });
    const { promptChatImportOptions } = await import("../src/chat-import-ux.js");
    const result = await promptChatImportOptions();
    expect(result?.workspaceFolder).toBe("/repo/a");
    expect(result?.restoreOptions.activate).toBe(false);
    expect(result?.restoreOptions.workspaceFolder).toBe("/repo/a");
  });

  it("promptChatImportOptions forceActivate skips activate prompt", async () => {
    workspaceFolders = [{ uri: { fsPath: "/repo/a" }, name: "a", index: 0 }];
    const { promptChatImportOptions } = await import("../src/chat-import-ux.js");
    const result = await promptChatImportOptions({ forceActivate: true });
    expect(result?.restoreOptions.activate).toBe(true);
    expect(showQuickPickMock).not.toHaveBeenCalled();
  });

  it("formatVerifySummary summarizes check counts", async () => {
    const { formatVerifySummary } = await import("../src/chat-import-ux.js");
    expect(
      formatVerifySummary([
        { name: "a", status: "OK", detail: "" },
        { name: "b", status: "WARN", detail: "x" },
      ])
    ).toContain("2 checks");
    expect(
      formatVerifySummary([
        { name: "a", status: "OK", detail: "" },
        { name: "b", status: "WARN", detail: "x" },
      ])
    ).toContain("1 OK");
  });

  it("buildChatImportResultMessage includes verify summary", async () => {
    const { buildChatImportResultMessage } = await import("../src/chat-import-ux.js");
    const msg = buildChatImportResultMessage(
      {
        conversationId: "c1",
        transcriptsWritten: 1,
        storeWritten: true,
        sidebarMerged: true,
        warnings: [],
        verifyChecks: [{ name: "store.db", status: "OK", detail: "" }],
      },
      { activate: true }
    );
    expect(msg).toContain('Chat "c1" loaded.');
    expect(msg).toContain("verify");
    expect(msg).toContain("activation requested");
  });
});
