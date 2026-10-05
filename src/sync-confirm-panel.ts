import * as vscode from "vscode";
import { t } from "./sidebar/i18n.js";
import { escapeHtml } from "./sidebar/sync-tab.js";
import { conflictDisplayPath } from "./sync-conflicts.js";
import {
  beginSyncChoiceUi,
  endSyncChoiceUi,
} from "./sync-progress-events.js";
import {
  getSyncAbortSignal,
  requestSyncCancel,
} from "./sync-abort.js";
import type { SyncConfirmModel, SyncConfirmMode } from "./pull-confirm.js";

type PanelSession = {
  panel: vscode.WebviewPanel;
  finish: (proceeded: boolean) => void;
  settled: boolean;
};

let session: PanelSession | undefined;

export function __resetSyncConfirmPanelForTests(): void {
  session = undefined;
}

function titleFor(mode: SyncConfirmMode): string {
  if (mode === "pullMirror") {
    return t("syncConfirmTitlePull");
  }
  if (mode === "resetMirror") {
    return t("syncConfirmTitleReset");
  }
  if (mode === "chatsOnly") {
    return t("syncConfirmTitleChatsOnly");
  }
  return t("syncConfirmTitleSyncNow");
}

function subtitleFor(mode: SyncConfirmMode): string {
  if (mode === "pullMirror") {
    return t("syncConfirmSubtitlePull");
  }
  if (mode === "resetMirror") {
    return t("syncConfirmSubtitleReset");
  }
  if (mode === "chatsOnly") {
    return t("syncConfirmSubtitleChatsOnly");
  }
  return t("syncConfirmSubtitleSyncNow");
}

function chip(label: string, tone: string, filter: string): string {
  return `<li><button type="button" class="confirm-chip confirm-chip-${tone}" data-filter="${escapeHtml(filter)}" aria-pressed="false">${escapeHtml(label)}</button></li>`;
}

function renderChips(model: SyncConfirmModel): string {
  const chips: string[] = [];
  if (model.n > 0) {
    chips.push(chip(t("syncConfirmChipUpdate", { n: model.n }), "update", "update"));
  }
  if (model.m > 0) {
    chips.push(chip(t("syncConfirmChipDelete", { n: model.m }), "delete", "delete"));
  }
  if (model.conflictKeys.length > 0) {
    chips.push(
      chip(
        t("syncConfirmChipConflict", { n: model.conflictKeys.length }),
        "conflict",
        "conflict"
      )
    );
  }
  if (model.localOnlyKeys.length > 0) {
    chips.push(
      chip(
        t("syncConfirmChipLocalOnly", { n: model.localOnlyKeys.length }),
        "local",
        "local"
      )
    );
  }
  if (model.intentionalDeletionKeys.length > 0) {
    chips.push(
      chip(
        t("syncConfirmChipKeptDeleted", { n: model.intentionalDeletionKeys.length }),
        "delete",
        "kept-deleted"
      )
    );
  }
  if (chips.length === 0) {
    return "";
  }
  const label = escapeHtml(t("syncConfirmFilterChipsLabel"));
  return `<ul class="confirm-chips" role="toolbar" aria-label="${label}">${chips.join("")}</ul>`;
}

function renderRows(keys: readonly string[], rowClass = "confirm-row"): string {
  const items = keys
    .map((key) => `<li class="${rowClass}">${escapeHtml(conflictDisplayPath(key))}</li>`)
    .join("");
  return `<ul class="confirm-list">${items}</ul>`;
}

function renderSection(
  heading: string,
  body: string,
  sectionFilters: readonly string[]
): string {
  const filters = sectionFilters.map((f) => escapeHtml(f)).join(" ");
  return `<section class="confirm-section" data-section-filters="${filters}"><h2>${escapeHtml(heading)}</h2>${body}</section>`;
}

function localOnlySectionFilters(mode: SyncConfirmMode): readonly string[] {
  if (mode === "pullMirror" || mode === "resetMirror") {
    return ["local", "delete"];
  }
  return ["local"];
}

