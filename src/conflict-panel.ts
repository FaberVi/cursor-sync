import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { t } from "./sidebar/i18n.js";
import { escapeHtml } from "./sidebar/sync-tab.js";
import { resolveSyncRoots } from "./paths.js";
import { syncKeyToAbsolutePath } from "./sync-local-deletes.js";
import { cloneAbsForSyncKey } from "./sync-copy.js";
import {
  allConflictsResolved,
  conflictDisplayPath,
} from "./sync-conflicts.js";
import {
  getSyncAbortSignal,
  requestSyncCancel,
} from "./sync-abort.js";
import {
  beginSyncChoiceUi,
  endSyncChoiceUi,
} from "./sync-progress-events.js";
import type {
  ConflictEntry,
  ConflictKind,
  ConflictResolution,
  ResolvedConflict,
} from "./types.js";

export const CONFLICT_PREVIEW_MAX_BYTES = 200 * 1024;

export type ConflictPreview = {
  localText: string;
  remoteText: string;
  unified: string;
  binary: boolean;
};

type PanelSession = {
  panel: vscode.WebviewPanel;
  conflicts: ConflictEntry[];
  clonePath: string;
  basePath: string;
  resolutions: Record<string, ConflictResolution | undefined>;
  selectedKey: string | undefined;
  finish: (result: ResolvedConflict[] | undefined) => void;
  settled: boolean;
};

let session: PanelSession | undefined;

export function getPendingConflictCount(): number {
  return session?.conflicts.length ?? 0;
}

export function revealConflictPanel(): void {
  session?.panel.reveal(vscode.ViewColumn.Active);
}

export function __resetConflictPanelForTests(): void {
  session = undefined;
}

export function renderConflictPanelHtml(options: {
  conflicts: ConflictEntry[];
  resolutions: Record<string, ConflictResolution | undefined>;
  selectedKey: string | undefined;
  preview: ConflictPreview | undefined;
  cssUri: string;
  jsUri: string;
  csp: string;
}): string {
  const { conflicts, resolutions, selectedKey, preview, cssUri, jsUri, csp } =
    options;
  const chosen = conflicts.filter((row) => {
    const r = resolutions[row.relativeSyncKey];
    return r === "keepLocal" || r === "keepRemote";
  }).length;
  const canApply = allConflictsResolved(conflicts, resolutions);
  const selected = conflicts.find((row) => row.relativeSyncKey === selectedKey);

  const rows = conflicts
    .map((row) => {
      const res = resolutions[row.relativeSyncKey];
      const active = row.relativeSyncKey === selectedKey ? " is-selected" : "";
      const localPressed = res === "keepLocal" ? "true" : "false";
      const remotePressed = res === "keepRemote" ? "true" : "false";
      return `<div class="conflict-row${active}" data-key="${escapeHtml(row.relativeSyncKey)}" role="button" tabindex="0">
        <span class="conflict-path">${escapeHtml(conflictDisplayPath(row.relativeSyncKey))}</span>
        <span class="conflict-kind">${escapeHtml(kindLabel(row.kind))}</span>
        <span class="conflict-picks">
          <button type="button" class="pick${res === "keepLocal" ? " is-on" : ""}" data-side="local" aria-pressed="${localPressed}">${escapeHtml(t("keepLocal"))}</button>
          <button type="button" class="pick${res === "keepRemote" ? " is-on" : ""}" data-side="remote" aria-pressed="${remotePressed}">${escapeHtml(t("keepRemote"))}</button>
        </span>
      </div>`;
    })
    .join("");

  const localPane = previewPane(
    preview,
    "local",
    selected ? resolutions[selected.relativeSyncKey] === "keepLocal" : false
  );
  const remotePane = previewPane(
    preview,
    "remote",
    selected ? resolutions[selected.relativeSyncKey] === "keepRemote" : false
  );

  return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language || "en")}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <header class="conflict-header">
    <div>
      <h1>${escapeHtml(t("conflictPanelTitle"))}</h1>
      <p class="resolved">${escapeHtml(t("resolvedCount", { k: chosen, n: conflicts.length }))}</p>
    </div>
    <div class="header-actions">
      <button type="button" id="keep-all-local">${escapeHtml(t("keepAllLocal"))}</button>
      <button type="button" id="keep-all-remote">${escapeHtml(t("keepAllRemote"))}</button>
    </div>
  </header>
  <main class="conflict-layout">
    <aside class="conflict-list" id="conflict-list">${rows}</aside>
    <section class="conflict-preview">
      ${
        selected
          ? `<div class="preview-grid">
        <article class="preview-col${resolutions[selected.relativeSyncKey] === "keepLocal" ? " is-chosen" : ""}">
          <h2>${escapeHtml(t("thisMachine"))}</h2>
          ${localPane}
        </article>
        <article class="preview-col${resolutions[selected.relativeSyncKey] === "keepRemote" ? " is-chosen" : ""}">
          <h2>${escapeHtml(t("repository"))}</h2>
          ${remotePane}
        </article>
      </div>
      <pre class="unified-diff">${preview && !preview.binary ? escapeHtml(preview.unified) : ""}</pre>`
          : `<p class="empty-preview">${escapeHtml(t("selectConflictFile"))}</p>`
      }
    </section>
  </main>
  <footer class="conflict-footer">
    <button type="button" id="cancel-sync">${escapeHtml(t("cancelSync"))}</button>
    <button type="button" id="apply" ${canApply ? "" : "disabled"}>${escapeHtml(t("applyConflicts"))}</button>
  </footer>
  <script src="${jsUri}"></script>
