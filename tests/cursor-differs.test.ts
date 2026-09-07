import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  __resetLocalDiffersForTests,
  computeCursorDiffers,
  getLocalDiffersCache,
  listHashDiffs,
  recordLocalDiffers,
  resolveSyncCardStatus,
} from "../src/cursor-differs.js";
import * as chat from "../src/chat-sync.js";
import * as diagnostics from "../src/diagnostics.js";
import * as copy from "../src/sync-copy.js";
import { computeChecksum } from "../src/packaging.js";

function context(): import("vscode").ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-differs-test" },
    globalState: {
      get: vi.fn(),
      update: vi.fn(),
      keys: vi.fn().mockReturnValue([]),
    },
    secrets: {
      get: async () => "tok",
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

describe("resolveSyncCardStatus", () => {
  it("preserves loading, syncing, and error", () => {
    for (const status of ["loading", "syncing", "error"] as const) {
      expect(
        resolveSyncCardStatus({
          status,
          relation: "behind",
          hasSyncState: true,
          cursorDiffers: false,
        })
      ).toBe(status);
    }
  });

  it("prefers diverged then behind over local drift", () => {
    expect(
      resolveSyncCardStatus({
        status: "not-synced",
        relation: "diverged",
        hasSyncState: true,
        cursorDiffers: true,
      })
    ).toBe("diverged");
    expect(
      resolveSyncCardStatus({
        status: "not-synced",
        relation: "behind",
        hasSyncState: true,
        cursorDiffers: true,
      })
    ).toBe("behind");
  });

  it("is not-synced when there is no sync state, local drift, ahead, empty, or unknown cache", () => {
    const base = {
      status: "not-synced" as const,
      relation: "equal" as const,
      hasSyncState: true,
      cursorDiffers: false as boolean | undefined,
    };
    expect(resolveSyncCardStatus({ ...base, hasSyncState: false })).toBe("not-synced");
    expect(resolveSyncCardStatus({ ...base, cursorDiffers: true })).toBe("not-synced");
    expect(resolveSyncCardStatus({ ...base, cursorDiffers: undefined })).toBe(
      "not-synced"
    );
    expect(resolveSyncCardStatus({ ...base, relation: "ahead" })).toBe("not-synced");
    expect(resolveSyncCardStatus({ ...base, relation: "empty" })).toBe("not-synced");
  });

  it("is synced only when equal, hashes match, and sync state exists", () => {
    expect(
      resolveSyncCardStatus({
        status: "not-synced",
        relation: "equal",
        hasSyncState: true,
        cursorDiffers: false,
      })
    ).toBe("synced");
  });
});

describe("listHashDiffs", () => {
  it("classifies added, modified, and removed keys", () => {
    expect(
      listHashDiffs(
        { "cursor-user/a.json": "1", "cursor-user/b.json": "2" },
        { "cursor-user/b.json": "3", "cursor-user/c.json": "4" }
      )
    ).toEqual([
      { syncKey: "cursor-user/a.json", change: "added" },
      { syncKey: "cursor-user/b.json", change: "modified" },
      { syncKey: "cursor-user/c.json", change: "removed" },
    ]);
  });

  it("is empty when hashes match", () => {
    const hashes = { "cursor-user/settings.json": "aaa" };
    expect(listHashDiffs(hashes, hashes)).toEqual([]);
  });
});

describe("local differs cache", () => {
  afterEach(() => {
    __resetLocalDiffersForTests();
  });

  it("starts undefined and records booleans", () => {
    expect(getLocalDiffersCache()).toBeUndefined();
    recordLocalDiffers(true);
    expect(getLocalDiffersCache()).toBe(true);
    recordLocalDiffers(false);
    expect(getLocalDiffersCache()).toBe(false);
  });
});

describe("computeCursorDiffers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    __resetLocalDiffersForTests();
  });

  it("is false when Cursor hashes match the clone and chat sync is off", async () => {
    const hashes = { "cursor-user/settings.json": "aaa" };
    vi.spyOn(copy, "hashCursorSyncFiles").mockResolvedValue(hashes);
    vi.spyOn(copy, "hashCloneSyncFiles").mockResolvedValue(hashes);
    vi.spyOn(chat, "isChatSyncEnabled").mockReturnValue(false);
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);
    expect(await computeCursorDiffers(context(), "/tmp/clone", "cursor-sync")).toBe(
      false
    );
  });

  it("is true when a local file hash differs", async () => {
    vi.spyOn(copy, "hashCursorSyncFiles").mockResolvedValue({
      "cursor-user/settings.json": "local",
    });
    vi.spyOn(copy, "hashCloneSyncFiles").mockResolvedValue({
      "cursor-user/settings.json": "clone",
    });
    vi.spyOn(chat, "isChatSyncEnabled").mockReturnValue(false);
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue(undefined);
    expect(await computeCursorDiffers(context(), "/tmp/clone", "cursor-sync")).toBe(
      true
    );
  });

  it("is true when chat fingerprint or checksum mismatch", async () => {
    const hashes = { "cursor-user/settings.json": "aaa" };
    const raw = '{"v":1}';
    vi.spyOn(copy, "hashCursorSyncFiles").mockResolvedValue(hashes);
    vi.spyOn(copy, "hashCloneSyncFiles").mockResolvedValue(hashes);
    vi.spyOn(copy, "readCloneChatRaw").mockResolvedValue(raw);
    vi.spyOn(chat, "isChatSyncEnabled").mockReturnValue(true);
    vi.spyOn(chat, "computeChatSyncLocalFingerprint").mockResolvedValue("fp-local");
    vi.spyOn(chat, "readStoredChatSyncFingerprint").mockResolvedValue("fp-stored");
    vi.spyOn(diagnostics, "loadSyncState").mockResolvedValue({
      lastSyncTimestamp: new Date().toISOString(),
      lastSyncDirection: "push",
      destination: {
        type: "repo",
        owner: "o",
        repo: "r",
        branch: "main",
        basePath: "cursor-sync",
      },
      localChecksums: {
        "dot-cursor/cursor-chat.json": computeChecksum(Buffer.from(raw, "utf8")),
      },
      remoteChecksums: {},
    });
    expect(await computeCursorDiffers(context(), "/tmp/clone", "cursor-sync")).toBe(
      true
    );
  });

  it("propagates hashing errors so the scheduler can treat them as action error", async () => {
    vi.spyOn(copy, "hashCursorSyncFiles").mockRejectedValue(new Error("io"));
    await expect(
      computeCursorDiffers(context(), "/tmp/clone", "cursor-sync")
    ).rejects.toThrow("io");
  });
});
