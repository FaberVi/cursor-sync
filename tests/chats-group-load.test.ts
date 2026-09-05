import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const discoveredToExportRowsMock = vi.fn(async (conversations: { conversationId: string }[]) =>
  conversations.map((c) => ({
    conversationId: c.conversationId,
    label: c.conversationId,
    description: c.conversationId,
    detail: "full",
  }))
);

vi.mock("../src/chat-discovery-export.js", () => ({
  discoveredToExportRows: (...args: unknown[]) => discoveredToExportRowsMock(...args),
}));

vi.mock("../src/transcripts-discovery.js", () => ({
  discoverProjects: vi.fn(),
}));

vi.mock("../src/chat-workspace-context.js", () => ({
  buildChatsKeyToFolderMap: vi.fn(async () => new Map()),
}));

vi.mock("../src/transcripts-cursor-paths.js", () => ({
  resolveChatsRoot: () => "/fake/chats",
}));

vi.mock("../src/paths.js", () => ({
  resolveSyncRoots: () => ({ cursorUser: "/fake/user", dotCursor: "/fake/.cursor" }),
}));

import { discoverProjects } from "../src/transcripts-discovery.js";
import {
  clearGroupedDiscoveryCache,
  setGroupedDiscoveryCache,
} from "../src/sidebar/chats-group-cache.js";
import { loadConversationGroupRows } from "../src/sidebar/chats-tab.js";

describe("loadConversationGroupRows", () => {
  beforeEach(() => {
    clearGroupedDiscoveryCache();
    vi.clearAllMocks();
  });

  it("uses cached group without rediscovering all projects", async () => {
    setGroupedDiscoveryCache([
      {
        projectKey: "proj-a",
        label: "Proj A",
        isCurrentWorkspace: true,
        conversations: [
          {
            conversationId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
            workspaceKey: "wk1",
            hasStore: true,
            jsonlCount: 1,
            subagentJsonlCount: 0,
            sources: ["disk"],
          },
        ],
      },
    ]);

    const rows = await loadConversationGroupRows("proj-a");

    expect(rows).toHaveLength(1);
    expect(rows[0]?.conversationId).toBe("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa");
    expect(discoverProjects).not.toHaveBeenCalled();
    expect(discoveredToExportRowsMock).toHaveBeenCalledWith(
      expect.any(Array),
      expect.objectContaining({ projectKey: "proj-a", probeDiskKv: false })
    );
  });
});
