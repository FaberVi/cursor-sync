import { beforeEach, describe, expect, it, vi } from "vitest";

const showQuickPickMock = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showQuickPick: showQuickPickMock,
  },
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

  it("pickBundleFromCollection returns chosen bundle", async () => {
    showQuickPickMock.mockResolvedValueOnce({ description: "conv-2" });
    const { pickBundleFromCollection, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [
      { ...singleBundle, conversationId: "conv-1", title: "One" },
      { ...singleBundle, conversationId: "conv-2", title: "Two" },
    ]);
    const picked = await pickBundleFromCollection(collection);
    expect(picked?.conversationId).toBe("conv-2");
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
