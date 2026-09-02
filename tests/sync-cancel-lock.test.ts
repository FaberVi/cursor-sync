import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs/promises";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const fetchPullRemoteMock = vi.hoisted(() => vi.fn());

vi.mock("../src/pull-remote-fetch.js", () => ({
  fetchPullRemote: (...args: unknown[]) => fetchPullRemoteMock(...args),
}));

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar: vi.fn(),
}));

function mockContext(storageDir: string): import("vscode").ExtensionContext {
  return {
    globalStorageUri: { fsPath: storageDir },
    globalState: {
      get: vi.fn(),
      update: vi.fn().mockResolvedValue(undefined),
      keys: vi.fn().mockReturnValue([]),
    },
    secrets: {
      get: async () => "ghp_test_token",
      store: async () => {},
      delete: async () => {},
      onDidChange: () => ({ dispose: () => {} }),
    },
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
}

describe("sync cancel releases locks", () => {
  let tmpDir = "";

  beforeEach(async () => {
    tmpDir = path.join(os.tmpdir(), "cursor-sync-cancel-lock-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
    fetchPullRemoteMock.mockReset();
  });

  afterEach(async () => {
    const { endSyncAbort, getSyncAbortSignal } = await import("../src/sync-abort.js");
    while (getSyncAbortSignal()) {
      endSyncAbort();
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("executePull clears isPullLocked after SyncCancelledError", async () => {
    const { SyncCancelledError } = await import("../src/sync-abort.js");
    fetchPullRemoteMock.mockRejectedValue(new SyncCancelledError());
    const { executePull, isPullLocked } = await import("../src/pull.js");
    const ok = await executePull(mockContext(tmpDir));
    expect(ok).toBe(false);
    expect(isPullLocked()).toBe(false);
  });

  it("executePush clears isPushLocked after SyncCancelledError", async () => {
    const { SyncCancelledError } = await import("../src/sync-abort.js");
    const auth = await import("../src/auth.js");
    vi.spyOn(auth, "requireToken").mockRejectedValue(new SyncCancelledError());
    const { executePush, isPushLocked } = await import("../src/push.js");
    const ok = await executePush(mockContext(tmpDir));
    expect(ok).toBe(false);
    expect(isPushLocked()).toBe(false);
  });
});
