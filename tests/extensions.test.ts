import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  generateExtensionsJson,
  isSyncableExtension,
  listSyncableExtensionEntries,
  findMissingExtensions,
  findExtraExtensions,
  writeExtensionsFile,
} from "../src/extensions.js";
import { __setExtensionsAll, __resetExtensionsAll } from "./__mocks__/vscode.js";

describe("extensions", () => {
  beforeEach(() => {
    __resetExtensionsAll();
  });

  afterEach(() => {
    __resetExtensionsAll();
  });

  describe("isSyncableExtension", () => {
    it("excludes vscode.* and packageJSON builtin flags", () => {
      expect(
        isSyncableExtension({
          id: "vscode.git",
          packageJSON: { isBuiltin: true },
        })
      ).toBe(false);
      expect(
        isSyncableExtension({
          id: "anysphere.cursor-mcp",
          packageJSON: { isBuiltin: true },
        })
      ).toBe(false);
      expect(
        isSyncableExtension({
          id: "anysphere.cursorpyright",
          packageJSON: { isUserBuiltin: true },
        })
      ).toBe(false);
      expect(
        isSyncableExtension({
          id: "ms-python.python",
          packageJSON: { version: "1.0.0", isBuiltin: false },
        })
      ).toBe(true);
      expect(
        isSyncableExtension({
          id: "anysphere.remote-ssh",
          packageJSON: { version: "1.1.13" },
        })
      ).toBe(true);
    });
  });

  describe("generateExtensionsJson", () => {
    it("includes only user-installed extensions in stable order", () => {
      __setExtensionsAll([
        {
          id: "vscode.git",
          packageJSON: { version: "1.0.0", isBuiltin: true },
        },
        {
          id: "anysphere.cursor-mcp",
          packageJSON: { version: "0.0.1", isBuiltin: true },
        },
        { id: "publisher.beta", packageJSON: { version: "2.0.0" } },
        { id: "publisher.alpha", packageJSON: { version: "1.0.0" } },
      ]);

      const json = generateExtensionsJson();
      const parsed = JSON.parse(json) as Array<{ id: string; version: string }>;

      expect(parsed).toEqual([
        { id: "publisher.alpha", version: "1.0.0" },
        { id: "publisher.beta", version: "2.0.0" },
      ]);
      expect(json).toBe(JSON.stringify(parsed, null, 2));
    });

    it("produces identical output across repeated calls", () => {
      __setExtensionsAll([
        { id: "zeta.ext", packageJSON: { version: "1.0.0" } },
        { id: "alpha.ext", packageJSON: { version: "1.0.0" } },
        {
          id: "anysphere.cursor-explorer",
          packageJSON: { version: "0.0.1", isBuiltin: true },
        },
      ]);

      expect(generateExtensionsJson()).toBe(generateExtensionsJson());
      expect(listSyncableExtensionEntries().map((e) => e.id)).toEqual([
        "alpha.ext",
        "zeta.ext",
      ]);
    });
  });

  describe("findMissingExtensions / findExtraExtensions", () => {
    it("does not treat installed builtins as missing or as uninstall extras", () => {
      __setExtensionsAll([
        {
          id: "anysphere.cursor-mcp",
          packageJSON: { version: "0.0.1", isBuiltin: true },
        },
        { id: "publisher.alpha", packageJSON: { version: "1.0.0" } },
      ]);

      const remote = [
        { id: "anysphere.cursor-mcp", version: "0.0.1" },
        { id: "publisher.alpha", version: "1.0.0" },
        { id: "publisher.beta", version: "2.0.0" },
      ];

      expect(findMissingExtensions(remote)).toEqual([
        { id: "publisher.beta", version: "2.0.0" },
      ]);
      expect(findExtraExtensions(remote)).toEqual([]);
    });

    it("lists syncable-only extras for uninstall candidates", () => {
      __setExtensionsAll([
        {
          id: "anysphere.cursor-mcp",
          packageJSON: { version: "0.0.1", isBuiltin: true },
        },
        { id: "publisher.local", packageJSON: { version: "1.0.0" } },
      ]);

      expect(
        findExtraExtensions([{ id: "publisher.other", version: "1.0.0" }])
      ).toEqual(["publisher.local"]);
    });
  });

  describe("writeExtensionsFile", () => {
    it("skips disk write when content is unchanged", async () => {
      const tmpDir = path.join(os.tmpdir(), `cursor-sync-ext-${Date.now()}`);
      const content =
        '[\n  {\n    "id": "publisher.alpha",\n    "version": "1.0.0"\n  }\n]';
      await fs.mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, "extensions.json");
      await fs.writeFile(filePath, content, "utf-8");
      const before = (await fs.stat(filePath)).mtimeMs;

      await writeExtensionsFile(tmpDir, content);

      const after = (await fs.stat(filePath)).mtimeMs;
      expect(after).toBe(before);

      await fs.rm(tmpDir, { recursive: true, force: true });
    });
  });

  describe("isLikelyProductBuiltinId / install candidates", () => {
    it("treats Cursor product helpers as non-installable remote entries", async () => {
      const {
        isLikelyProductBuiltinId,
        isInstallCandidateExtensionId,
        isValidMarketplaceExtensionId,
        isPublisherAllowed,
      } = await import("../src/extensions.js");
      expect(isLikelyProductBuiltinId("anysphere.cursor-mcp")).toBe(true);
      expect(isInstallCandidateExtensionId("anysphere.cursor-mcp")).toBe(false);
      expect(isLikelyProductBuiltinId("anysphere.cursorpyright")).toBe(false);
      expect(isInstallCandidateExtensionId("anysphere.remote-ssh")).toBe(true);
      expect(isInstallCandidateExtensionId("ms-python.python")).toBe(true);
      expect(isValidMarketplaceExtensionId("../evil")).toBe(false);
      expect(isInstallCandidateExtensionId("../evil")).toBe(false);
      expect(isPublisherAllowed("ms-python.python", [])).toBe(true);
      expect(isPublisherAllowed("ms-python.python", ["ms-python"])).toBe(true);
      expect(isPublisherAllowed("evil.malware", ["ms-python"])).toBe(false);
    });
  });
});
