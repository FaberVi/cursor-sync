import { describe, expect, it } from "vitest";
import { recordImport, listImports, clearImports } from "../src/sidebar/import-history.js";

function mockContext() {
  const store = new Map<string, unknown>();
  return {
    globalState: {
      get: <T,>(k: string) => store.get(k) as T,
      update: async (k: string, v: unknown) => { store.set(k, v); },
    },
  } as any;
}

describe("import-history", () => {
  it("records newest first and caps at 200", async () => {
    const ctx = mockContext();
    for (let i = 0; i < 205; i++) {
      await recordImport(ctx, {
        conversationId: `c${i}`,
        transcriptsWritten: i,
        storeWritten: true,
        sidebarMerged: true,
        warnings: 0,
        timestamp: new Date(2026, 0, 1, 0, 0, i).toISOString(),
      });
    }
    const list = listImports(ctx);
    expect(list).toHaveLength(200);
    expect(list[0]!.conversationId).toBe("c204");
  });

  it("clearImports empties history", async () => {
    const ctx = mockContext();
    await recordImport(ctx, {
      conversationId: "c1", transcriptsWritten: 0, storeWritten: false,
      sidebarMerged: false, warnings: 0, timestamp: "2026-01-01T00:00:00Z",
    });
    await clearImports(ctx);
    expect(listImports(ctx)).toHaveLength(0);
  });

  it("listImports returns empty array when no history", () => {
    const ctx = mockContext();
    expect(listImports(ctx)).toHaveLength(0);
  });

  it("records in newest-first order", async () => {
    const ctx = mockContext();
    await recordImport(ctx, {
      conversationId: "first", transcriptsWritten: 1, storeWritten: true,
      sidebarMerged: false, warnings: 0, timestamp: "2026-01-01T00:00:00Z",
    });
    await recordImport(ctx, {
      conversationId: "second", transcriptsWritten: 2, storeWritten: true,
      sidebarMerged: true, warnings: 1, timestamp: "2026-01-02T00:00:00Z",
    });
    const list = listImports(ctx);
    expect(list).toHaveLength(2);
    expect(list[0]!.conversationId).toBe("second");
    expect(list[1]!.conversationId).toBe("first");
  });
});
