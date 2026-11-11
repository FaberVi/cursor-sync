import * as path from "node:path";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { resolveSyncRoots } from "./paths.js";
import {
  defaultVerifyIoDeps,
  verifyLayer4DiskKv,
  type VerifyCheck,
  type VerifyIoDeps,
} from "./chat-import-verify.js";

async function readComposerHeaderEntry(
  deps: VerifyIoDeps,
  dbPath: string,
  conversationId: string
): Promise<Record<string, unknown> | null> {
  if (!(await deps.fileExists(dbPath))) {
    return null;
  }
  const rows = await deps.querySqliteRows(
    dbPath,
    "SELECT value FROM ItemTable WHERE key='composer.composerHeaders' LIMIT 1",
    { retries: 3 }
  );
  if (rows.length === 0) {
    return null;
  }
  const raw = rows[0]?.value;
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const allComposers = (data as Record<string, unknown>).allComposers;
  if (!Array.isArray(allComposers)) {
    return null;
  }
  for (const entry of allComposers) {
    if (
      entry &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      (entry as Record<string, unknown>).composerId === conversationId
    ) {
      return entry as Record<string, unknown>;
    }
  }
  return null;
}

async function countStoreDbBlobs(
  deps: VerifyIoDeps,
  storePath: string
): Promise<number | null> {
  if (!(await deps.fileExists(storePath))) {
    return null;
  }
  try {
    const tables = await deps.querySqliteRows(
      storePath,
      "SELECT name FROM sqlite_master WHERE type='table'"
    );
    const names = new Set(
      tables
        .map((r) => r.name)
        .filter((n): n is string => typeof n === "string")
    );
    if (!names.has("blobs")) {
      return 0;
    }
    const countRows = await deps.querySqliteRows(
      storePath,
      "SELECT COUNT(*) AS n FROM blobs"
    );
    const n = countRows[0]?.n;
    if (typeof n === "number") {
      return n;
    }
    if (typeof n === "string" && /^\d+$/.test(n)) {
      return parseInt(n, 10);
    }
    return 0;
  } catch {
    return null;
  }
}

