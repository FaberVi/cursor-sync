import * as vscode from "vscode";
import { t } from "./sidebar/i18n.js";
import { escapeHtml } from "./sidebar/sync-tab.js";
import {
  listStatusPreviewEntries,
  type StatusPreviewKind,
} from "./status-preview.js";
import { loadSyncHistory } from "./diagnostics.js";
import {
  openSyncKeyFile,
  syncKeyChangeLabel,
  syncKeyChangeTone,
  type SyncKeyPreviewEntry,
} from "./sync-key-picker.js";
import type { SyncHistoryEntry } from "./types.js";

export type StatusPreviewBody =
  | { kind: "loading" }
  | { kind: "list"; entries: readonly SyncKeyPreviewEntry[] }
  | { kind: "empty"; message?: string }
  | { kind: "error"; error: string };

export type PreviewChangeCounts = {
  added: number;
  modified: number;
  removed: number;
  incoming: number;
};

export function countPreviewChanges(
  entries: readonly SyncKeyPreviewEntry[]
): PreviewChangeCounts {
  const counts: PreviewChangeCounts = {
    added: 0,
    modified: 0,
    removed: 0,
    incoming: 0,
  };
  for (const entry of entries) {
    if (entry.change === "added" || entry.change === "created") {
      counts.added += 1;
    } else if (entry.change === "removed" || entry.change === "deleted") {
      counts.removed += 1;
    } else if (entry.change === "incoming") {
      counts.incoming += 1;
    } else if (entry.change === "modified" || entry.change === "updated") {
      counts.modified += 1;
    }
  }
  return counts;
}

function countChip(label: string, tone: string): string {
  return `<li class="preview-count preview-count-${tone}">${escapeHtml(label)}</li>`;
}

function isHistoryAction(change: SyncKeyPreviewEntry["change"]): boolean {
  return change === "created" || change === "updated" || change === "deleted";
}

export function historyPreviewEntries(entry: SyncHistoryEntry): SyncKeyPreviewEntry[] {
  if (entry.operations && entry.operations.length > 0) {
    return entry.operations.map((operation) => ({
      syncKey: operation.syncKey,
      change: operation.action,
    }));
  }
  return (entry.files ?? []).map((syncKey) => ({ syncKey }));
}

export function renderPreviewCounts(
  entries: readonly SyncKeyPreviewEntry[]
): string {
  if (entries.some((entry) => isHistoryAction(entry.change))) {
    const created = entries.filter((entry) => entry.change === "created").length;
    const updated = entries.filter((entry) => entry.change === "updated").length;
    const deleted = entries.filter((entry) => entry.change === "deleted").length;
    const chips: string[] = [];
    if (updated > 0) {
      chips.push(countChip(t("historyCountUpdated", { n: updated }), "incoming"));
    }
    if (created > 0) {
      chips.push(countChip(t("historyCountCreated", { n: created }), "added"));
    }
    if (deleted > 0) {
      chips.push(countChip(t("historyCountDeleted", { n: deleted }), "removed"));
    }
    if (chips.length === 0) {
      return "";
    }
    return `<ul class="preview-counts" aria-label="${escapeHtml(t("statusPreviewCountsLabel"))}">${chips.join("")}</ul>`;
  }
  const counts = countPreviewChanges(entries);
  const chips: string[] = [];
  const hasLocalKinds = counts.added + counts.modified + counts.removed > 0;
  if (hasLocalKinds) {
    chips.push(
      countChip(t("statusPreviewCountModified", { n: counts.modified }), "modified")
    );
    chips.push(
      countChip(t("statusPreviewCountAdded", { n: counts.added }), "added")
    );
    chips.push(
      countChip(t("statusPreviewCountRemoved", { n: counts.removed }), "removed")
    );
  }
  if (counts.incoming > 0) {
    chips.push(
      countChip(t("statusPreviewCountIncoming", { n: counts.incoming }), "incoming")
    );
  }
  if (chips.length === 0) {
    return "";
  }
  return `<ul class="preview-counts" aria-label="${escapeHtml(t("statusPreviewCountsLabel"))}">${chips.join("")}</ul>`;
}

type PanelSource =
  | { type: "status"; kind: StatusPreviewKind }
  | { type: "history"; timestamp: string };

type PanelSession = {
  panel: vscode.WebviewPanel;
  source: PanelSource;
  generation: number;
  loading: boolean;
  context: vscode.ExtensionContext;
  /** True after the webview script is listening, so later paints do not reload the page. */
  webviewReady: boolean;
};

type LoadedPanel = {
  heading: string;
  title: string;
  entries: SyncKeyPreviewEntry[];
  emptyMessage?: string;
};

