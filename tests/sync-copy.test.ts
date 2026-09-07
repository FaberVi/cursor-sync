import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  copyCursorToClone,
  hashCloneSyncFiles,
  hashCursorSyncFiles,
  indexCloneSyncFiles,
  planCloneToCursor,
  readCloneBuffer,
  withChatCollectionChecksum,
} from "../src/sync-copy.js";
import * as paths from "../src/paths.js";
import type { Manifest } from "../src/types.js";
import { stripExcludedJsonKeys } from "../src/json-key-filter.js";
import { computeChecksum } from "../src/packaging.js";
import { __clearMockGlobalConfigKeys, __setMockGlobalConfig } from "./__mocks__/vscode.js";

describe("sync-copy", () => {
  let tmp = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    __clearMockGlobalConfigKeys("excludeJsonKeys");
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

  it("preserveLocalOnly does not wipe a local-only skill", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(path.join(dotCursor, "skills", "bar"), { recursive: true });
    const localSkill = path.join(dotCursor, "skills", "bar", "SKILL.md");
    await fs.writeFile(localSkill, "local-only");
    await fs.mkdir(path.join(cursorUser), { recursive: true });
    const settings = path.join(cursorUser, "settings.json");
    await fs.writeFile(settings, "{}");
    const remoteSettings = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
    await fs.mkdir(path.dirname(remoteSettings), { recursive: true });
    await fs.writeFile(remoteSettings, "{}");

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
      { absolutePath: localSkill, relativeSyncKey: "dot-cursor/skills/bar/SKILL.md" },
    ]);

    const mirrored = await planCloneToCursor(clone, "cursor-sync");
    expect(mirrored.skillDeleteLocalOnly.some((prefix) => prefix.includes("skills/bar"))).toBe(
      true
    );

    const preserved = await planCloneToCursor(clone, "cursor-sync", {
      preserveLocalOnly: true,
      previousRemoteChecksums: {},
    });
    expect(preserved.skillDeleteLocalOnly).toEqual([]);
    expect(preserved.skillReplace).toEqual([]);
    expect(preserved.keysToDelete).not.toContain("dot-cursor/skills/bar/SKILL.md");
  });

  it("preserveLocalOnly keeps an extra file in a tracked skill and deletes remote-removed files", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(path.join(dotCursor, "skills", "foo"), { recursive: true });
    await fs.mkdir(path.join(dotCursor, "rules"), { recursive: true });
    await fs.mkdir(path.join(cursorUser), { recursive: true });
    const settings = path.join(cursorUser, "settings.json");
    const skill = path.join(dotCursor, "skills", "foo", "SKILL.md");
    const extra = path.join(dotCursor, "skills", "foo", "notes.md");
    const gone = path.join(dotCursor, "rules", "old.mdc");
    await fs.writeFile(settings, "{}");
    await fs.writeFile(skill, "skill");
    await fs.writeFile(extra, "extra");
    await fs.writeFile(gone, "old");
    const remoteSettings = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
    const remoteSkill = path.join(clone, "cursor-sync", "dot-cursor", "skills", "foo", "SKILL.md");
    await fs.mkdir(path.dirname(remoteSettings), { recursive: true });
    await fs.mkdir(path.dirname(remoteSkill), { recursive: true });
    await fs.writeFile(remoteSettings, "{}");
    await fs.writeFile(remoteSkill, "skill");

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
      { absolutePath: skill, relativeSyncKey: "dot-cursor/skills/foo/SKILL.md" },
      { absolutePath: extra, relativeSyncKey: "dot-cursor/skills/foo/notes.md" },
      { absolutePath: gone, relativeSyncKey: "dot-cursor/rules/old.mdc" },
    ]);

    const previousRemoteChecksums = {
      "cursor-user/settings.json": "x",
      "dot-cursor/skills/foo/SKILL.md": "x",
      "dot-cursor/rules/old.mdc": "x",
    };

    const preserved = await planCloneToCursor(clone, "cursor-sync", {
      preserveLocalOnly: true,
      previousRemoteChecksums,
    });
    expect(preserved.skillReplace).toEqual([]);
    expect(preserved.keysToDelete).not.toContain("dot-cursor/skills/foo/notes.md");
    expect(preserved.keysToDelete).toContain("dot-cursor/rules/old.mdc");

    const mirrored = await planCloneToCursor(clone, "cursor-sync");
    expect(mirrored.skillReplace.some((prefix) => prefix.includes("skills/foo"))).toBe(
      true
    );
    expect(mirrored.keysToDelete).toContain("dot-cursor/rules/old.mdc");
  });

  it("treats settings.json that differ only in python.defaultInterpreterPath as equal", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const localSettings = {
      "git.autofetch": true,
      "python.defaultInterpreterPath": "c:\\\\Users\\\\Utente\\\\python.exe",
    };
    const remoteSettings = {
      "git.autofetch": true,
      "python.defaultInterpreterPath": "c:\\\\Users\\\\Vincenzo\\\\python.exe",
    };
    const settings = path.join(cursorUser, "settings.json");
    await fs.writeFile(settings, JSON.stringify(localSettings, null, 4));
    const remoteAbs = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
    await fs.mkdir(path.dirname(remoteAbs), { recursive: true });
    await fs.writeFile(remoteAbs, JSON.stringify(remoteSettings, null, 4));

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    const localHashes = await hashCursorSyncFiles({ cursorUser, dotCursor });
    const cloneHashes = await hashCloneSyncFiles(clone, "cursor-sync");
    expect(localHashes["cursor-user/settings.json"]).toBe(
      cloneHashes["cursor-user/settings.json"]
    );

    const plan = await planCloneToCursor(clone, "cursor-sync");
    expect(plan.filesToWrite.map((f) => f.syncKey)).not.toContain(
      "cursor-user/settings.json"
    );
  });

  it("strips python.defaultInterpreterPath from the clone on push and leaves the live file", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const live = {
      "git.autofetch": true,
      "python.defaultInterpreterPath": "c:\\\\Users\\\\Utente\\\\python.exe",
    };
    const settings = path.join(cursorUser, "settings.json");
    const liveRaw = JSON.stringify(live, null, 4);
    await fs.writeFile(settings, liveRaw);

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    await copyCursorToClone({
      clonePath: clone,
      basePath: "cursor-sync",
      profileName: "default",
    });

    expect(await fs.readFile(settings, "utf8")).toBe(liveRaw);
    const nested = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
    expect(JSON.parse(await fs.readFile(nested, "utf8"))).toEqual({
      "git.autofetch": true,
    });
  });

  it("keeps the local interpreter path when pulling a settings.json that also changed", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const settings = path.join(cursorUser, "settings.json");
    await fs.writeFile(
      settings,
      JSON.stringify(
        {
          "git.autofetch": true,
          "python.defaultInterpreterPath": "c:\\\\Users\\\\Utente\\\\python.exe",
        },
        null,
        4
      )
    );
    const remoteAbs = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
    await fs.mkdir(path.dirname(remoteAbs), { recursive: true });
    await fs.writeFile(
      remoteAbs,
      JSON.stringify(
        {
          "git.autofetch": false,
          "python.defaultInterpreterPath": "c:\\\\Users\\\\Vincenzo\\\\python.exe",
        },
        null,
        4
      )
    );

    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    const plan = await planCloneToCursor(clone, "cursor-sync");
    const write = plan.filesToWrite.find((f) => f.syncKey === "cursor-user/settings.json");
    expect(write).toBeDefined();
    const merged = JSON.parse(write!.content.toString("utf8")) as Record<string, unknown>;
    expect(merged["git.autofetch"]).toBe(false);
    expect(merged["python.defaultInterpreterPath"]).toBe(
      "c:\\\\Users\\\\Utente\\\\python.exe"
    );
    const remoteRaw = await fs.readFile(remoteAbs);
    expect(plan.remoteChecksums["cursor-user/settings.json"]).toBe(
      computeChecksum(
        stripExcludedJsonKeys(remoteRaw, ["python.defaultInterpreterPath"])
      )
    );
    expect(plan.remoteChecksums["cursor-user/settings.json"]).not.toBe(
      computeChecksum(write!.content)
    );
  });

  it("writes and hashes raw JSON when excludeJsonKeys is empty", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-copy-"));
    const cursorUser = path.join(tmp, "user");
    const dotCursor = path.join(tmp, "dot");
    const clone = path.join(tmp, "clone");
    await fs.mkdir(cursorUser, { recursive: true });
    await fs.mkdir(dotCursor, { recursive: true });
    const live = {
      "python.defaultInterpreterPath": "c:\\\\Users\\\\Utente\\\\python.exe",
    };
    const settings = path.join(cursorUser, "settings.json");
    const liveRaw = JSON.stringify(live, null, 4);
    await fs.writeFile(settings, liveRaw);

    __setMockGlobalConfig({ excludeJsonKeys: [] });
    vi.spyOn(paths, "resolveSyncRoots").mockReturnValue({ cursorUser, dotCursor });
    vi.spyOn(paths, "enumerateSyncFiles").mockResolvedValue([
      { absolutePath: settings, relativeSyncKey: "cursor-user/settings.json" },
    ]);

    try {
      await copyCursorToClone({
        clonePath: clone,
        basePath: "cursor-sync",
        profileName: "default",
      });
      const nested = path.join(clone, "cursor-sync", "cursor-user", "settings.json");
      expect(await fs.readFile(nested, "utf8")).toBe(liveRaw);
    } finally {
      __clearMockGlobalConfigKeys("excludeJsonKeys");
    }
  });
});
