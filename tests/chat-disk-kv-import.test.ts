import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";

vi.mock("../src/transcripts-sqlite.js", () => ({
  runSqliteScript: vi.fn(async () => {}),
}));

import { runSqliteScript } from "../src/transcripts-sqlite.js";
import { repairDiskKvAfterActivation } from "../src/chat-disk-kv-import.js";

const mockedRunSqliteScript = vi.mocked(runSqliteScript);

function bundleWithDiskKv(conversationId: string): ChatBundle {
  return {
    schemaVersion: 2,
    type: "chat-persistence",
    createdAt: "2026-01-01T00:00:00Z",
    conversationId,
    title: "t",
    subtitle: "s",
    previewText: "p",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [],
    diskKvSnapshot: {
      sourceStateDbPath: "/tmp/state.vscdb",
      rows: [
        {
          key: `composerData:${conversationId}`,
          value: JSON.stringify({ composerId: conversationId, name: "t" }),
          checksum: "abc",
        },
        {
          key: `bubbleId:${conversationId}:b1`,
          value: JSON.stringify({ toolFormerData: { name: "grep" } }),
          checksum: "def",
        },
        {
          key: "bubbleId:other-id:b2",
          value: "{}",
          checksum: "ghi",
        },
      ],
      rowCount: 3,
      toolBubbleCount: 1,
    },
  };
}

describe("repairDiskKvAfterActivation", () => {
  beforeEach(() => {
    mockedRunSqliteScript.mockClear();
  });

  it("writes scoped cursorDiskKV rows", async () => {
    const conversationId = "00000000-0000-4000-8000-000000000099";
    const result = await repairDiskKvAfterActivation(
      "/mock/state.vscdb",
      conversationId,
      bundleWithDiskKv(conversationId)
    );
    expect(result).toEqual({ repaired: true, rowCount: 2 });
    expect(mockedRunSqliteScript).toHaveBeenCalledTimes(1);
    const script = String(mockedRunSqliteScript.mock.calls[0]?.[1] ?? "");
    expect(script).toContain(`composerData:${conversationId}`);
    expect(script).toContain(`bubbleId:${conversationId}:b1`);
    expect(script).not.toContain("bubbleId:other-id");
  });

  it("no-op without diskKvSnapshot", async () => {
    const result = await repairDiskKvAfterActivation("/mock/state.vscdb", "id", {
      schemaVersion: 1,
      type: "chat-persistence",
      createdAt: "",
      conversationId: "id",
      title: "",
      subtitle: "",
      previewText: "",
      sidebarSnapshot: null,
      storeSnapshot: null,
      transcriptFiles: [],
    });
    expect(result).toEqual({ repaired: false, rowCount: 0 });
    expect(mockedRunSqliteScript).not.toHaveBeenCalled();
  });
});
