import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
import type { ChatBundle } from "../src/chat-persistence.js";
import type { WorkspaceContext } from "../src/chat-workspace-context.js";
import {
  ACTIVATION_DIR,
  formatVerifyCheckLine,
  formatVerifyReport,
  runDiskAndActivationVerify,
  verifyActivationChecks,
  verifyChecksAllOk,
  verifyImportVisibility,
  type VerifyCheck,
  type VerifyIoDeps,
} from "../src/chat-import-verify.js";

const CID = "43aae2fb-71fc-4e9c-9add-3e995caaaa80";
const CHATS_KEY = "573b4babd5b2f206e06d748cd840b177";
const WS_ID = "f038a5d2e2e5594b5e779064d4feac57";
const FOLDER = "/tmp/cursor-sync-fixture-repo";

const workspaceContext: WorkspaceContext = {
  workspaceStorageId: WS_ID,
  folderFsPath: FOLDER,
  chatsWorkspaceKey: CHATS_KEY,
  workspaceIdentifier: {
    id: WS_ID,
    uri: {
      $mid: 1,
      fsPath: FOLDER,
      _sep: 47,
      external: `file://${FOLDER}`,
      path: FOLDER,
      scheme: "file",
    },
  },
};

function makeDeps(overrides: Partial<VerifyIoDeps>): VerifyIoDeps {
  const files = new Map<string, string>();
  const exists = new Set<string>();

  const base: VerifyIoDeps = {
    fileExists: async (p) => exists.has(p),
    readTextFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        throw new Error(`ENOENT ${p}`);
      }
      return v;
    },
    querySqliteRows: async () => [],
    globalStateDbPath: () => "/mock/global/state.vscdb",
    chatsRoot: () => "/mock/.cursor/chats",
  };

  const deps = { ...base, ...overrides };

  return {
    ...deps,
    fileExists: overrides.fileExists ?? base.fileExists,
    readTextFile: overrides.readTextFile ?? base.readTextFile,
    querySqliteRows: overrides.querySqliteRows ?? base.querySqliteRows,
    globalStateDbPath: overrides.globalStateDbPath ?? base.globalStateDbPath,
    chatsRoot: overrides.chatsRoot ?? base.chatsRoot,
    _setFile(path: string, content: string) {
      exists.add(path);
      files.set(path, content);
    },
    _markExists(path: string) {
      exists.add(path);
    },
  } as VerifyIoDeps & {
    _setFile: (path: string, content: string) => void;
    _markExists: (path: string) => void;
  };
}

function checkNamed(checks: VerifyCheck[], name: string): VerifyCheck | undefined {
  return checks.find((c) => c.name === name);
}

