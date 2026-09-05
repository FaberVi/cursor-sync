import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  copyCursorToClone,
  hashCloneSyncFiles,
  indexCloneSyncFiles,
  planCloneToCursor,
  readCloneBuffer,
  withChatCollectionChecksum,
} from "../src/sync-copy.js";
import * as paths from "../src/paths.js";
import type { Manifest } from "../src/types.js";

describe("sync-copy", () => {
  let tmp = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  it("adds the chat collection checksum under the sync key", async () => {
    const { computeChecksum } = await import("../src/packaging.js");
    const raw = '{"v":1}';
    const sum = computeChecksum(Buffer.from(raw, "utf8"));
    expect(withChatCollectionChecksum({ "cursor-user/settings.json": "aaa" }, raw)).toEqual({
      "cursor-user/settings.json": "aaa",
      "dot-cursor/cursor-chat.json": sum,
    });
    expect(withChatCollectionChecksum({ a: "1" }, undefined)).toEqual({ a: "1" });
  });

  it("indexes leftover dashed names at the basePath root", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const clone = path.join(tmp, "clone");
    const dashed = path.join(clone, "cursor-sync", "cursor-user--settings.json");
    await fs.mkdir(path.dirname(dashed), { recursive: true });
    await fs.writeFile(dashed, '{"k":1}');
    const nested = path.join(clone, "cursor-sync", "cursor-user", "keybindings.json");
    await fs.mkdir(path.dirname(nested), { recursive: true });
    await fs.writeFile(nested, "{}");

    const index = await indexCloneSyncFiles(clone, "cursor-sync");
    expect(index.dashed.get("cursor-user/settings.json")).toBe(dashed);
    expect(index.nested.get("cursor-user/keybindings.json")).toBe(nested);
  });

  it("decodes legacy base64 payload using the clone manifest", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const abs = path.join(tmp, "payload.bin");
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x01]);
    await fs.writeFile(abs, raw.toString("base64"), "utf8");
    const manifest: Manifest = {
      schemaVersion: 1,
      syncProfileName: "default",
      createdAt: new Date().toISOString(),
      sourceMachineId: "test",
      sourceOS: "win32",
      files: {
        "dot-cursor/payload.bin": {
          checksum: "x",
          sizeBytes: raw.length,
          encoding: "base64",
        },
      },
    };
    const decoded = await readCloneBuffer(abs, "dot-cursor/payload.bin", manifest);
    expect(decoded).toEqual(raw);
  });

  it("deletes leftover dashed files on push copy into the clone", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const settings = path.join(cursorUser, "settings.json");
    await fs.writeFile(settings, '{"theme":"dark"}');

    const leftover = path.join(clone, "cursor-sync", "cursor-user--settings.json");
    await fs.mkdir(path.dirname(leftover), { recursive: true });
    await fs.writeFile(leftover, '{"theme":"old"}');

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    await copyCursorToClone({
      clonePath: clone,
      basePath: "cursor-sync",
      profileName: "default",
    });

    await expect(fs.access(leftover)).rejects.toThrow();
    const nested = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
    expect(await fs.readFile(nested, "utf8")).toBe('{"theme":"dark"}');
  });

  it("does not delete clone mcp.json when MCP sync is off", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const settings = path.join(cursorUser, "settings.json");
    await fs.writeFile(settings, "{}");

    const mcpAbs = path.join(clone, "cursor-sync", "dot-cursor", "mcp.json");
    await fs.mkdir(path.dirname(mcpAbs), { recursive: true });
    await fs.writeFile(mcpAbs, '{"keep":true}');

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    await copyCursorToClone({
      clonePath: clone,
      basePath: "cursor-sync",
      profileName: "default",
    });

    expect(await fs.readFile(mcpAbs, "utf8")).toBe('{"keep":true}');
  });

  it("does not delete clone cursor-chat.json when chatContent is omitted", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const settings = path.join(cursorUser, "settings.json");
    await fs.writeFile(settings, "{}");

    const chatAbs = path.join(clone, "cursor-sync", "cursor-chat.json");
    await fs.mkdir(path.dirname(chatAbs), { recursive: true });
    await fs.writeFile(chatAbs, '{"keep":"chats"}');

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    await copyCursorToClone({
      clonePath: clone,
      basePath: "cursor-sync",
      profileName: "default",
    });

    expect(await fs.readFile(chatAbs, "utf8")).toBe('{"keep":"chats"}');
  });

  it("does not plan pulling mcp.json or chats when those toggles are off", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const settings = path.join(cursorUser, "settings.json");
    await fs.writeFile(settings, "{}");

    const mcpAbs = path.join(clone, "cursor-sync", "dot-cursor", "mcp.json");
    await fs.mkdir(path.dirname(mcpAbs), { recursive: true });
    await fs.writeFile(mcpAbs, '{"keep":true}');
    const chatAbs = path.join(clone, "cursor-sync", "cursor-chat.json");
    await fs.writeFile(chatAbs, '{"v":1}');
    const remoteSettings = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
    await fs.mkdir(path.dirname(remoteSettings), { recursive: true });
    await fs.writeFile(remoteSettings, "{}");

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    const hashes = await hashCloneSyncFiles(clone, "cursor-sync");
    expect(hashes["dot-cursor/mcp.json"]).toBeUndefined();

    const plan = await planCloneToCursor(clone, "cursor-sync");
    expect(plan.filesToWrite.some((f) => f.syncKey === "dot-cursor/mcp.json")).toBe(false);
    expect(plan.chatRaw).toBeUndefined();
  });
});
