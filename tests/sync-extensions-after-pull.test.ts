import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "vscode";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import * as vscode from "vscode";
import {
  LAST_REMOTE_EXTENSIONS_STATE_KEY,
  cacheLastRemoteExtensions,
  clearLastRemoteExtensions,
  parseExtensionEntries,
  parseRemoteExtensionsFileContent,
  promptAndInstallMissingExtensions,
  readLastRemoteExtensions,
  syncExtensionsFromRemoteEntries,
  syncExtensionsFromRemoteFiles,
} from "../src/extensions.js";
import {
  __clearMockGlobalConfigKeys,
  __resetExtensionsAll,
  __resetVscodeCommandsMock,
  __setExecuteCommandImpl,
  __setExtensionsAll,
  __setMockGlobalConfig,
  __setShowWarningMessageResult,
} from "./__mocks__/vscode.js";

function makeContext(store: Record<string, unknown> = {}): ExtensionContext {
  return {
    globalState: {
      get: <T>(key: string) => store[key] as T | undefined,
      update: async (key: string, value: unknown) => {
        if (value === undefined) {
          delete store[key];
        } else {
          store[key] = value;
        }
      },
    },
  } as unknown as ExtensionContext;
}

const logger = { appendLine: vi.fn() };

describe("sync extensions after pull", () => {
  let warningSpy: ReturnType<typeof vi.spyOn>;
  let installed: string[];
  let uninstalled: string[];

  beforeEach(() => {
    __resetExtensionsAll();
    __resetVscodeCommandsMock();
    logger.appendLine.mockReset();
    installed = [];
    uninstalled = [];
    __setExecuteCommandImpl(async (command: string, ...args: unknown[]) => {
      if (command === "workbench.extensions.installExtension") {
        installed.push(String(args[0]));
      }
      if (command === "workbench.extensions.uninstallExtension") {
        uninstalled.push(String(args[0]));
      }
    });
    warningSpy = vi.spyOn(vscode.window, "showWarningMessage");
  });

  afterEach(() => {
    warningSpy.mockRestore();
    __resetExtensionsAll();
    __resetVscodeCommandsMock();
    __clearMockGlobalConfigKeys(
      "syncExtensions.autoUninstall",
      "syncExtensions.allowedPublishers",
      "syncExtensions.autoInstall"
    );
  });

  describe("parseExtensionEntries", () => {
    it("returns undefined for non-array payloads", () => {
      expect(parseExtensionEntries({ id: "ms-python.python" })).toBeUndefined();
      expect(parseExtensionEntries("ms-python.python")).toBeUndefined();
      expect(parseRemoteExtensionsFileContent("{not json")).toBeUndefined();
    });

    it("skips invalid marketplace ids and keeps valid entries", () => {
      expect(
        parseExtensionEntries([
          { id: "../evil", version: "1.0.0" },
          { id: "ms-python.python", version: "1.2.3" },
          { id: "anysphere.cursor-mcp", version: "0.0.1" },
          { notAnEntry: true },
        ])
      ).toEqual([
        { id: "ms-python.python", version: "1.2.3" },
        { id: "anysphere.cursor-mcp", version: "0.0.1" },
      ]);
    });
  });

  describe("last remote extensions cache", () => {
    it("round-trips entries and treats invalid stored values as empty", async () => {
      const store: Record<string, unknown> = {};
      const context = makeContext(store);
      await cacheLastRemoteExtensions(context, [
        { id: "ms-python.python", version: "1.0.0" },
      ]);
      expect(store[LAST_REMOTE_EXTENSIONS_STATE_KEY]).toEqual([
        { id: "ms-python.python", version: "1.0.0" },
      ]);
      expect(readLastRemoteExtensions(context)).toEqual([
        { id: "ms-python.python", version: "1.0.0" },
      ]);

      store[LAST_REMOTE_EXTENSIONS_STATE_KEY] = { broken: true };
      expect(readLastRemoteExtensions(context)).toEqual([]);

      await clearLastRemoteExtensions(context);
      expect(store[LAST_REMOTE_EXTENSIONS_STATE_KEY]).toBeUndefined();
      expect(readLastRemoteExtensions(context)).toEqual([]);
    });
  });

  describe("promptAndInstallMissingExtensions", () => {
    it("does not prompt when the cache is empty", async () => {
      await promptAndInstallMissingExtensions([], logger);
      expect(warningSpy).not.toHaveBeenCalled();
      expect(installed).toEqual([]);
    });

    it("shows Install/Skip and does not install on Skip", async () => {
      __setShowWarningMessageResult("Skip");
      __setMockGlobalConfig({ "syncExtensions.autoInstall": true });
      __setExtensionsAll([{ id: "publisher.alpha", packageJSON: { version: "1.0.0" } }]);

      await promptAndInstallMissingExtensions(
        [
          { id: "publisher.alpha", version: "1.0.0" },
          { id: "publisher.beta", version: "2.0.0" },
        ],
        logger
      );

      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("Install 1 extension(s)"),
        { modal: true },
        "Install",
        "Skip"
      );
      expect(installed).toEqual([]);
      expect(uninstalled).toEqual([]);
    });

    it("does not prompt when autoInstall is off", async () => {
      __setShowWarningMessageResult("Install");
      __setMockGlobalConfig({ "syncExtensions.autoInstall": false });
      __setExtensionsAll([]);

      await promptAndInstallMissingExtensions(
        [{ id: "publisher.beta", version: "2.0.0" }],
        logger
      );

      expect(warningSpy).not.toHaveBeenCalled();
      expect(installed).toEqual([]);
    });

    it("installs only after Install is chosen", async () => {
      __setShowWarningMessageResult("Install");
      __setMockGlobalConfig({ "syncExtensions.autoInstall": true });
      __setExtensionsAll([{ id: "publisher.alpha", packageJSON: { version: "1.0.0" } }]);

      await promptAndInstallMissingExtensions(
        [{ id: "publisher.beta", version: "2.0.0" }],
        logger
      );

      expect(installed).toEqual(["publisher.beta"]);
      expect(uninstalled).toEqual([]);
    });

    it("does not offer product builtins or disallowed publishers", async () => {
      __setShowWarningMessageResult("Install");
      __setMockGlobalConfig({
        "syncExtensions.autoInstall": true,
        "syncExtensions.allowedPublishers": ["ms-python"],
      });
      __setExtensionsAll([]);

      await promptAndInstallMissingExtensions(
        [
          { id: "anysphere.cursor-mcp", version: "0.0.1" },
          { id: "evil.malware", version: "1.0.0" },
          { id: "ms-python.python", version: "1.0.0" },
        ],
        logger
      );

      expect(warningSpy.mock.calls[0]?.[0]).toContain("ms-python.python");
      expect(warningSpy.mock.calls[0]?.[0]).not.toContain("evil.malware");
      expect(installed).toEqual(["ms-python.python"]);
    });
  });

  describe("syncExtensionsFromRemoteEntries extras", () => {
    it("does not prompt or uninstall extras when autoUninstall is off", async () => {
      __setMockGlobalConfig({
        "syncExtensions.autoInstall": false,
        "syncExtensions.autoUninstall": false,
      });
      __setExtensionsAll([
        { id: "publisher.local", packageJSON: { version: "1.0.0" } },
      ]);

      await syncExtensionsFromRemoteEntries(
        [{ id: "publisher.other", version: "1.0.0" }],
        logger
      );
      expect(warningSpy.mock.calls.some((c) => String(c[0]).startsWith("Remove"))).toBe(
        false
      );
      expect(uninstalled).toEqual([]);
    });

    it("uninstalls extras without a prompt when autoUninstall is on", async () => {
      __setMockGlobalConfig({
        "syncExtensions.autoInstall": false,
        "syncExtensions.autoUninstall": true,
      });
      __setExtensionsAll([
        { id: "publisher.local", packageJSON: { version: "1.0.0" } },
      ]);

      await syncExtensionsFromRemoteEntries(
        [{ id: "publisher.other", version: "1.0.0" }],
        logger
      );
      expect(warningSpy.mock.calls.some((c) => String(c[0]).startsWith("Remove"))).toBe(
        false
      );
      expect(uninstalled).toEqual(["publisher.local"]);
    });
  });

  describe("syncExtensionsFromRemoteFiles", () => {
    it("caches a parseable remote list and prompts for missing installs", async () => {
      __setShowWarningMessageResult("Skip");
      __setMockGlobalConfig({ "syncExtensions.autoInstall": true });
      __setExtensionsAll([]);
      const store: Record<string, unknown> = {};
      const context = makeContext(store);

      await syncExtensionsFromRemoteFiles(
        context,
        {
          "cursor-user--extensions.json": JSON.stringify([
            { id: "ms-python.python", version: "1.0.0" },
          ]),
        },
        logger
      );

      expect(readLastRemoteExtensions(context)).toEqual([
        { id: "ms-python.python", version: "1.0.0" },
      ]);
      expect(warningSpy).toHaveBeenCalledWith(
        expect.stringContaining("Install 1 extension(s)"),
        { modal: true },
        "Install",
        "Skip"
      );
    });

    it("does not overwrite the cache when remote JSON is invalid", async () => {
      const store: Record<string, unknown> = {};
      const context = makeContext(store);
      await cacheLastRemoteExtensions(context, [
        { id: "ms-python.python", version: "1.0.0" },
      ]);

      await syncExtensionsFromRemoteFiles(
        context,
        { "cursor-user--extensions.json": "{not json" },
        logger
      );

      expect(readLastRemoteExtensions(context)).toEqual([
        { id: "ms-python.python", version: "1.0.0" },
      ]);
      expect(warningSpy).not.toHaveBeenCalled();
    });
  });
});
