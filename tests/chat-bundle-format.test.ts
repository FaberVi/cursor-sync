import { beforeEach, describe, expect, it, vi } from "vitest";

const showQuickPickMock = vi.fn();
const resolveComposerConversationTitleMock = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showQuickPick: showQuickPickMock,
  },
}));

vi.mock("../src/composer-title.js", () => ({
  loadComposerNameIndexForChatsWorkspaceKey: vi.fn().mockResolvedValue(new Map()),
  loadGlobalComposerNameIndex: vi.fn().mockResolvedValue(new Map()),
  resolveComposerConversationTitle: resolveComposerConversationTitleMock,
}));
import type { ChatBundle } from "../src/chat-persistence.js";

const singleBundle: ChatBundle = {
  schemaVersion: 1,
  type: "chat-persistence",
  createdAt: "2026-05-21T00:00:00.000Z",
  conversationId: "conv-1",
  title: "One",
  subtitle: "1 file",
  previewText: "One",
  sidebarSnapshot: null,
  storeSnapshot: null,
  transcriptFiles: [],
};

describe("chat-bundle-format", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveComposerConversationTitleMock.mockImplementation(async ({ bundle }) =>
      bundle?.title?.trim() ? bundle.title : "Untitled"
    );
  });

  it("parseChatBundleOrCollection returns single", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify(singleBundle);
    const result = parseChatBundleOrCollection(raw);
    expect(result.kind).toBe("single");
    if (result.kind === "single") {
      expect(result.bundle.conversationId).toBe("conv-1");
    }
  });

  it("parseChatBundleOrCollection returns collection", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({
      schemaVersion: 1,
      type: "chat-bundles-collection",
      createdAt: "2026-05-21T00:00:00.000Z",
      sourceWorkspaceKey: "wk-md5",
      bundles: [singleBundle],
    });
    const result = parseChatBundleOrCollection(raw);
    expect(result.kind).toBe("collection");
    if (result.kind === "collection") {
      expect(result.collection.bundles).toHaveLength(1);
    }
  });

  it("rejects invalid JSON", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    expect(() => parseChatBundleOrCollection("{")).toThrow(/not valid JSON/i);
  });

  it("rejects wrong type", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({ ...singleBundle, type: "other" });
    expect(() => parseChatBundleOrCollection(raw)).toThrow(/chat-persistence|chat-bundles-collection/i);
  });

  it("accepts schemaVersion 2 with diskKvSnapshot", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({
      ...singleBundle,
      schemaVersion: 2,
      diskKvSnapshot: {
        sourceStateDbPath: "/tmp/state.vscdb",
        rows: [
          { key: "composerData:conv-1", value: "{}", checksum: "a".repeat(64) },
        ],
        rowCount: 1,
        toolBubbleCount: 0,
      },
    });
    const result = parseChatBundleOrCollection(raw);
    expect(result.kind).toBe("single");
    if (result.kind === "single") {
      expect(result.bundle.schemaVersion).toBe(2);
      expect(result.bundle.diskKvSnapshot?.rowCount).toBe(1);
      expect(result.bundle.diskKvSnapshot?.toolBubbleCount).toBe(0);
    }
  });

  it("accepts schemaVersion 2 without diskKvSnapshot", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({ ...singleBundle, schemaVersion: 2 });
    const result = parseChatBundleOrCollection(raw);
    expect(result.kind).toBe("single");
    if (result.kind === "single") {
      expect(result.bundle.schemaVersion).toBe(2);
      expect(result.bundle.diskKvSnapshot).toBeUndefined();
    }
  });

  it("rejects unsupported schemaVersion", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({ ...singleBundle, schemaVersion: 3 });
    expect(() => parseChatBundleOrCollection(raw)).toThrow(/unsupported schema version/i);
  });

  it("rejects diskKvSnapshot keys outside conversation scope", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({
      ...singleBundle,
      schemaVersion: 2,
      diskKvSnapshot: {
        sourceStateDbPath: "/tmp/state.vscdb",
        rows: [
          { key: "composerData:other-conv", value: "{}", checksum: "a".repeat(64) },
        ],
        rowCount: 1,
        toolBubbleCount: 0,
      },
    });
    expect(() => parseChatBundleOrCollection(raw)).toThrow(/not scoped to conversationId/i);
  });

  it("rejects invalid diskKvSnapshot rows", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({
      ...singleBundle,
      schemaVersion: 2,
      diskKvSnapshot: {
        sourceStateDbPath: "/tmp/state.vscdb",
        rows: [{ key: "composerData:conv-1", value: 42, checksum: "x" }],
        rowCount: 1,
        toolBubbleCount: 0,
      },
    });
    expect(() => parseChatBundleOrCollection(raw)).toThrow(/value must be a string/i);
  });

  it("rejects empty collection bundles", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({
      schemaVersion: 1,
      type: "chat-bundles-collection",
      createdAt: "2026-05-21T00:00:00.000Z",
      sourceWorkspaceKey: "wk",
      bundles: [],
    });
    expect(() => parseChatBundleOrCollection(raw)).toThrow(/empty/i);
  });

  it("selectGistExportFile uses chat-bundle.json for one bundle", async () => {
    const { selectGistExportFile } = await import("../src/chat-bundle-format.js");
    const { fileName } = selectGistExportFile(1, singleBundle);
    expect(fileName).toBe("chat-bundle.json");
  });

  it("resolveBundlesFromParsedExport returns single bundle without picker", async () => {
    const { resolveBundlesFromParsedExport, parseChatBundleOrCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const parsed = parseChatBundleOrCollection(JSON.stringify(singleBundle));
    const bundles = await resolveBundlesFromParsedExport(parsed);
    expect(bundles).toEqual([singleBundle]);
    expect(showQuickPickMock).not.toHaveBeenCalled();
  });

  it("resolveBundlesFromParsedExport skips picker for one-bundle collection", async () => {
    const { resolveBundlesFromParsedExport, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [singleBundle]);
    const bundles = await resolveBundlesFromParsedExport({ kind: "collection", collection });
    expect(bundles).toEqual([singleBundle]);
    expect(showQuickPickMock).not.toHaveBeenCalled();
  });

  it("pickBundleFromCollection returns multiple bundles in pick order", async () => {
    const b1 = { ...singleBundle, conversationId: "conv-1", title: "One" };
    const b2 = { ...singleBundle, conversationId: "conv-2", title: "Two" };
    const b3 = { ...singleBundle, conversationId: "conv-3", title: "Three" };
    showQuickPickMock.mockResolvedValueOnce([
      { description: "conv-2" },
      { description: "conv-1" },
    ]);
    const { pickBundleFromCollection, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [b1, b2, b3]);
    const picked = await pickBundleFromCollection(collection);
    expect(picked?.map((b) => b.conversationId)).toEqual(["conv-2", "conv-1"]);
    expect(showQuickPickMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ canPickMany: true })
    );
  });

  it("pickBundleFromCollection returns null when user dismisses", async () => {
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { pickBundleFromCollection, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [
      singleBundle,
      { ...singleBundle, conversationId: "conv-2" },
    ]);
    await expect(pickBundleFromCollection(collection)).resolves.toBeNull();
  });

  it("pickBundleFromCollection returns null for empty selection", async () => {
    showQuickPickMock.mockResolvedValueOnce([]);
    const { pickBundleFromCollection, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [
      singleBundle,
      { ...singleBundle, conversationId: "conv-2" },
    ]);
    await expect(pickBundleFromCollection(collection)).resolves.toBeNull();
  });

  it("pickBundleFromCollection returns chosen bundle", async () => {
    showQuickPickMock.mockResolvedValueOnce([{ description: "conv-2" }]);
    const { pickBundleFromCollection, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [
      { ...singleBundle, conversationId: "conv-1", title: "One" },
      { ...singleBundle, conversationId: "conv-2", title: "Two" },
    ]);
    const picked = await pickBundleFromCollection(collection);
    expect(picked?.map((b) => b.conversationId)).toEqual(["conv-2"]);
  });

  it("pickBundleFromCollection uses composer snapshot title for label", async () => {
    resolveComposerConversationTitleMock
      .mockResolvedValueOnce("Composer Title One")
      .mockResolvedValueOnce("Composer Title Two");
    showQuickPickMock.mockResolvedValueOnce([{ description: "conv-1" }]);
    const { pickBundleFromCollection, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk-md5", [
      { ...singleBundle, conversationId: "conv-1", title: "Fallback One" },
      { ...singleBundle, conversationId: "conv-2", title: "Fallback Two" },
    ]);
    await pickBundleFromCollection(collection);
    expect(resolveComposerConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-1",
      chatsWorkspaceKey: "wk-md5",
      bundle: expect.objectContaining({ conversationId: "conv-1" }),
      workspaceIndex: expect.any(Map),
      globalIndex: expect.any(Map),
    });
    expect(resolveComposerConversationTitleMock).toHaveBeenCalledWith({
      conversationId: "conv-2",
      chatsWorkspaceKey: "wk-md5",
      bundle: expect.objectContaining({ conversationId: "conv-2" }),
      workspaceIndex: expect.any(Map),
      globalIndex: expect.any(Map),
    });
    expect(showQuickPickMock).toHaveBeenCalledWith(
      [
        { label: "Composer Title One", description: "conv-1", detail: "1 file", picked: true },
        { label: "Composer Title Two", description: "conv-2", detail: "1 file", picked: true },
      ],
      expect.objectContaining({
        canPickMany: true,
        title: "Select conversations to import (2 found)",
      })
    );
  });

  it("selectGistExportFile uses chat-bundles.json for multiple", async () => {
    const { selectGistExportFile, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [
      singleBundle,
      { ...singleBundle, conversationId: "conv-2", title: "Two" },
    ]);
    const { fileName, content } = selectGistExportFile(2, collection);
    expect(fileName).toBe("chat-bundles.json");
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe("chat-bundles-collection");
  });
});