</body>
</html>`;
}

function kindLabel(kind: ConflictKind): string {
  if (kind === "deletedRemote") {
    return t("conflictDeletedRemote");
  }
  if (kind === "deletedLocal") {
    return t("conflictDeletedLocal");
  }
  return t("conflictBothModified");
}

function previewPane(
  preview: ConflictPreview | undefined,
  side: "local" | "remote",
  chosen: boolean
): string {
  void chosen;
  if (!preview) {
    return `<pre class="file-body">${escapeHtml(t("fileMissing"))}</pre>`;
  }
  if (preview.binary) {
    return `<p class="file-body">${escapeHtml(t("binaryOrTooLarge"))}</p>`;
  }
  const text = side === "local" ? preview.localText : preview.remoteText;
  if (!text) {
    return `<pre class="file-body">${escapeHtml(t("fileMissing"))}</pre>`;
  }
  return `<pre class="file-body">${escapeHtml(text)}</pre>`;
}

export function unifiedDiff(localText: string, remoteText: string): string {
  const a = localText.split("\n");
  const b = remoteText.split("\n");
  if (a.length > 800 || b.length > 800) {
    return [localText.slice(0, 20_000), "---", remoteText.slice(0, 20_000)].join(
      "\n"
    );
  }
  const n = a.length;
  const m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () =>
    Array<number>(m + 1).fill(0)
  );
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] =
        a[i] === b[j]
          ? (dp[i + 1]![j + 1] ?? 0) + 1
          : Math.max(dp[i + 1]![j] ?? 0, dp[i]![j + 1] ?? 0);
    }
  }
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      lines.push(` ${a[i]}`);
      i++;
      j++;
    } else if ((dp[i + 1]![j] ?? 0) >= (dp[i]![j + 1] ?? 0)) {
      lines.push(`-${a[i]}`);
      i++;
    } else {
      lines.push(`+${b[j]}`);
      j++;
    }
  }
  while (i < n) {
    lines.push(`-${a[i++]}`);
  }
  while (j < m) {
    lines.push(`+${b[j++]}`);
  }
  return lines.join("\n");
}

export async function loadConflictPreview(
  conflict: ConflictEntry,
  clonePath: string,
  basePath: string
): Promise<ConflictPreview> {
  const roots = resolveSyncRoots();
  const localAbs = syncKeyToAbsolutePath(conflict.relativeSyncKey, roots);
  const remoteAbs = cloneAbsForSyncKey(
    clonePath,
    basePath,
    conflict.relativeSyncKey
  );
  const localBuf = localAbs ? await readCapped(localAbs) : undefined;
  const remoteBuf = await readCapped(remoteAbs);
  const binary =
    isBinaryOrTooLarge(localBuf) || isBinaryOrTooLarge(remoteBuf);
  const localText = binary ? "" : decodeUtf8(localBuf);
  const remoteText = binary ? "" : decodeUtf8(remoteBuf);
  return {
    localText,
    remoteText,
    unified: binary ? "" : unifiedDiff(localText, remoteText),
    binary,
  };
}

async function readCapped(abs: string): Promise<Buffer | undefined> {
  try {
    const st = await fs.stat(abs);
    if (st.size > CONFLICT_PREVIEW_MAX_BYTES) {
      return Buffer.from([0]);
    }
    return await fs.readFile(abs);
  } catch {
    return undefined;
  }
}

function isBinaryOrTooLarge(buf: Buffer | undefined): boolean {
  if (!buf) {
    return false;
  }
  if (buf.length === 0) {
    return false;
  }
  if (buf.includes(0)) {
    return true;
  }
  return false;
}

function decodeUtf8(buf: Buffer | undefined): string {
  if (!buf || buf.length === 0) {
    return "";
  }
  return buf.toString("utf8");
}

export async function openConflictPanel(options: {
  context: vscode.ExtensionContext;
  conflicts: ConflictEntry[];
  clonePath: string;
  basePath: string;
}): Promise<ResolvedConflict[] | undefined> {
  if (options.conflicts.length === 0) {
    return [];
  }
  if (session) {
    session.panel.reveal(vscode.ViewColumn.Active);
    return new Promise((resolve) => {
      const prev = session!;
      const original = prev.finish;
      prev.finish = (result) => {
        original(result);
        resolve(result);
      };
    });
  }

  const panel = vscode.window.createWebviewPanel(
    "cursorSync.conflicts",
    t("conflictPanelTitle"),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(options.context.extensionUri, "resources", "conflicts"),
      ],
    }
  );

  return new Promise((resolve) => {
    beginSyncChoiceUi(t("syncConfirmWaitingConflicts"));
    const signal = getSyncAbortSignal();
    let onAbort = (): void => undefined;

    const current: PanelSession = {
      panel,
      conflicts: options.conflicts,
      clonePath: options.clonePath,
      basePath: options.basePath,
      resolutions: {},
      selectedKey: options.conflicts[0]?.relativeSyncKey,
      settled: false,
      finish: (result) => {
        if (current.settled) {
          return;
        }
        current.settled = true;
        signal?.removeEventListener("abort", onAbort);
        session = undefined;
        endSyncChoiceUi();
        resolve(result);
        panel.dispose();
      },
    };
    session = current;
    onAbort = () => current.finish(undefined);
    signal?.addEventListener("abort", onAbort);

    const render = async () => {
      const selected = current.conflicts.find(
        (row) => row.relativeSyncKey === current.selectedKey
      );
      const preview = selected
        ? await loadConflictPreview(
            selected,
            current.clonePath,
            current.basePath
          )
        : undefined;
      const cssUri = panel.webview
        .asWebviewUri(
          vscode.Uri.joinPath(
            options.context.extensionUri,
            "resources",
            "conflicts",
            "webview.css"
          )
        )
        .toString();
      const jsUri = panel.webview
        .asWebviewUri(
          vscode.Uri.joinPath(
            options.context.extensionUri,
            "resources",
            "conflicts",
            "webview.js"
          )
        )
        .toString();
      const csp = [
        `default-src 'none'`,
        `style-src ${panel.webview.cspSource}`,
        `script-src ${panel.webview.cspSource}`,
      ].join("; ");
      panel.webview.html = renderConflictPanelHtml({
        conflicts: current.conflicts,
        resolutions: current.resolutions,
        selectedKey: current.selectedKey,
        preview,
        cssUri,
        jsUri,
        csp,
      });
    };

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== "object") {
        return;
      }
      const msg = raw as { type?: string; key?: string; side?: string };
      if (msg.type === "select" && typeof msg.key === "string") {
        current.selectedKey = msg.key;
        void render();
        return;
      }
      if (msg.type === "choose" && typeof msg.key === "string") {
        current.resolutions[msg.key] =
          msg.side === "remote" ? "keepRemote" : "keepLocal";
        current.selectedKey = msg.key;
        void render();
        return;
      }
      if (msg.type === "keepAll") {
        const resolution: ConflictResolution =
          msg.side === "remote" ? "keepRemote" : "keepLocal";
        for (const row of current.conflicts) {
          current.resolutions[row.relativeSyncKey] = resolution;
        }
        void render();
        return;
      }
      if (msg.type === "apply") {
        if (!allConflictsResolved(current.conflicts, current.resolutions)) {
          return;
        }
        current.finish(
          current.conflicts.map((row) => ({
            relativeSyncKey: row.relativeSyncKey,
            resolution: current.resolutions[row.relativeSyncKey] ?? "skip",
          }))
        );
        return;
      }
      if (msg.type === "cancel") {
        requestSyncCancel();
        current.finish(undefined);
      }
    });

    panel.onDidDispose(() => {
      if (current.settled) {
        return;
      }
      requestSyncCancel();
      current.finish(undefined);
    });

    void render();
    if (signal?.aborted) {
      current.finish(undefined);
    }
  });
}
