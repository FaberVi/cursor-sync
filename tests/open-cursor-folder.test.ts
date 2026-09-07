import { beforeEach, describe, expect, it, vi } from "vitest";

const { showQuickPickMock, revealFsPathInOs } = vi.hoisted(() => ({
  showQuickPickMock: vi.fn(),
  revealFsPathInOs: vi.fn(async () => undefined),
}));

vi.mock("vscode", () => ({
  window: {
    showQuickPick: showQuickPickMock,
  },
  workspace: {
    getConfiguration: () => ({
      get: () => "en",
    }),
  },
  env: { language: "en" },
  ConfigurationTarget: { Global: 1 },
}));

vi.mock("../src/reveal-fs-path.js", () => ({
  revealFsPathInOs: (...args: unknown[]) => revealFsPathInOs(...args),
}));

import { resolveSyncRoots } from "../src/paths.js";

describe("executeOpenCursorFolder", () => {
  beforeEach(() => {
    revealFsPathInOs.mockClear();
    showQuickPickMock.mockReset();
  });

  it("opens ~/.cursor when folder is dotCursor", async () => {
    const { executeOpenCursorFolder } = await import("../src/open-cursor-folder.js");
    const roots = resolveSyncRoots();
    await executeOpenCursorFolder({ folder: "dotCursor" });
    expect(revealFsPathInOs).toHaveBeenCalledWith(roots.dotCursor);
  });

  it("opens Cursor User when folder is cursorUser", async () => {
    const { executeOpenCursorFolder } = await import("../src/open-cursor-folder.js");
    const roots = resolveSyncRoots();
    await executeOpenCursorFolder({ folder: "cursorUser" });
    expect(revealFsPathInOs).toHaveBeenCalledWith(roots.cursorUser);
  });

  it("reveals the quick-pick selection when pick is true", async () => {
    const roots = resolveSyncRoots();
    showQuickPickMock.mockResolvedValueOnce({
      id: "cursorUser",
      label: "Cursor User",
      description: roots.cursorUser,
    });

    const { executeOpenCursorFolder } = await import("../src/open-cursor-folder.js");
    await executeOpenCursorFolder({ pick: true });
    expect(revealFsPathInOs).toHaveBeenCalledWith(roots.cursorUser);
  });
});
