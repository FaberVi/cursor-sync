import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const { refreshSidebar, probeRemoteAhead } = vi.hoisted(() => ({
  refreshSidebar: vi.fn(),
  probeRemoteAhead: vi.fn(),
}));

vi.mock("../src/sidebar/index.js", () => ({
  refreshSidebar,
}));

vi.mock("../src/remote-ahead.js", () => ({
  probeRemoteAhead,
}));

import { executeRefreshSyncStatus } from "../src/refresh-sync-status.js";

describe("refresh-sync-status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    probeRemoteAhead.mockResolvedValue(undefined);
  });

  it("refreshes sidebar and probes remote without syncing", async () => {
    const context = {} as import("vscode").ExtensionContext;
    await executeRefreshSyncStatus(context);

    expect(refreshSidebar).toHaveBeenCalledTimes(1);
    expect(probeRemoteAhead).toHaveBeenCalledWith(context);
  });
});