let session: PanelSession | undefined;

export function __resetStatusPreviewPanelForTests(): void {
  session = undefined;
}

function sourcesMatch(left: PanelSource, right: PanelSource): boolean {
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "status" && right.type === "status") {
    return left.kind === right.kind;
  }
  if (left.type === "history" && right.type === "history") {
    return left.timestamp === right.timestamp;
  }
  return false;
}

function statusHeading(kind: StatusPreviewKind): string {
  if (kind === "incoming") {
    return t("statusPreviewIncomingTitle");
  }
  if (kind === "localOnly") {
    return t("statusPreviewLocalOnlyTitle");
  }
  if (kind === "diverged") {
    return t("statusPreviewDivergedTitle");
  }
  return t("statusPreviewLocalTitle");
}

function headingFor(source: PanelSource): string {
  if (source.type === "history") {
    return t("history");
  }
  return statusHeading(source.kind);
}

function historyCountLabel(entry: SyncHistoryEntry, fileCount: number): string {
  return typeof entry.totalFileCount === "number" && entry.totalFileCount > 0
    ? t("historyFilesCountRatio", { changed: fileCount, total: entry.totalFileCount })
    : t("historyFiles", { n: fileCount });
}

function historyHeading(entry: SyncHistoryEntry, fileCount: number): string {
  const dirLabel = entry.direction === "push" ? t("push") : t("pull");
  return `${dirLabel} · ${historyCountLabel(entry, fileCount)}`;
}

function renderBody(body: StatusPreviewBody): string {
  if (body.kind === "loading") {
    return `<div class="preview-loading" role="status">
      <span class="preview-spinner" aria-hidden="true"></span>
      <p>${escapeHtml(t("statusPreviewLoading"))}</p>
    </div>`;
  }
  if (body.kind === "empty") {
    return `<p class="preview-empty">${escapeHtml(body.message ?? t("statusPreviewEmpty"))}</p>`;
  }
  if (body.kind === "error") {
    return `<p class="preview-error">${escapeHtml(
      t("statusPreviewFailed", { error: body.error })
    )}</p>`;
  }
  const rows = body.entries
    .map((entry) => {
      const change = syncKeyChangeLabel(entry.change);
      const tone = syncKeyChangeTone(entry.change);
      const changeClass =
        change && tone
          ? `preview-change preview-change-${tone}`
          : "preview-change";
      return `<div class="preview-row" data-sync-key="${escapeHtml(entry.syncKey)}" role="button" tabindex="0">
        <span class="preview-path">${escapeHtml(entry.syncKey)}</span>
        ${change ? `<span class="${changeClass}">${escapeHtml(change)}</span>` : ""}
      </div>`;
    })
    .join("");
  return `<div class="preview-list" id="preview-list">${rows}</div>`;
}