export function renderSyncConfirmHtml(options: {
  model: SyncConfirmModel;
  cssUri: string;
  jsUri: string;
  csp: string;
}): string {
  const { model, cssUri, jsUri, csp } = options;
  const sections: string[] = [];
  if (model.incoming.subjects.length > 0) {
    const rows = model.incoming.subjects
      .map((subject) => `<li class="confirm-row confirm-row-commit">${escapeHtml(subject)}</li>`)
      .join("");
    sections.push(
      renderSection(
        t("syncConfirmSectionCommits"),
        `<ul class="confirm-list">${rows}</ul>`,
        ["update"]
      )
    );
  }
  if (model.incoming.incomingSyncKeys.length > 0) {
    sections.push(
      renderSection(
        t("syncConfirmSectionIncoming"),
        renderRows(model.incoming.incomingSyncKeys),
        ["update"]
      )
    );
  }
  if (model.localOnlyKeys.length > 0) {
    const kept = model.mode === "syncNow";
    sections.push(
      renderSection(
        t(kept ? "syncConfirmSectionLocalOnlyKept" : "syncConfirmSectionLocalOnlyDeleted"),
        renderRows(model.localOnlyKeys),
        localOnlySectionFilters(model.mode)
      )
    );
  }
  if (model.conflictKeys.length > 0) {
    sections.push(
      renderSection(
        t("syncConfirmSectionConflicts"),
        renderRows(model.conflictKeys),
        ["conflict"]
      )
    );
  }
  if (model.intentionalDeletionKeys.length > 0) {
    sections.push(
      renderSection(
        t("syncConfirmSectionKeptDeleted"),
        renderRows(model.intentionalDeletionKeys),
        ["kept-deleted"]
      )
    );
  }

  return `<!DOCTYPE html>
<html lang="${escapeHtml(vscode.env.language || "en")}">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${cssUri}">
</head>
<body>
  <header class="confirm-header">
    <h1>${escapeHtml(titleFor(model.mode))}</h1>
    <p class="confirm-subtitle">${escapeHtml(subtitleFor(model.mode))}</p>
    ${renderChips(model)}
  </header>
  <main class="confirm-main">${sections.join("")}</main>
  <footer class="confirm-footer">
    <button type="button" id="cancel-sync">${escapeHtml(t("cancel"))}</button>
    <button type="button" id="proceed">${escapeHtml(t("proceed"))}</button>
  </footer>
  <script src="${jsUri}"></script>
</body>
</html>`;
}

export async function openSyncConfirmPanel(options: {
  context: vscode.ExtensionContext;
  model: SyncConfirmModel;
}): Promise<boolean> {
  if (session) {
    session.panel.reveal(vscode.ViewColumn.Active);
    return new Promise((resolve) => {
      const prev = session!;
      const original = prev.finish;
      prev.finish = (proceeded) => {
        original(proceeded);
        resolve(proceeded);
      };
    });
  }

  const panel = vscode.window.createWebviewPanel(
    "cursorSync.syncConfirm",
    titleFor(options.model.mode),
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(options.context.extensionUri, "resources", "sync-confirm"),
      ],
    }
  );

  return new Promise((resolve) => {
    beginSyncChoiceUi(t("syncConfirmWaitingReview"));
    const signal = getSyncAbortSignal();
    let onAbort = (): void => undefined;

    const current: PanelSession = {
      panel,
      settled: false,
      finish: (proceeded) => {
        if (current.settled) {
          return;
        }
        current.settled = true;
        signal?.removeEventListener("abort", onAbort);
        session = undefined;
        endSyncChoiceUi();
        resolve(proceeded);
        panel.dispose();
      },
    };
    session = current;
    onAbort = () => current.finish(false);
    signal?.addEventListener("abort", onAbort);

    const cssUri = panel.webview
      .asWebviewUri(
        vscode.Uri.joinPath(
          options.context.extensionUri,
          "resources",
          "sync-confirm",
          "webview.css"
        )
      )
      .toString();
    const jsUri = panel.webview
      .asWebviewUri(
        vscode.Uri.joinPath(
          options.context.extensionUri,
          "resources",
          "sync-confirm",
          "webview.js"
        )
      )
      .toString();
    const csp = [
      `default-src 'none'`,
      `style-src ${panel.webview.cspSource}`,
      `script-src ${panel.webview.cspSource}`,
    ].join("; ");
    panel.webview.html = renderSyncConfirmHtml({
      model: options.model,
      cssUri,
      jsUri,
      csp,
    });

    panel.webview.onDidReceiveMessage((raw: unknown) => {
      if (!raw || typeof raw !== "object") {
        return;
      }
      const msg = raw as { type?: string };
      if (msg.type === "proceed") {
        current.finish(true);
        return;
      }
      if (msg.type === "cancel") {
        requestSyncCancel();
        current.finish(false);
      }
    });

    panel.onDidDispose(() => {
      if (current.settled) {
        return;
      }
      requestSyncCancel();
      current.finish(false);
    });

    if (signal?.aborted) {
      current.finish(false);
    }
  });
}
