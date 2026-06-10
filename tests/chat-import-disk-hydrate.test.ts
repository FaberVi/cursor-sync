import { describe, expect, it, vi } from "vitest";

const querySqliteRowsMock = vi.hoisted(() => vi.fn());

vi.mock("../src/transcripts.js", () => ({
  __chatPersistenceInternals: {
    querySqliteRows: (...args: unknown[]) => querySqliteRowsMock(...args),
    runSqliteScript: vi.fn(),
    listGlobalStateVscdbPaths: vi.fn(),
    resolveStateDbCandidates: vi.fn(),
  },
}));

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { readRichComposerDataEntryFromStateDb } from "../src/chat-import-merge.js";

describe("readRichComposerDataEntryFromStateDb", () => {
  it("decodes hex-encoded cursorDiskKV BLOB values", async () => {
    const conversationId = "43aae2fb-71fc-4e9c-9add-3e995caaaa80";
    const entry = {
      composerId: conversationId,
      conversationMap: { bubble1: { type: 1 } },
      fullConversationHeadersOnly: [{ bubbleId: "bubble1", type: 1 }],
    };
    const hex = Buffer.from(JSON.stringify(entry), "utf-8").toString("hex");

    querySqliteRowsMock.mockImplementation(async (_dbPath: string, sql: string) => {
      if (sql.includes("cursorDiskKV")) {
        return [{ value: hex }];
      }
      return [];
    });

    const rich = await readRichComposerDataEntryFromStateDb("/tmp/state.vscdb", conversationId);
    expect(rich).toEqual(entry);
  });
});