describe("chat-import-verify", () => {
  it("verifyChecksAllOk returns false when any FAIL present", () => {
    expect(
      verifyChecksAllOk([
        { name: "a", status: "OK", detail: "" },
        { name: "b", status: "WARN", detail: "" },
      ])
    ).toBe(true);
    expect(
      verifyChecksAllOk([
        { name: "a", status: "OK", detail: "" },
        { name: "b", status: "FAIL", detail: "x" },
      ])
    ).toBe(false);
  });

  it("formatVerifyReport matches Python format_line", () => {
    const checks: VerifyCheck[] = [
      { name: "store.db", status: "OK", detail: "key/cid (3 blobs)" },
      { name: "activation.result", status: "PENDING", detail: "" },
    ];
    expect(formatVerifyCheckLine(checks[0]!)).toBe(
      "[OK] store.db: key/cid (3 blobs)"
    );
    expect(formatVerifyCheckLine(checks[1]!)).toBe("[PENDING] activation.result");
    expect(formatVerifyReport(checks)).toBe(
      "[OK] store.db: key/cid (3 blobs)\n[PENDING] activation.result"
    );
    expect(formatVerifyReport(checks, { jsonLines: true })).toBe(
      '{"check":"store.db","status":"OK","detail":"key/cid (3 blobs)"}\n{"check":"activation.result","status":"PENDING","detail":""}'
    );
  });

  it("ACTIVATION_DIR points at ~/.cursor/import-activation", () => {
    expect(ACTIVATION_DIR.endsWith("/.cursor/import-activation")).toBe(true);
  });

  describe("verifyImportVisibility", () => {
    it("FAIL store.db when bundle had store but file missing", async () => {
      const deps = makeDeps({});
      const checks = await verifyImportVisibility(CID, workspaceContext, {
        expectStore: true,
        deps,
      });
      expect(checkNamed(checks, "store.db")).toEqual({
        name: "store.db",
        status: "FAIL",
        detail: `missing at ~/.cursor/chats/${CHATS_KEY}/${CID}/`,
      });
    });

    it("OK store.db when blobs > 0", async () => {
      const storePath = `/mock/.cursor/chats/${CHATS_KEY}/${CID}/store.db`;
      const deps = makeDeps({
        querySqliteRows: async (dbPath, sql) => {
          if (dbPath !== storePath) {
            return [];
          }
          if (sql.includes("sqlite_master")) {
            return [{ name: "blobs" }];
          }
          if (sql.includes("COUNT")) {
            return [{ n: 2 }];
          }
          return [];
        },
      });
      (deps as VerifyIoDeps & { _markExists: (p: string) => void })._markExists(
        storePath
      );

      const checks = await verifyImportVisibility(CID, workspaceContext, { deps });
      expect(checkNamed(checks, "store.db")).toMatchObject({
        status: "OK",
        detail: `${CHATS_KEY}/${CID} (2 blobs)`,
      });
    });

    it("FAIL store.db when file exists but 0 blobs", async () => {
      const storePath = `/mock/.cursor/chats/${CHATS_KEY}/${CID}/store.db`;
      const deps = makeDeps({
        querySqliteRows: async (dbPath, sql) => {
          if (dbPath !== storePath) {
            return [];
          }
          if (sql.includes("sqlite_master")) {
            return [{ name: "blobs" }];
          }
          if (sql.includes("COUNT")) {
            return [{ n: 0 }];
          }
          return [];
        },
      });
      (deps as VerifyIoDeps & { _markExists: (p: string) => void })._markExists(
        storePath
      );

      const checks = await verifyImportVisibility(CID, workspaceContext, { deps });
      expect(checkNamed(checks, "store.db")).toMatchObject({
        status: "FAIL",
        detail: `${storePath} has 0 blobs`,
      });
    });

    it("SKIP store.db when not expected and missing", async () => {
      const deps = makeDeps({});
      const checks = await verifyImportVisibility(CID, workspaceContext, {
        expectStore: false,
        deps,
      });
      expect(checkNamed(checks, "store.db")).toMatchObject({ status: "SKIP" });
    });

    it("FAIL global.composerHeaders when sidebar row missing", async () => {
      const deps = makeDeps({
        querySqliteRows: async () => [],
      });
      const checks = await verifyImportVisibility(CID, workspaceContext, { deps });
      expect(checkNamed(checks, "global.composerHeaders")).toMatchObject({
        status: "FAIL",
        detail: "sidebar row missing in globalStorage/state.vscdb",
      });
    });

    it("OK global headers and workspaceIdentifier when stamped", async () => {
      const globalDb = "/mock/global/state.vscdb";
      const headerValue = JSON.stringify({
        allComposers: [
          {
            composerId: CID,
            name: "Test",
            workspaceIdentifier: {
              id: WS_ID,
              uri: { fsPath: FOLDER },
            },
          },
        ],
      });
      const deps = makeDeps({
        querySqliteRows: async (dbPath, sql) => {
          if (dbPath === globalDb && sql.includes("composer.composerHeaders")) {
            return [{ value: headerValue }];
          }
          return [];
        },
      });
      (deps as VerifyIoDeps & { _markExists: (p: string) => void })._markExists(
        globalDb
      );

      const checks = await verifyImportVisibility(CID, workspaceContext, { deps });
      expect(checkNamed(checks, "global.composerHeaders")).toMatchObject({
        status: "OK",
        detail: CID,
      });
      expect(checkNamed(checks, "global.workspaceIdentifier")).toMatchObject({
        status: "OK",
        detail: `id=${WS_ID}`,
      });
      expect(
        checkNamed(checks, "global.workspaceIdentifier.fsPath")
      ).toMatchObject({ status: "OK", detail: FOLDER });
    });

    it("FAIL composerData key when expectRichComposerData and missing on disk", async () => {
      const globalDb = "/mock/global/state.vscdb";
      const headerValue = JSON.stringify({
        allComposers: [{ composerId: CID, workspaceIdentifier: { id: WS_ID, uri: { fsPath: FOLDER } } }],
      });
      const deps = makeDeps({
        querySqliteRows: async (dbPath, sql) => {
          if (dbPath === globalDb && sql.includes("composer.composerHeaders")) {
            return [{ value: headerValue }];
          }
          return [];
        },
      });
      (deps as VerifyIoDeps & { _markExists: (p: string) => void })._markExists(
        globalDb
      );

      const checks = await verifyImportVisibility(CID, workspaceContext, {
        expectRichComposerData: true,
        deps,
      });
      expect(
        checkNamed(checks, `global.composerData[${CID}]`)
      ).toMatchObject({
        status: "FAIL",
        detail: "bundle sidebar had composerData but disk key missing",
      });
    });
  });

  describe("verifyActivationChecks", () => {
    it("SKIP pending and PENDING result when no activation files", async () => {
      const deps = makeDeps({});
      const checks = await verifyActivationChecks(CID, {
        deps,
        pendingPath: "/mock/pending.json",
        resultPath: "/mock/result.json",
      });
      expect(checkNamed(checks, "activation.pending")).toMatchObject({
        status: "SKIP",
      });
      expect(checkNamed(checks, "activation.result")).toMatchObject({
        status: "PENDING",
      });
      expect(checkNamed(checks, "activation.status")).toMatchObject({
        status: "SKIP",
      });
    });

    it("OK activation.status when result.json matches", async () => {
      const deps = makeDeps({});
      const ext = deps as VerifyIoDeps & {
        _setFile: (p: string, c: string) => void;
      };
      ext._setFile(
        "/mock/pending.json",
        JSON.stringify({ composerId: CID, commandId: "composer.createComposer" })
      );
      ext._setFile(
        "/mock/result.json",
        JSON.stringify({ ok: true, composerId: CID })
      );

      const checks = await verifyActivationChecks(CID, {
        deps,
        pendingPath: "/mock/pending.json",
        resultPath: "/mock/result.json",
      });
      expect(checkNamed(checks, "activation.pending")).toMatchObject({
        status: "OK",
      });
      expect(checkNamed(checks, "activation.result")).toMatchObject({
        status: "OK",
        detail: `composerId=${CID}`,
      });
      expect(checkNamed(checks, "activation.status")).toMatchObject({
        status: "OK",
        detail: "completed",
      });
    });

    it("PENDING activation.status when pending matches but no result", async () => {
      const deps = makeDeps({});
      const ext = deps as VerifyIoDeps & {
        _setFile: (p: string, c: string) => void;
      };
      ext._setFile(
        "/mock/pending.json",
        JSON.stringify({ partialState: { composerId: CID } })
      );

      const checks = await verifyActivationChecks(CID, {
        deps,
        pendingPath: "/mock/pending.json",
        resultPath: "/mock/result.json",
      });
      expect(checkNamed(checks, "activation.result")).toMatchObject({
        status: "PENDING",
      });
      expect(checkNamed(checks, "activation.status")).toMatchObject({
        status: "PENDING",
        detail: "manifest staged; IDE activation not confirmed",
      });
    });
  });

  describe("runDiskAndActivationVerify", () => {
    it("derives expectStore from bundle storeSnapshot", async () => {
      const bundle = {
        schemaVersion: 1,
        type: "chat-persistence",
        conversationId: CID,
        storeSnapshot: { content: "base64data" },
        sidebarSnapshot: null,
        transcriptFiles: [],
      } as unknown as ChatBundle;

      const deps = makeDeps({});
      const checks = await runDiskAndActivationVerify(CID, workspaceContext, {
        bundle,
        deps,
      });
      expect(checkNamed(checks, "store.db")).toMatchObject({ status: "FAIL" });
    });

    it("appends activation checks when postActivate", async () => {
      const deps = makeDeps({});
      const checks = await runDiskAndActivationVerify(CID, workspaceContext, {
        postActivate: true,
        deps,
      });
      expect(checkNamed(checks, "activation.pending")).toMatchObject({
        status: "SKIP",
      });
    });
  });
});
