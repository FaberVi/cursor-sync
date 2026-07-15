import { describe, expect, it } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";
import {
  aggregateChatSyncFidelity,
  classifyBundleTier,
  classifyDiscoveredTier,
  isBundleSyncEligible,
  tierMeetsMinimum,
} from "../src/chat-backup-eligibility.js";

function stubBundle(partial: Partial<ChatBundle> = {}): ChatBundle {
  return {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt: "2026-01-01T00:00:00.000Z",
    conversationId: "11111111-2222-4333-8444-555555555555",
    title: "Test",
    subtitle: "",
    previewText: "Test",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [],
    ...partial,
  };
}

describe("chat-backup-eligibility", () => {
  it("classifyDiscoveredTier marks archive for jsonl-only", () => {
    expect(
      classifyDiscoveredTier({ hasStore: false, jsonlCount: 2 }, null)
    ).toBe("archive");
  });

  it("classifyDiscoveredTier marks full when store and tool bubbles exist", () => {
    expect(
      classifyDiscoveredTier(
        { hasStore: true, jsonlCount: 1 },
        { rowCount: 10, toolBubbleCount: 3 }
      )
    ).toBe("full");
  });

  it("classifyBundleTier marks full for store + diskKv + tools", () => {
    const tier = classifyBundleTier(
      stubBundle({
        schemaVersion: 2,
        storeSnapshot: {
          content: "e30=",
          encoding: "base64",
          checksum: "abc",
          sizeBytes: 3,
          sourceWorkspaceKey: "wk",
        },
        diskKvSnapshot: {
          sourceStateDbPath: "/tmp/state.vscdb",
          rows: [{ key: "composerData:x", value: "{}", checksum: "a" }],
          rowCount: 1,
          toolBubbleCount: 2,
        },
      })
    );
    expect(tier).toBe("full");
  });

  it("isBundleSyncEligible respects syncOnlyFullBackups", () => {
    const archive = stubBundle({
      transcriptFiles: [
        {
          relativePath: "p/a.jsonl",
          content: "e30=",
          checksum: "a",
          sizeBytes: 3,
        },
      ],
    });
    expect(isBundleSyncEligible(archive, false)).toBe(true);
    expect(isBundleSyncEligible(archive, true)).toBe(false);
  });

  it("shouldWarnBeforeOpeningChat flags archive and partial only", async () => {
    const {
      shouldWarnBeforeOpeningChat,
      openChatTierWarningMessage,
    } = await import("../src/chat-backup-eligibility.js");
    expect(shouldWarnBeforeOpeningChat("archive")).toBe(true);
    expect(shouldWarnBeforeOpeningChat("partial")).toBe(true);
    expect(shouldWarnBeforeOpeningChat("resume")).toBe(false);
    expect(shouldWarnBeforeOpeningChat("full")).toBe(false);
    expect(openChatTierWarningMessage("archive")).toContain("transcript-only");
  });

  it("aggregateChatSyncFidelity counts tiers", () => {
    const report = aggregateChatSyncFidelity([
      stubBundle({
        transcriptFiles: [
          {
            relativePath: "p/a.jsonl",
            content: "e30=",
            checksum: "a",
            sizeBytes: 3,
          },
        ],
      }),
      stubBundle({
        storeSnapshot: {
          content: "e30=",
          encoding: "base64",
          checksum: "abc",
          sizeBytes: 3,
          sourceWorkspaceKey: "wk",
        },
      }),
    ]);
    expect(report.total).toBe(2);
    expect(report.byTier.archive).toBe(1);
    expect(tierMeetsMinimum("resume", "archive")).toBe(true);
    expect(tierMeetsMinimum("archive", "resume")).toBe(false);
  });
});
