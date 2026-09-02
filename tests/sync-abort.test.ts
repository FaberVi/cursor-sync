import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("sync-abort", () => {
  afterEach(async () => {
    const { endSyncAbort, getSyncAbortSignal } = await import("../src/sync-abort.js");
    while (getSyncAbortSignal()) {
      endSyncAbort();
    }
    vi.unstubAllGlobals();
  });

  it("requestSyncCancel is a no-op when no operation is running", async () => {
    const { requestSyncCancel, executeCancelSyncCommand } = await import(
      "../src/sync-abort.js"
    );
    expect(requestSyncCancel()).toBe(false);
    executeCancelSyncCommand();
  });

  it("githubRequest returns CANCELLED when the current signal is aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { beginSyncAbort, requestSyncCancel } = await import("../src/sync-abort.js");
    const { githubRequest } = await import("../src/remote/github-api.js");
    beginSyncAbort();
    requestSyncCancel();
    const result = await githubRequest("GET", "/gists", "token");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("CANCELLED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("githubRequest maps fetch AbortError to CANCELLED", async () => {
    vi.stubGlobal("fetch", (_url: string, init?: { signal?: AbortSignal }) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });
    const { beginSyncAbort, requestSyncCancel } = await import("../src/sync-abort.js");
    const { githubRequest } = await import("../src/remote/github-api.js");
    beginSyncAbort();
    const pending = githubRequest("GET", "/gists", "token");
    requestSyncCancel();
    const result = await pending;
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("CANCELLED");
    }
  });

  it("GistClient.request returns CANCELLED when aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { beginSyncAbort, requestSyncCancel } = await import("../src/sync-abort.js");
    const { GistClient } = await import("../src/gist.js");
    beginSyncAbort();
    requestSyncCancel();
    const client = new GistClient("token");
    const result = await client.getGist("abc");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.category).toBe("CANCELLED");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rollbackSyncFileJournal restores backups and unlinks created files", async () => {
    const tmpDir = path.join(os.tmpdir(), "cursor-sync-abort-journal-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
    const existing = path.join(tmpDir, "settings.json");
    const created = path.join(tmpDir, "tasks.json");
    const backupPath = path.join(tmpDir, "settings.json.bak");
    await fs.writeFile(existing, "old", "utf-8");
    await fs.copyFile(existing, backupPath);
    await fs.writeFile(existing, "new", "utf-8");
    await fs.writeFile(created, "created", "utf-8");
    const {
      beginSyncAbort,
      endSyncAbort,
      setSyncFileJournal,
      rollbackSyncFileJournal,
    } = await import("../src/sync-abort.js");
    beginSyncAbort();
    setSyncFileJournal({
      backupEntries: [{ absolutePath: existing, backupPath }],
      createdPaths: [created],
    });
    const n = await rollbackSyncFileJournal();
    expect(n).toBe(2);
    expect(await fs.readFile(existing, "utf-8")).toBe("old");
    await expect(fs.access(created)).rejects.toThrow();
    endSyncAbort();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("nested beginSyncAbort shares one controller until the last end", async () => {
    const {
      beginSyncAbort,
      endSyncAbort,
      getSyncAbortSignal,
      requestSyncCancel,
    } = await import("../src/sync-abort.js");
    const first = beginSyncAbort();
    const nested = beginSyncAbort();
    expect(nested).toBe(first);
    endSyncAbort();
    expect(getSyncAbortSignal()).toBe(first);
    expect(requestSyncCancel()).toBe(true);
    expect(first.aborted).toBe(true);
    endSyncAbort();
    expect(getSyncAbortSignal()).toBeUndefined();
  });

  it("commitSyncFileJournal prevents later rollback of applied files", async () => {
    const tmpDir = path.join(os.tmpdir(), "cursor-sync-abort-commit-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
    const existing = path.join(tmpDir, "settings.json");
    const backupPath = path.join(tmpDir, "settings.json.bak");
    await fs.writeFile(existing, "old", "utf-8");
    await fs.copyFile(existing, backupPath);
    await fs.writeFile(existing, "new", "utf-8");
    const {
      beginSyncAbort,
      endSyncAbort,
      setSyncFileJournal,
      commitSyncFileJournal,
      rollbackSyncFileJournal,
    } = await import("../src/sync-abort.js");
    beginSyncAbort();
    setSyncFileJournal({
      backupEntries: [{ absolutePath: existing, backupPath }],
      createdPaths: [],
    });
    commitSyncFileJournal();
    const n = await rollbackSyncFileJournal();
    expect(n).toBe(0);
    expect(await fs.readFile(existing, "utf-8")).toBe("new");
    endSyncAbort();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rollbackSyncFileJournal restores deleted files and leftover tmp", async () => {
    const tmpDir = path.join(os.tmpdir(), "cursor-sync-abort-delete-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
    const deleted = path.join(tmpDir, "old-hooks.json");
    const backupPath = path.join(tmpDir, "old-hooks.json.bak");
    const leftoverTmp = deleted + ".tmp";
    await fs.writeFile(deleted, "keep-me", "utf-8");
    await fs.copyFile(deleted, backupPath);
    await fs.unlink(deleted);
    await fs.writeFile(leftoverTmp, "partial", "utf-8");
    const {
      beginSyncAbort,
      endSyncAbort,
      setSyncFileJournal,
      rollbackSyncFileJournal,
    } = await import("../src/sync-abort.js");
    beginSyncAbort();
    setSyncFileJournal({
      backupEntries: [{ absolutePath: deleted, backupPath }],
      createdPaths: [],
    });
    const n = await rollbackSyncFileJournal();
    expect(n).toBe(1);
    expect(await fs.readFile(deleted, "utf-8")).toBe("keep-me");
    await expect(fs.access(leftoverTmp)).rejects.toThrow();
    endSyncAbort();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("rollbackSyncFileJournal restores previous sync state after save", async () => {
    const tmpDir = path.join(os.tmpdir(), "cursor-sync-abort-state-" + Date.now());
    await fs.mkdir(tmpDir, { recursive: true });
    const previous = {
      lastSyncTimestamp: "2026-01-01T00:00:00.000Z",
      lastSyncDirection: "push" as const,
      gistId: "old-gist",
      localChecksums: { "cursor-user/settings.json": "aaa" },
      remoteChecksums: { "cursor-user/settings.json": "aaa" },
    };
    const context = {
      globalStorageUri: { fsPath: tmpDir },
    } as import("vscode").ExtensionContext;
    const {
      beginSyncAbort,
      endSyncAbort,
      setSyncFileJournal,
      markJournalStateWritten,
      rollbackSyncFileJournal,
    } = await import("../src/sync-abort.js");
    const { saveSyncState, loadSyncState } = await import("../src/diagnostics.js");
    await saveSyncState(context, {
      ...previous,
      gistId: "new-gist",
      lastSyncTimestamp: "2026-02-01T00:00:00.000Z",
    });
    beginSyncAbort();
    setSyncFileJournal({
      backupEntries: [],
      createdPaths: [],
      previousSyncState: previous,
    });
    markJournalStateWritten();
    await rollbackSyncFileJournal(context);
    const restored = await loadSyncState(context);
    expect(restored?.gistId).toBe("old-gist");
    expect(restored?.lastSyncTimestamp).toBe("2026-01-01T00:00:00.000Z");
    endSyncAbort();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});
