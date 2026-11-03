import type { ChatBundle } from "./chat-persistence.js";
import type { WorkspaceContext } from "./chat-workspace-context.js";
import { sidebarSnapshotHasComposerData } from "./chat-partial-state.js";
import { bundleHasNativeDiskKv } from "./chat-bundle-fidelity.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { resolveSyncRoots } from "./paths.js";
import { resolveChatsRoot } from "./transcripts-cursor-paths.js";
import { querySqliteRows } from "./transcripts-sqlite.js";
import {
  verifyImportVisibility,
  type VerifyImportVisibilityOptions,
} from "./chat-import-verify-visibility.js";
import {
  verifyActivationChecks,
  type VerifyActivationChecksOptions,
} from "./chat-import-verify-activation.js";

export type VerifyStatus = "OK" | "WARN" | "FAIL" | "SKIP" | "PENDING";

export interface VerifyCheck {
  name: string;
  status: VerifyStatus;
  detail: string;
}

export { ACTIVATION_DIR, ACTIVATION_PENDING_PATH, ACTIVATION_RESULT_PATH } from "./chat-import-activate.js";

export interface VerifyIoDeps {
  fileExists: (filePath: string) => Promise<boolean>;
  readTextFile: (filePath: string) => Promise<string>;
  querySqliteRows: (
    dbPath: string,
    sql: string,
    opts?: { retries?: number }
  ) => Promise<Array<Record<string, unknown>>>;
  globalStateDbPath: () => string;
  chatsRoot: () => string;
}

export function defaultVerifyIoDeps(): VerifyIoDeps {
  return {
    fileExists: async (filePath: string) => {
      try {
        const stat = await fs.stat(filePath);
        return stat.isFile();
      } catch {
        return false;
      }
    },
    readTextFile: (filePath: string) => fs.readFile(filePath, "utf8"),
    querySqliteRows,
    globalStateDbPath: () => {
      const { cursorUser } = resolveSyncRoots();
      return path.join(cursorUser, "globalStorage", "state.vscdb");
    },
    chatsRoot: resolveChatsRoot,
  };
}

export async function verifyLayer4DiskKv(
  deps: VerifyIoDeps,
  conversationId: string,
  expectLayer4: boolean,
  strictLayer4: boolean
): Promise<VerifyCheck[]> {
  const checks: VerifyCheck[] = [];
  const globalDb = deps.globalStateDbPath();
  if (!(await deps.fileExists(globalDb))) {
    checks.push({
      name: "layer4.globalDb",
      status: expectLayer4 ? "FAIL" : "SKIP",
      detail: "global state.vscdb missing",
    });
    return checks;
  }

  const composerKey = `composerData:${conversationId}`;
  const escComposerKey = composerKey.replace(/'/g, "''");
  const composerRows = await deps.querySqliteRows(
    globalDb,
    `SELECT key, value FROM cursorDiskKV WHERE key = '${escComposerKey}' LIMIT 1`
  );
  if (composerRows.length === 0) {
    checks.push({
      name: "layer4.composerData",
      status: expectLayer4 ? "FAIL" : "WARN",
      detail: `missing cursorDiskKV row ${composerKey}`,
    });
  } else {
    checks.push({
      name: "layer4.composerData",
      status: "OK",
      detail: composerKey,
    });
  }

  const prefix = `bubbleId:${conversationId}:`;
  const escPrefix = prefix.replace(/'/g, "''");
  const bubbleRows = await deps.querySqliteRows(
    globalDb,
    `SELECT key, value FROM cursorDiskKV WHERE key LIKE '${escPrefix}%'`
  );
  let toolBubbleCount = 0;
  for (const row of bubbleRows) {
    const raw = row.value;
    if (typeof raw !== "string") {
      continue;
    }
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      if (obj.toolFormerData) {
        toolBubbleCount += 1;
      }
    } catch {
      continue;
    }
  }

  if (bubbleRows.length === 0) {
    checks.push({
      name: "layer4.bubbles",
      status: expectLayer4 ? "FAIL" : "WARN",
      detail: "no bubbleId rows in cursorDiskKV",
    });
  } else {
    checks.push({
      name: "layer4.bubbles",
      status: "OK",
      detail: `${bubbleRows.length} bubble row(s)`,
    });
  }

  if (toolBubbleCount > 0) {
    checks.push({
      name: "layer4.toolBubbles",
      status: "OK",
      detail: `${toolBubbleCount} with toolFormerData`,
    });
  } else if (expectLayer4) {
    checks.push({
      name: "layer4.toolBubbles",
      status: strictLayer4 ? "FAIL" : "WARN",
      detail: "no toolFormerData bubbles (text-only Layer 4)",
    });
  } else {
    checks.push({
      name: "layer4.toolBubbles",
      status: "SKIP",
      detail: "not required for this bundle",
    });
  }

  return checks;
}

export { verifyImportVisibility, type VerifyImportVisibilityOptions };
export { verifyActivationChecks, type VerifyActivationChecksOptions };

export function formatVerifyCheckLine(check: VerifyCheck): string {
  if (check.detail) {
    return `[${check.status}] ${check.name}: ${check.detail}`;
  }
  return `[${check.status}] ${check.name}`;
}

export function formatVerifyReport(
  checks: VerifyCheck[],
  options?: { jsonLines?: boolean }
): string {
  if (options?.jsonLines) {
    return checks
      .map((c) =>
        JSON.stringify({ check: c.name, status: c.status, detail: c.detail })
      )
      .join("\n");
  }
  return checks.map(formatVerifyCheckLine).join("\n");
}

export function verifyChecksAllOk(checks: VerifyCheck[]): boolean {
  return checks.every((c) => c.status !== "FAIL");
}

export interface RunDiskAndActivationVerifyOptions {
  bundle?: ChatBundle | Record<string, unknown> | null;
  postActivate?: boolean;
  expectRichComposerData?: boolean;
  expectStore?: boolean;
  strictLayer4?: boolean;
  deps?: Partial<VerifyIoDeps>;
  pendingPath?: string;
  resultPath?: string;
}

export async function runDiskAndActivationVerify(
  conversationId: string,
  workspaceContext: WorkspaceContext | null,
  options: RunDiskAndActivationVerifyOptions = {}
): Promise<VerifyCheck[]> {
  const bundle = options.bundle;
  let expectRich = options.expectRichComposerData;
  let expectStore = options.expectStore;
  let expectLayer4: boolean | undefined;
  if (bundle != null) {
    if (expectRich === undefined) {
      expectRich = sidebarSnapshotHasComposerData(bundle, conversationId);
    }
    if (expectStore === undefined) {
      const snap = (bundle as Record<string, unknown>).storeSnapshot;
      expectStore =
        !!snap &&
        typeof snap === "object" &&
        !Array.isArray(snap) &&
        !!(snap as Record<string, unknown>).content;
    }
    expectLayer4 = bundleHasNativeDiskKv(bundle);
  }
  const checks = await verifyImportVisibility(conversationId, workspaceContext, {
    expectRichComposerData: expectRich ?? false,
    expectStore: expectStore ?? false,
    expectLayer4: expectLayer4 ?? false,
    strictLayer4: options.strictLayer4 ?? false,
    deps: options.deps,
  });
  if (options.postActivate) {
    const activation = await verifyActivationChecks(conversationId, {
      deps: options.deps,
      pendingPath: options.pendingPath,
      resultPath: options.resultPath,
    });
    checks.push(...activation);
  }
  return checks;
}
