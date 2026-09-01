import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { GistClient } from "../src/gist.js";
import { GistBackend } from "../src/remote/gist-backend.js";
import type { GistResponse } from "../src/types.js";

function gistResponse(): GistResponse {
  return {
    id: "gist-abc",
    html_url: "https://gist.github.com/gist-abc",
    description: "Cursor Sync - Settings Backup",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    files: {
      "manifest.json": {
        filename: "manifest.json",
        content: '{"files":{}}',
        truncated: false,
      },
      "cursor-user--settings.json": {
        filename: "cursor-user--settings.json",
        content: "{}",
        truncated: false,
      },
      "cursor-chat.json": {
        filename: "cursor-chat.json",
        truncated: true,
        raw_url: "https://gist.githubusercontent.com/truncated-chat",
        content: "",
      },
    },
  };
}

describe("GistBackend snapshot cache", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("reuses getGist on a second getSnapshot of the same instance", async () => {
    const gist = gistResponse();
    const getGist = vi
      .spyOn(GistClient.prototype, "getGist")
      .mockResolvedValue({ ok: true, data: gist });
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    const backend = new GistBackend("token", "gist-abc");
    const first = await backend.getSnapshot({ onlyFiles: ["manifest.json"] });
    const second = await backend.getSnapshot({
      onlyFiles: ["cursor-user--settings.json"],
    });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (first.ok) {
      expect(first.data.files).toEqual({ "manifest.json": '{"files":{}}' });
      expect(first.data.allFileNames).toEqual([
        "manifest.json",
        "cursor-user--settings.json",
        "cursor-chat.json",
      ]);
    }
    if (second.ok) {
      expect(second.data.files).toEqual({
        "cursor-user--settings.json": "{}",
      });
    }
    expect(getGist).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports onFileProgress after each downloaded gist file", async () => {
    const gist = gistResponse();
    vi.spyOn(GistClient.prototype, "getGist").mockResolvedValue({
      ok: true,
      data: gist,
    });
    globalThis.fetch = vi.fn() as unknown as typeof fetch;

    const progress: Array<[number, number]> = [];
    const backend = new GistBackend("token", "gist-abc");
    const snap = await backend.getSnapshot({
      onlyFiles: ["manifest.json", "cursor-user--settings.json"],
      onFileProgress: (completed, total) => {
        progress.push([completed, total]);
      },
    });

    expect(snap.ok).toBe(true);
    expect(progress).toEqual([
      [1, 2],
      [2, 2],
    ]);
  });

  it("does not report onFileProgress when a gist file fetch fails", async () => {
    const gist = gistResponse();
    vi.spyOn(GistClient.prototype, "getGist").mockResolvedValue({
      ok: true,
      data: gist,
    });
    globalThis.fetch = vi.fn(async () => {
      throw new Error("network");
    }) as unknown as typeof fetch;

    const progress: Array<[number, number]> = [];
    const backend = new GistBackend("token", "gist-abc");
    const snap = await backend.getSnapshot({
      onlyFiles: ["cursor-chat.json"],
      onFileProgress: (completed, total) => {
        progress.push([completed, total]);
      },
    });

    expect(snap.ok).toBe(false);
    expect(progress).toEqual([]);
  });

  it("invalidates the cache after writeFiles", async () => {
    const gist = gistResponse();
    const getGist = vi
      .spyOn(GistClient.prototype, "getGist")
      .mockResolvedValue({ ok: true, data: gist });
    vi.spyOn(GistClient.prototype, "updateGist").mockResolvedValue({
      ok: true,
      data: gist,
    });

    const backend = new GistBackend("token", "gist-abc");
    await backend.getSnapshot({ onlyFiles: ["manifest.json"] });
    const written = await backend.writeFiles({
      "manifest.json": '{"files":{}}',
    });
    expect(written.ok).toBe(true);
    await backend.getSnapshot({ onlyFiles: ["manifest.json"] });
    expect(getGist).toHaveBeenCalledTimes(2);
  });
});
