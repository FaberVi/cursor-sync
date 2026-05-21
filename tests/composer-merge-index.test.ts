import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseComposerHeadersBlob } from "../src/composer-merge.js";

const querySqliteRowsMock = vi.fn();
const resolveStateDbCandidatesMock = vi.fn();

vi.mock("../src/transcripts.js", () => ({
  __chatPersistenceInternals: {
    querySqliteRows: (...args: unknown[]) => querySqliteRowsMock(...args),
    resolveStateDbCandidates: () => resolveStateDbCandidatesMock(),
  },
}));

describe("composer name index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("getComposerDisplayName returns trimmed name from index", async () => {
    const { getComposerDisplayName } = await import("../src/composer-merge.js");
    const index = new Map([["conv-a", "  Sidebar Title  "]]);
    expect(getComposerDisplayName(index, "conv-a")).toBe("Sidebar Title");
    expect(getComposerDisplayName(index, "missing")).toBeUndefined();
  });

  it("loadComposerNameIndex parses composer.composerHeaders from first readable db", async () => {
    const headers = {
      allComposers: [
        { composerId: "c1", name: "First", type: "head" },
        { composerId: "c2", name: "" },
        { composerId: "c3", name: "Third" },
      ],
    };
    resolveStateDbCandidatesMock.mockResolvedValue(["/tmp/state.vscdb"]);
    querySqliteRowsMock.mockResolvedValue([{ value: JSON.stringify(headers) }]);

    const { loadComposerNameIndex } = await import("../src/composer-merge.js");
    const index = await loadComposerNameIndex();
    expect(index.get("c1")).toBe("First");
    expect(index.has("c2")).toBe(false);
    expect(index.get("c3")).toBe("Third");
    expect(querySqliteRowsMock).toHaveBeenCalledWith(
      "/tmp/state.vscdb",
      "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1"
    );
  });

  it("loadComposerNameIndex returns empty map when no db candidates", async () => {
    resolveStateDbCandidatesMock.mockResolvedValue([]);
    const { loadComposerNameIndex } = await import("../src/composer-merge.js");
    const index = await loadComposerNameIndex();
    expect(index.size).toBe(0);
    expect(querySqliteRowsMock).not.toHaveBeenCalled();
  });

  it("parseComposerHeadersBlob still used for empty blob", () => {
    expect(parseComposerHeadersBlob(undefined).allComposers).toEqual([]);
  });
});