async function composerDataHasConversationKey(
  deps: VerifyIoDeps,
  dbPath: string,
  conversationId: string
): Promise<boolean | null> {
  if (!(await deps.fileExists(dbPath))) {
    return null;
  }
  const rows = await deps.querySqliteRows(
    dbPath,
    "SELECT value FROM ItemTable WHERE key='composer.composerData' LIMIT 1"
  );
  if (rows.length === 0) {
    return false;
  }
  const raw = rows[0]?.value;
  let data: unknown = raw;
  if (typeof raw === "string") {
    try {
      data = JSON.parse(raw);
    } catch {
      return false;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const val = (data as Record<string, unknown>)[conversationId];
  if (val == null) {
    return false;
  }
  if (typeof val === "object" && !Array.isArray(val)) {
    return Object.keys(val as object).length > 0;
  }
  return false;
}

export interface VerifyImportVisibilityOptions {
  expectRichComposerData?: boolean;
  expectStore?: boolean;
  expectLayer4?: boolean;
  strictLayer4?: boolean;
  deps?: Partial<VerifyIoDeps>;
}

export async function verifyImportVisibility(
  conversationId: string,
  workspaceContext: WorkspaceContext | null,
  options: VerifyImportVisibilityOptions = {}
): Promise<VerifyCheck[]> {
  const deps = { ...defaultVerifyIoDeps(), ...options.deps };
  const expectRichComposerData = options.expectRichComposerData ?? false;
  const expectStore = options.expectStore ?? false;
  const expectLayer4 = options.expectLayer4 ?? false;
  const strictLayer4 = options.strictLayer4 ?? false;
  const checks: VerifyCheck[] = [];

  const chatsKey = workspaceContext?.chatsWorkspaceKey ?? null;
  let storePath: string | null = null;
  if (chatsKey) {
    storePath = path.join(
      deps.chatsRoot(),
      chatsKey,
      conversationId,
      "store.db"
    );
    if (await deps.fileExists(storePath)) {
      const blobN = await countStoreDbBlobs(deps, storePath);
      if (blobN === null) {
        checks.push({
          name: "store.db",
          status: "WARN",
          detail: `${storePath} exists but blob count unreadable`,
        });
      } else if (blobN > 0) {
        checks.push({
          name: "store.db",
          status: "OK",
          detail: `${chatsKey}/${conversationId} (${blobN} blobs)`,
        });
      } else {
        checks.push({
          name: "store.db",
          status: "FAIL",
          detail: `${storePath} has 0 blobs`,
        });
      }
    } else if (expectStore) {
      checks.push({
        name: "store.db",
        status: "FAIL",
        detail: `missing at ~/.cursor/chats/${chatsKey}/${conversationId}/`,
      });
    } else {
      checks.push({
        name: "store.db",
        status: "SKIP",
        detail: `no file at ~/.cursor/chats/${chatsKey}/${conversationId}/`,
      });
    }
  } else if (expectStore) {
    checks.push({
      name: "store.db",
      status: "FAIL",
      detail: "workspace context missing",
    });
  }

  const globalDb = deps.globalStateDbPath();
  const ent = await readComposerHeaderEntry(deps, globalDb, conversationId);
  if (ent === null) {
    checks.push({
      name: "global.composerHeaders",
      status: "FAIL",
      detail: "sidebar row missing in globalStorage/state.vscdb",
    });
  } else {
    const wiRaw = ent.workspaceIdentifier;
    const wi =
      wiRaw && typeof wiRaw === "object" && !Array.isArray(wiRaw)
        ? (wiRaw as Record<string, unknown>)
        : {};
    const wiId = wi.id;
    const uri = wi.uri;
    const fp =
      uri && typeof uri === "object" && !Array.isArray(uri)
        ? (uri as Record<string, unknown>).fsPath
        : undefined;
    const expected = workspaceContext?.folderFsPath;
    const expectedId = workspaceContext?.workspaceStorageId;

    if (!wiId) {
      checks.push({
        name: "global.workspaceIdentifier",
        status: "FAIL",
        detail: "id not stamped on header",
      });
    } else if (expectedId && wiId !== expectedId) {
      checks.push({
        name: "global.workspaceIdentifier",
        status: "FAIL",
        detail: `id=${String(wiId)} expected workspaceStorage id ${expectedId}`,
      });
    } else {
      checks.push({
        name: "global.workspaceIdentifier",
        status: "OK",
        detail: `id=${String(wiId)}`,
      });
    }

    if (expected && fp !== expected) {
      checks.push({
        name: "global.workspaceIdentifier.fsPath",
        status: "FAIL",
        detail: `uri.fsPath=${JSON.stringify(fp)} expected ${JSON.stringify(expected)}`,
      });
    } else if (expected && fp === expected) {
      checks.push({
        name: "global.workspaceIdentifier.fsPath",
        status: "OK",
        detail: String(fp ?? ""),
      });
    } else if (expected) {
      checks.push({
        name: "global.workspaceIdentifier.fsPath",
        status: "FAIL",
        detail: "uri.fsPath missing on header",
      });
    }

    checks.push({
      name: "global.composerHeaders",
      status: "OK",
      detail: conversationId,
    });
  }

  if (workspaceContext) {
    const { cursorUser } = resolveSyncRoots();
    const wsDb = path.join(
      cursorUser,
      "workspaceStorage",
      workspaceContext.workspaceStorageId,
      "state.vscdb"
    );
    const entW = await readComposerHeaderEntry(deps, wsDb, conversationId);
    const wsLabel = `workspace.composerHeaders(${workspaceContext.workspaceStorageId})`;
    if (entW === null) {
      checks.push({
        name: wsLabel,
        status: "WARN",
        detail: "missing (global row may still be enough)",
      });
    } else {
      checks.push({
        name: wsLabel,
        status: "OK",
        detail: conversationId,
      });
    }

    for (const [label, db] of [
      ["global", globalDb],
      ["workspace", wsDb],
    ] as const) {
      const hasKey = await composerDataHasConversationKey(
        deps,
        db,
        conversationId
      );
      if (expectRichComposerData) {
        if (hasKey) {
          checks.push({
            name: `${label}.composerData[${conversationId}]`,
            status: "OK",
            detail: "per-composer payload present",
          });
        } else {
          checks.push({
            name: `${label}.composerData[${conversationId}]`,
            status: "FAIL",
            detail: "bundle sidebar had composerData but disk key missing",
          });
        }
      } else if (hasKey) {
        checks.push({
          name: `${label}.composerData[${conversationId}]`,
          status: "OK",
          detail: "per-composer payload present",
        });
      }
    }
  }

  checks.push(
    ...(await verifyLayer4DiskKv(deps, conversationId, expectLayer4, strictLayer4))
  );

  return checks;
}
