import * as vscode from "vscode";
import { t } from "./sidebar/i18n.js";
import { escapeHtml } from "./sidebar/sync-tab.js";
import {
  listStatusPreviewEntries,
  type StatusPreviewKind,
} from "./status-preview.js";
import {
  openSyncKeyFile,
  syncKeyChangeLabel,
  type SyncKeyPreviewEntry,
} from "./sync-key-picker.js";

export type StatusPreviewBody =
  | { kind: "loading" }
  | { kind: "list"; entries: readonly SyncKeyPreviewEntry[] }
  | { kind: "empty" }
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
    if (entry.change === "added") {
      counts.added += 1;
    } else if (entry.change === "removed") {
      counts.removed += 1;
    } else if (entry.change === "incoming") {
      counts.incoming += 1;
    } else {
      counts.modified += 1;
    }
  }
  return counts;
}

function countChip(label: string, tone: string): string {
  return `<li class="preview-count preview-count-${tone}">${escapeHtml(label)}</li>`;
}

export function renderPreviewCounts(
  entries: readonly SyncKeyPreviewEntry[]
): string {
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

type PanelSession = {
  panel: vscode.WebviewPanel;
  kind: StatusPreviewKind;
  generation: number;
  loading: boolean;
  context: vscode.ExtensionContext;
};

let session: PanelSession | undefined;

export function __resetStatusPreviewPanelForTests(): void {
  session = undefined;
}

function headingFor(kind: StatusPreviewKind): string {
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

function previewTitle(kind: StatusPreviewKind, count: number): string {
  return `${headingFor(kind)} · ${t("historyFiles", { n: count })}`;
}

function renderBody(body: StatusPreviewBody): string {
  if (body.kind === "loading") {
    return `<div class="preview-loading" role="status">
      <span class="preview-spinner" aria-hidden="true"></span>
      <p>${escapeHtml(t("statusPreviewLoading"))}</p>
    </div>`;
  }
  if (body.kind === "empty") {
    return `<p class="preview-empty">${escapeHtml(t("statusPreviewEmpty"))}</p>`;
  }
  if (body.kind === "error") {
    return `<p class="preview-error">${escapeHtml(
      t("statusPreviewFailed", { error: body.error })
    )}</p>`;
  }
  const rows = body.entries
    .map((entry) => {
      const change = syncKeyChangeLabel(entry.change);
      return `<div class="preview-row" data-sync-key="${escapeHtml(entry.syncKey)}" role="button" tabindex="0">
        <span class="preview-path">${escapeHtml(entry.syncKey)}</span>
        ${change ? `<span class="preview-change">${escapeHtml(change)}</span>` : ""}
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
      <h1>${escapeHtml(options.heading)}</h1>
      <button type="button" class="preview-refresh" data-command="refresh"${
        options.body.kind === "loading" ? " disabled" : ""
      } title="${escapeHtml(t("statusPreviewRefreshHint"))}">${escapeHtml(t("statusPreviewRefresh"))}</button>
    </div>
    <p class="preview-subtitle">${escapeHtml(t("statusPreviewPlaceholder"))}</p>
    ${options.body.kind === "list" ? renderPreviewCounts(options.body.entries) : ""}
  </header>
  <main class="preview-main">${renderBody(options.body)}</main>
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

function assignHtml(current: PanelSession, body: StatusPreviewBody): void {
  const { cssUri, jsUri, csp } = resourceUris(current.panel, current.context);
  current.panel.webview.html = renderStatusPreviewHtml({
    heading: headingFor(current.kind),
    body,
    cssUri,
    jsUri,
    csp,
  });
}

async function reloadCurrent(current: PanelSession): Promise<void> {
  if (session !== current || current.loading) {
    return;
  }
  current.generation += 1;
  current.loading = true;
  current.panel.title = headingFor(current.kind);
  assignHtml(current, { kind: "loading" });
  await fetchKind(current, current.generation, current.kind);
}

function wirePanel(current: PanelSession): void {
  current.panel.webview.onDidReceiveMessage((raw: unknown) => {
    if (!raw || typeof raw !== "object") {
      return;
    }
    const msg = raw as { type?: string; syncKey?: string };
    if (msg.type === "open" && typeof msg.syncKey === "string") {
      void openSyncKeyFile(msg.syncKey);
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

async function fetchKind(
  current: PanelSession,
  generation: number,
  kind: StatusPreviewKind
): Promise<void> {
  try {
    const entries = await listStatusPreviewEntries(current.context, kind);
    if (session !== current || current.generation !== generation) {
      return;
    }
    current.loading = false;
    current.panel.title = previewTitle(kind, entries.length);
    if (entries.length === 0) {
      assignHtml(current, { kind: "empty" });
      return;
    }
    assignHtml(current, { kind: "list", entries });
  } catch (err) {
    if (session !== current || current.generation !== generation) {
      return;
    }
    current.loading = false;
    const error = err instanceof Error ? err.message : String(err);
    assignHtml(current, { kind: "error", error });
  }
}

export async function openStatusPreviewPanel(
  context: vscode.ExtensionContext,
  kind: StatusPreviewKind
): Promise<void> {
  if (session) {
    session.panel.reveal(vscode.ViewColumn.Beside);
    if (session.kind === kind) {
      return;
    }
    session.kind = kind;
    session.generation += 1;
    session.loading = true;
    session.panel.title = headingFor(kind);
    assignHtml(session, { kind: "loading" });
    await fetchKind(session, session.generation, kind);
    return;
  }

  const panel = vscode.window.createWebviewPanel(
    "cursorSync.statusPreview",
    headingFor(kind),
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
    kind,
    generation: 1,
    loading: true,
    context,
  };
  session = current;
  wirePanel(current);
  assignHtml(current, { kind: "loading" });
  await fetchKind(current, current.generation, kind);
}