export function renderStatusPreviewHtml(options: {
  heading: string;
  body: StatusPreviewBody;
  cssUri: string;
  jsUri: string;
  csp: string;
}): string {
  const lang = escapeHtml(vscode.env.language || "en");
  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${options.csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${options.cssUri}">
</head>
<body>
  <header class="preview-header">
    <div class="preview-heading-row">
      <h1 id="preview-heading">${escapeHtml(options.heading)}</h1>
      <button type="button" id="preview-refresh" class="preview-refresh" data-command="refresh"${
        options.body.kind === "loading" ? " disabled" : ""
      } title="${escapeHtml(t("statusPreviewRefreshHint"))}">${escapeHtml(t("statusPreviewRefresh"))}</button>
    </div>
    <p class="preview-subtitle">${escapeHtml(t("statusPreviewPlaceholder"))}</p>
    <div id="preview-counts">${
      options.body.kind === "list" ? renderPreviewCounts(options.body.entries) : ""
    }</div>
  </header>
  <main id="preview-main" class="preview-main">${renderBody(options.body)}</main>
  <script src="${options.jsUri}"></script>
</body>
</html>`;
}

function resourceUris(
  panel: vscode.WebviewPanel,
  context: vscode.ExtensionContext
): { cssUri: string; jsUri: string; csp: string } {
  const root = vscode.Uri.joinPath(
    context.extensionUri,
    "resources",
    "status-preview"
  );
  const cssUri = panel.webview
    .asWebviewUri(vscode.Uri.joinPath(root, "webview.css"))
    .toString();
  const jsUri = panel.webview
    .asWebviewUri(vscode.Uri.joinPath(root, "webview.js"))
    .toString();
  const csp = [
    `default-src 'none'`,
    `style-src ${panel.webview.cspSource}`,
    `script-src ${panel.webview.cspSource}`,
  ].join("; ");
  return { cssUri, jsUri, csp };
}

function assignHtml(
  current: PanelSession,
  body: StatusPreviewBody,
  heading?: string
): void {
  const resolvedHeading = heading ?? headingFor(current.source);
  if (current.webviewReady) {
    void current.panel.webview.postMessage({
      type: "render",
      heading: resolvedHeading,
      countsHtml: body.kind === "list" ? renderPreviewCounts(body.entries) : "",
      bodyHtml: renderBody(body),
      refreshDisabled: body.kind === "loading",
    });
    return;
  }
  const { cssUri, jsUri, csp } = resourceUris(current.panel, current.context);
  current.panel.webview.html = renderStatusPreviewHtml({
    heading: resolvedHeading,
    body,
    cssUri,
    jsUri,
    csp,
  });
}

async function loadPanel(current: PanelSession): Promise<LoadedPanel> {
  const source = current.source;
  if (source.type === "history") {
    const history = await loadSyncHistory(current.context);
    const entry = history.find((item) => item.timestamp === source.timestamp);
    if (!entry) {
      throw new Error(t("historyEntryNotFound"));
    }
    const entries = historyPreviewEntries(entry);
    const heading = historyHeading(entry, entries.length);
    return {
      heading,
      title: heading,
      entries,
      emptyMessage: t("historyNoFileListRecorded"),
    };
  }
  const entries = await listStatusPreviewEntries(current.context, source.kind);
  const heading = statusHeading(source.kind);
  return {
    heading,
    title: `${heading} · ${t("historyFiles", { n: entries.length })}`,
    entries,
  };
}

async function reloadCurrent(current: PanelSession): Promise<void> {
  if (session !== current || current.loading) {
    return;
  }
  current.generation += 1;
  current.loading = true;
  current.panel.title = headingFor(current.source);
  assignHtml(current, { kind: "loading" });
  await fetchSource(current, current.generation);
}

function wirePanel(current: PanelSession): void {
  current.panel.webview.onDidReceiveMessage((raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const msg = raw as { type?: string; syncKey?: string };
    if (msg.type === "ready") {
      current.webviewReady = true;
      return;
    }
    if (msg.type === "open" && typeof msg.syncKey === "string") {
      void openSyncKeyFile(msg.syncKey, current.context);
      return;
    }
    if (msg.type === "refresh") {
      return reloadCurrent(current);
    }
  });
  current.panel.onDidDispose(() => {
    if (session === current) {
      session = undefined;
    }
  });
}

async function fetchSource(current: PanelSession, generation: number): Promise<void> {
  try {
    const loaded = await loadPanel(current);
    if (session !== current || current.generation !== generation) {
      return;
    }
    current.loading = false;
    current.panel.title = loaded.title;
    if (loaded.entries.length === 0) {
      assignHtml(current, { kind: "empty", message: loaded.emptyMessage }, loaded.heading);
      return;
    }
    assignHtml(current, { kind: "list", entries: loaded.entries }, loaded.heading);
  } catch (err) {
    if (session !== current || current.generation !== generation) {
      return;
    }
    current.loading = false;
    const error = err instanceof Error ? err.message : String(err);
    assignHtml(current, { kind: "error", error });
  }
}

async function openPanel(
  context: vscode.ExtensionContext,
  source: PanelSource
): Promise<void> {
  if (session) {
    session.panel.reveal(vscode.ViewColumn.Beside);
    if (sourcesMatch(session.source, source)) {
      return;
    }
    session.source = source;
    session.generation += 1;
    session.loading = true;
    session.panel.title = headingFor(source);
    assignHtml(session, { kind: "loading" });
    await fetchSource(session, session.generation);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "cursorSync.statusPreview",
    headingFor(source),
    vscode.ViewColumn.Beside,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, "resources", "status-preview"),
      ],
    }
  );
  const current: PanelSession = {
    panel,
    source,
    generation: 1,
    loading: true,
    context,
    webviewReady: false,
  };
  session = current;
  wirePanel(current);
  assignHtml(current, { kind: "loading" });
  await fetchSource(current, current.generation);
}

export async function openStatusPreviewPanel(
  context: vscode.ExtensionContext,
  kind: StatusPreviewKind
): Promise<void> {
  await openPanel(context, { type: "status", kind });
}

/** Show one history entry's files in the shared file-list panel. */
export async function openHistoryFilesPanel(
  context: vscode.ExtensionContext,
  timestamp: string
): Promise<void> {
  const history = await loadSyncHistory(context);
  if (!history.some((entry) => entry.timestamp === timestamp)) {
    void vscode.window.showWarningMessage(t("historyEntryNotFound"));
    return;
  }
  await openPanel(context, { type: "history", timestamp });
}
