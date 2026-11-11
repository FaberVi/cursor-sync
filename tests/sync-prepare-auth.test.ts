import { describe, expect, it, vi } from "vitest";

const getToken = vi.hoisted(() => vi.fn());
const requireToken = vi.hoisted(() => vi.fn());
const validateStoredToken = vi.hoisted(() => vi.fn());
const showSyncFailureWithDebug = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/auth.js", () => ({
  getToken,
  requireToken,
  validateStoredToken,
}));
vi.mock("../src/sync-debug.js", () => ({
  showSyncFailureWithDebug,
  buildSyncDebugFailure: vi.fn(),
}));

import type * as vscode from "vscode";
import { prepareRepoSync } from "../src/sync-prepare.js";

function context(): vscode.ExtensionContext {
  return {
    globalStorageUri: { fsPath: "/tmp/cursor-sync-prepare-auth" },
  } as unknown as vscode.ExtensionContext;
}

describe("prepareRepoSync token rejection", () => {
  it("stops when the stored token is rejected and does not reuse it", async () => {
    getToken.mockResolvedValue("stored");
    validateStoredToken.mockResolvedValue(false);
    requireToken.mockResolvedValue("stored");
    showSyncFailureWithDebug.mockReset();

    const prepared = await prepareRepoSync(context(), "pull", "manual", {
      report: () => {},
    });

    expect(prepared).toBeUndefined();
    expect(validateStoredToken).toHaveBeenCalledTimes(1);
    expect(requireToken).not.toHaveBeenCalled();
    expect(showSyncFailureWithDebug).not.toHaveBeenCalled();
  });
});
