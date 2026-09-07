import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

const writeGate = vi.hoisted(() => {
  let writeCount = 0;
  let releaseFirst!: () => void;
  let firstReached!: () => void;
  return {
    reset() {
      writeCount = 0;
      this.firstHold = new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      this.firstStarted = new Promise<void>((resolve) => {
        firstReached = resolve;
      });
    },
    bump() {
      writeCount += 1;
      return writeCount;
    },
    markFirst() {
      firstReached();
    },
    releaseFirst() {
      releaseFirst();
    },
    firstHold: Promise.resolve(),
    firstStarted: Promise.resolve(),
  };
});

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    writeFile: async (
      file: Parameters<typeof actual.writeFile>[0],
      data: Parameters<typeof actual.writeFile>[1],
      options?: Parameters<typeof actual.writeFile>[2]
    ) => {
      const n = writeGate.bump();
      if (n === 1) {
        writeGate.markFirst();
        await writeGate.firstHold;
      }
      return actual.writeFile(file, data, options);
    },
  };
});

import type { SyncHistoryEntry } from "../src/types.js";

describe("addSyncHistoryEntry serialization", () => {
  let storageRoot: string;

  beforeEach(async () => {
    writeGate.reset();
    const fs = await import("node:fs/promises");
    storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-hist-serial-"));
  });

  afterEach(async () => {
    const fs = await import("node:fs/promises");
    await fs.rm(storageRoot, { recursive: true, force: true });
  });

  it("keeps both entries when two writes overlap", async () => {
    const diagnostics = await import("../src/diagnostics.js");
    const ctx = {
      globalStorageUri: { fsPath: storageRoot },
    } as import("vscode").ExtensionContext;

    const entryA: SyncHistoryEntry = {
      timestamp: "2026-07-19T10:00:00.000Z",
      direction: "push",
      trigger: "manual",
      fileCount: 1,
      success: false,
      error: "first",
    };
    const entryB: SyncHistoryEntry = {
      timestamp: "2026-07-19T10:00:01.000Z",
      direction: "pull",
      trigger: "scheduled",
      fileCount: 1,
      success: false,
      error: "second",
    };

    const first = diagnostics.addSyncHistoryEntry(ctx, entryA);
    await writeGate.firstStarted;
    const second = diagnostics.addSyncHistoryEntry(ctx, entryB);
    writeGate.releaseFirst();
    await Promise.all([first, second]);

    const history = await diagnostics.loadSyncHistory(ctx);
    expect(history).toHaveLength(2);
    expect(history.map((e) => e.error).sort()).toEqual(["first", "second"]);
  });
});
