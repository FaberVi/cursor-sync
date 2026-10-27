import { describe, expect, it, vi } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";
import type { MutableDiscovered } from "../src/chat-discovery.js";
import type { NativeChatJsonDocument } from "../src/native-chat-json/types.js";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
    }),
  },
}));

import {
  chatIdentityKey,
  formatChatPackSkipLabel,
  isRemoteChatPresentLocally,
  mergeByChatIdentity,
  sortDiscoveredForChatPack,
} from "../src/chat-identity.js";
import { upsertConversation } from "../src/chat-discovery.js";
import {
  computeChatSyncFingerprintFromDiscovery,
  mergeChatCollections,
  selectChatsForPull,
} from "../src/chat-sync.js";
import {
  mergeNativeChatCollections,
  nativeChatTimestamp,
} from "../src/native-chat-json/collection.js";

function stubBundle(
  conversationId: string,
  createdAt: string,
  title = "Chat",
  sourceFolderTilde?: string
): ChatBundle {
  return {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt,
    conversationId,
    title,
    subtitle: "",
    previewText: title,
    ...(sourceFolderTilde ? { sourceFolderTilde } : {}),
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

describe("chat identity", () => {
  it("uses conversationId only when tilde is missing", () => {
    expect(chatIdentityKey(undefined, "aaa")).toBe("aaa");
    expect(chatIdentityKey("  ", "aaa")).toBe("aaa");
  });

  it("composes tilde and conversationId", () => {
    expect(chatIdentityKey("~/proj/a", "aaa")).toBe("~/proj/a\0aaa");
  });

  it("merge keeps two chats with the same id in different projects", () => {
    const remote = [stubBundle("same-id", "2026-01-01T00:00:00.000Z", "A", "~/proj/a")];
    const local = [stubBundle("same-id", "2026-02-01T00:00:00.000Z", "B", "~/proj/b")];
    const merged = mergeChatCollections(remote, local);
    expect(merged).toHaveLength(2);
    expect(merged.map((b) => b.sourceFolderTilde).sort()).toEqual(["~/proj/a", "~/proj/b"]);
  });

  it("merge mixed-legacy same id is one chat and prefers the tilde", () => {
    const remote = [stubBundle("same-id", "2026-03-01T00:00:00.000Z", "Newer no tilde")];
    const local = [stubBundle("same-id", "2026-01-01T00:00:00.000Z", "Older with tilde", "~/proj/a")];
    const merged = mergeByChatIdentity(remote, local, (b) => Date.parse(b.createdAt));
    expect(merged).toHaveLength(1);
    expect(merged[0]!.title).toBe("Newer no tilde");
    expect(merged[0]!.sourceFolderTilde).toBe("~/proj/a");
  });

  it("selectChatsForPull treats same id in another project as not local", () => {
    const remote = [
      stubBundle("11111111-2222-4333-8444-555555555555", "2026-01-01T00:00:00.000Z", "A", "~/proj/a"),
    ];
    const localIdentities = new Set([
      chatIdentityKey("~/proj/b", "11111111-2222-4333-8444-555555555555"),
    ]);
    const selection = selectChatsForPull(remote, localIdentities, {
      pullUpdates: false,
      policy: "skip",
    });
    expect(selection.toImport).toHaveLength(1);
    expect(selection.skipped).toBe(0);
  });

  it("selectChatsForPull skips when the same tilde+id is already local", () => {
    const remote = [
      stubBundle("11111111-2222-4333-8444-555555555555", "2026-01-01T00:00:00.000Z", "A", "~/proj/a"),
    ];
    const localIdentities = new Set([
      chatIdentityKey("~/proj/a", "11111111-2222-4333-8444-555555555555"),
    ]);
    const toImport = selectChatsForPull(remote, localIdentities, {
      pullUpdates: false,
      policy: "skip",
    }).toImport;
    expect(toImport).toHaveLength(0);
  });

  it("legacy remote id matches a local tilde-bearing chat", () => {
    const remote = stubBundle("11111111-2222-4333-8444-555555555555", "2026-01-01T00:00:00.000Z");
    const local = new Set([
      chatIdentityKey("~/proj/a", "11111111-2222-4333-8444-555555555555"),
    ]);
    expect(isRemoteChatPresentLocally(remote, local)).toBe(true);
  });

  it("remote with tilde A is not present when local is id-only or tilde B", () => {
    const id = "11111111-2222-4333-8444-555555555555";
    const remote = stubBundle(id, "2026-01-01T00:00:00.000Z", "A", "~/proj/a");
    expect(isRemoteChatPresentLocally(remote, new Set([id]))).toBe(false);
    expect(
      isRemoteChatPresentLocally(remote, new Set([chatIdentityKey("~/proj/b", id)]))
    ).toBe(false);
    expect(
      isRemoteChatPresentLocally(remote, new Set([chatIdentityKey("~/proj/a", id)]))
    ).toBe(true);
  });
});

describe("discovery dual-workspace upsert", () => {
  const id = "11111111-2222-4333-8444-555555555555";

  it("keeps the same conversationId in two workspace keys", () => {
    const map = new Map<string, MutableDiscovered>();
    upsertConversation(map, id, { workspaceKey: "md5-a", hasStore: true, source: "disk" });
    upsertConversation(map, id, { workspaceKey: "md5-b", hasStore: true, source: "disk" });
    expect(map.size).toBe(2);
    const keys = [...map.values()].map((e) => e.workspaceKey).sort();
    expect(keys).toEqual(["md5-a", "md5-b"]);
  });
});

describe("fingerprint content signal", () => {
  it("changes when store.db mtime/size change with the same discovery counts", () => {
    const base = {
      conversationId: "11111111-2222-4333-8444-555555555555",
      workspaceKey: "wk",
      hasStore: true,
      jsonlCount: 2,
      storeSizeBytes: 100,
      storeMtimeMs: 1,
      transcriptMtimeMs: 0,
    };
    const a = computeChatSyncFingerprintFromDiscovery([base]);
    const b = computeChatSyncFingerprintFromDiscovery([{ ...base, storeMtimeMs: 2 }]);
    const c = computeChatSyncFingerprintFromDiscovery([{ ...base, storeSizeBytes: 101 }]);
    const d = computeChatSyncFingerprintFromDiscovery([{ ...base, transcriptMtimeMs: 9 }]);
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
  });
});

describe("size cap recency", () => {
  it("packs newest store mtime first so the older chat is skipped", () => {
    const ordered = sortDiscoveredForChatPack([
      { conversationId: "old-chat", storeMtimeMs: 10 },
      { conversationId: "new-chat", storeMtimeMs: 99 },
    ]);
    expect(ordered.map((d) => d.conversationId)).toEqual(["new-chat", "old-chat"]);
    const maxBytes = 50;
    let running = 0;
    const kept: string[] = [];
    const skipped: string[] = [];
    const sizes: Record<string, number> = { "new-chat": 40, "old-chat": 40 };
    for (const item of ordered) {
      const size = sizes[item.conversationId]!;
      if (running + size > maxBytes) {
        skipped.push(
          formatChatPackSkipLabel({
            title: item.conversationId === "old-chat" ? "Old title" : "New title",
            sourceFolderTilde: "~/proj/a",
            conversationId: item.conversationId,
          })
        );
        continue;
      }
      running += size;
      kept.push(item.conversationId);
    }
    expect(kept).toEqual(["new-chat"]);
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("Old title");
    expect(skipped[0]).toContain("~/proj/a");
    expect(skipped[0]).toContain("old-chat".slice(0, 8));
  });

  it("names skipped chats with title, tilde path, and short id", () => {
    expect(
      formatChatPackSkipLabel({
        title: "Fix pull routing",
        sourceFolderTilde: "~/Documents/Github/Web/cursor-sync",
        conversationId: "abcdef12-0000-4000-8000-000000000001",
      })
    ).toBe("Fix pull routing · ~/Documents/Github/Web/cursor-sync · abcdef12");
  });

  it("applyChatCollectionSizeCap drops older chats after union exceeds the cap", async () => {
    const { applyChatCollectionSizeCap } = await import("../src/chat-sync-collection.js");
    const small = stubBundle(
      "11111111-2222-4333-8444-555555555555",
      "2026-02-01T00:00:00.000Z",
      "New"
    );
    const old = stubBundle(
      "22222222-2222-4333-8444-555555555555",
      "2026-01-01T00:00:00.000Z",
      "Old"
    );
    old.previewText = "y".repeat(400);
    const cap = JSON.stringify(small).length + 50;
    const { kept, skippedLabels } = applyChatCollectionSizeCap([old, small], cap);
    expect(kept.map((b) => b.title)).toEqual(["New"]);
    expect(skippedLabels.some((s) => s.includes("Old"))).toBe(true);
  });
});

describe("native collection identity", () => {
  it("mergeNativeChatCollections keeps dual-workspace chats", () => {
    const id = "00000000-0000-4000-8000-000000000001";
    const remote: NativeChatJsonDocument = {
      version: 1,
      conversationId: id,
      conversationState: "~",
      blobs: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceFolderTilde: "~/a",
    };
    const local: NativeChatJsonDocument = {
      version: 1,
      conversationId: id,
      conversationState: "~",
      blobs: [],
      createdAt: "2026-02-01T00:00:00.000Z",
      sourceFolderTilde: "~/b",
    };
    const merged = mergeNativeChatCollections([remote], [local]);
    expect(merged).toHaveLength(2);
    expect(nativeChatTimestamp(merged[0]!)).toBeGreaterThanOrEqual(0);
  });
});
