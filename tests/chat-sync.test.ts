import { describe, expect, it, vi } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
    }),
  },
}));

import {
  mergeChatCollections,
  selectChatsForPull,
  selectChatsToPull,
  computeChatCollectionChecksum,
  collectionJsonFromBundles,
} from "../src/chat-sync.js";

function stubBundle(conversationId: string, createdAt: string, title = "Chat"): ChatBundle {
  return {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt,
    conversationId,
    title,
    subtitle: "",
    previewText: title,
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [
      {
        relativePath: "proj/agent-transcripts/x/a.jsonl",
        content: "e30=",
        encoding: "base64",
        checksum: "abc",
        sizeBytes: 3,
      },
    ],
  };
}

describe("chat-sync", () => {
  it("mergeChatCollections unions by conversationId with newer-wins", () => {
    const remote = [stubBundle("aaa", "2026-01-01T00:00:00.000Z", "Remote")];
    const local = [stubBundle("aaa", "2026-02-01T00:00:00.000Z", "Local newer")];
    const merged = mergeChatCollections(remote, local);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("Local newer");
  });

  it("mergeChatCollections keeps remote-only and local-only chats", () => {
    const remote = [stubBundle("remote-only", "2026-01-01T00:00:00.000Z")];
    const local = [stubBundle("local-only", "2026-01-02T00:00:00.000Z")];
    const merged = mergeChatCollections(remote, local);
    expect(merged.map((b) => b.conversationId).sort()).toEqual([
      "local-only",
      "remote-only",
    ]);
  });

  it("selectChatsToPull skips conversation ids already local", () => {
    const remote = [
      stubBundle("11111111-2222-4333-8444-555555555555", "2026-01-01T00:00:00.000Z"),
      stubBundle("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", "2026-01-01T00:00:00.000Z"),
    ];
    const localIds = new Set(["11111111-2222-4333-8444-555555555555"]);
    const toPull = selectChatsToPull(remote, localIds);
    expect(toPull).toHaveLength(1);
    expect(toPull[0]!.conversationId).toBe("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");
  });

  it("selectChatsForPull remoteWins re-imports local ids", () => {
    const remote = [
      stubBundle("11111111-2222-4333-8444-555555555555", "2026-02-01T00:00:00.000Z"),
    ];
    const localIds = new Set(["11111111-2222-4333-8444-555555555555"]);
    const selection = selectChatsForPull(remote, localIds, {
      pullUpdates: true,
      policy: "remoteWins",
    });
    expect(selection.toImport).toHaveLength(1);
    expect(selection.updated).toBe(1);
  });

  it("selectChatsForPull newerWins skips older remote bundle", () => {
    const remote = [
      stubBundle("11111111-2222-4333-8444-555555555555", "2026-01-01T00:00:00.000Z"),
    ];
    const localIds = new Set(["11111111-2222-4333-8444-555555555555"]);
    const selection = selectChatsForPull(remote, localIds, {
      pullUpdates: true,
      policy: "newerWins",
      localImportTimestamps: new Map([
        ["11111111-2222-4333-8444-555555555555", Date.parse("2026-02-01T00:00:00.000Z")],
      ]),
    });
    expect(selection.toImport).toHaveLength(0);
    expect(selection.skipped).toBe(1);
  });

  it("collectionJsonFromBundles and checksum are stable", () => {
    const bundles = [
      stubBundle("11111111-2222-4333-8444-555555555555", "2026-01-01T00:00:00.000Z"),
    ];
    const json = collectionJsonFromBundles(bundles);
    const checksum1 = computeChatCollectionChecksum(json);
    const checksum2 = computeChatCollectionChecksum(json);
    expect(checksum1).toBe(checksum2);
    expect(json).toContain("cursor-chat-collection");
  });
});
