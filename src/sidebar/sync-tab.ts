import type { SyncHistoryEntry } from "../types.js";
import { formatRelativeTime, t } from "./i18n.js";

/** Visible sync-history rows per page in the sidebar. */
export const HISTORY_PAGE_SIZE = 5;

export interface SyncTabState {
  status: "synced" | "not-synced" | "syncing" | "error" | "loading";
  lastSyncTime: string | undefined;
  lastSyncDirection: "push" | "pull" | undefined;
  fileCount: number;
  /** Human-readable remote destination (owner/repo@branch). */
  remoteLabel: string | undefined;
  remoteUrl: string | undefined;
  /** Active remote kind for the status badge. */
  destinationKind: "repo" | undefined;
  /** Extension package version (e.g. 0.10.0). */
  extensionVersion: string;
  history: SyncHistoryEntry[];
  /** True while sync history is still being loaded (startup shell). */
  historyLoading?: boolean;
  chatsSyncEnabled: boolean;
  localChatCount: number;
  remoteChatCount: number | undefined;
  /** True while local/remote chat counts are still being computed. */
  chatCountsLoading?: boolean;
}

export function relativeTime(isoString: string): string {
  return formatRelativeTime(isoString);
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const HISTORY_DELETE_ICON = `<svg class="history-delete-icon" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="M10 2h1a1 1 0 0 1 1 1v1h2.5a.5.5 0 0 1 0 1H12.2l-.72 9.67A1.5 1.5 0 0 1 9.99 15H6.01a1.5 1.5 0 0 1-1.49-1.33L3.8 5H2.5a.5.5 0 0 1 0-1H5V3a1 1 0 0 1 1-1h1V1.5A1.5 1.5 0 0 1 8.5 0h-1A1.5 1.5 0 0 0 6 1.5V2zm-1 0V1.5a.5.5 0 0 1 .5-.5h1a.5.5 0 0 1 .5.5V2H9zM4.37 14l.7-8.5h6.86l.7 8.5H4.37zM6 6.75a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 6 6.75zm4 0a.75.75 0 0 1 .75.75v4.5a.75.75 0 0 1-1.5 0v-4.5A.75.75 0 0 1 10 6.75z"/></svg>`;

export function historyPageCount(
  totalEntries: number,
  pageSize: number = HISTORY_PAGE_SIZE
): number {
  return Math.max(1, Math.ceil(Math.max(0, totalEntries) / pageSize));
}

export function clampHistoryPage(
  page: number,
  totalEntries: number,
  pageSize: number = HISTORY_PAGE_SIZE
): number {
  const totalPages = historyPageCount(totalEntries, pageSize);
  if (!Number.isFinite(page) || page < 0) {
    return 0;
  }
  if (page >= totalPages) {
    return totalPages - 1;
  }
  return page;
}

export function sliceHistoryPage(
  history: SyncHistoryEntry[],
  page: number,
  pageSize: number = HISTORY_PAGE_SIZE
): SyncHistoryEntry[] {
  const safePage = clampHistoryPage(page, history.length, pageSize);
  const start = safePage * pageSize;
  return history.slice(start, start + pageSize);
}

export function formatHistoryFileDetail(entry: {
  fileCount: number;
  totalFileCount?: number;
  success: boolean;
  error?: string;
}): string {
  if (!entry.success) {
    return escapeHtml(entry.error ?? t("syncFailed"));
  }
  if (
    typeof entry.totalFileCount === "number" &&
    entry.totalFileCount > 0
  ) {
    return escapeHtml(
      t("historyFilesRatio", {
        changed: entry.fileCount,
        total: entry.totalFileCount,
      })
    );
  }
  return escapeHtml(t("historyFiles", { n: entry.fileCount }));
}

export function renderHistoryEntry(entry: SyncHistoryEntry): string {
  const icon = entry.direction === "push" ? "arrow-up" : "arrow-down";
  const dirLabel = entry.direction === "push" ? t("push") : t("pull");
  const triggerBadge = entry.trigger === "scheduled" ? `<span class="badge badge-auto">${escapeHtml(t("auto"))}</span>` : "";
  const statusClass = entry.success ? "success" : "failure";
  const statusDot = `<span class="status-dot ${statusClass}"></span>`;
  const time = relativeTime(entry.timestamp);
  const detail = formatHistoryFileDetail(entry);
  const hasFiles = Array.isArray(entry.files) && entry.files.length > 0;
  const title = hasFiles ? t("historyShowFiles") : t("historyNoFiles");

  return `<div class="history-entry" role="button" tabindex="0" data-command="history:details" data-timestamp="${escapeHtml(entry.timestamp)}" title="${escapeHtml(title)}">
    <div class="history-entry-left">
      ${statusDot}
      <span class="codicon codicon-${icon}"></span>
      <span class="history-dir">${dirLabel}</span>
      ${triggerBadge}
    </div>
    <div class="history-entry-right">
      <span class="history-detail">${detail}</span>
      <span class="history-time">${time}</span>
      <button type="button" class="history-delete-btn" data-command="history:delete" data-timestamp="${escapeHtml(entry.timestamp)}" title="${escapeHtml(t("historyDeleteHint"))}" aria-label="${escapeHtml(t("historyDeleteHint"))}">
        ${HISTORY_DELETE_ICON}
      </button>
      <span class="codicon codicon-chevron-right history-chevron" aria-hidden="true"></span>
    </div>
  </div>`;
}

export function renderHistoryPager(
  totalEntries: number,
  page: number,
  pageSize: number = HISTORY_PAGE_SIZE
): string {
  if (totalEntries <= pageSize) {
    return "";
  }
  const totalPages = historyPageCount(totalEntries, pageSize);
  const safePage = clampHistoryPage(page, totalEntries, pageSize);
  return `<div class="history-pager" data-history-page="${safePage}" data-history-total="${totalEntries}" data-history-page-size="${pageSize}">
    <div class="chats-pager">
      <button type="button" class="pager-btn" data-command="history:prev" title="${escapeHtml(t("prevHint"))}"${
        safePage <= 0 ? " disabled" : ""
      }>${escapeHtml(t("prev"))}</button>
      <span class="pager-label">${safePage + 1} / ${totalPages}</span>
      <button type="button" class="pager-btn" data-command="history:next" title="${escapeHtml(t("nextHint"))}"${
        safePage >= totalPages - 1 ? " disabled" : ""
      }>${escapeHtml(t("next"))}</button>
    </div>
  </div>`;
}

export function renderHistorySection(
  history: SyncHistoryEntry[],
  page: number = 0,
  options: { loading?: boolean } = {}
): string {
  if (options.loading) {
    return `<div class="history-list" data-history-page="0" data-history-page-size="${HISTORY_PAGE_SIZE}">
      <div class="empty-state">${escapeHtml(t("loading"))}</div>
    </div>`;
  }
  if (history.length === 0) {
    return `<div class="history-list" data-history-page="0" data-history-page-size="${HISTORY_PAGE_SIZE}">
      <div class="empty-state">${escapeHtml(t("noHistory"))}</div>
    </div>`;
  }

  const safePage = clampHistoryPage(page, history.length);
  const pageEntries = sliceHistoryPage(history, safePage);

  return `<div class="history-list" data-history-page="${safePage}" data-history-page-size="${HISTORY_PAGE_SIZE}">
      ${pageEntries.map(renderHistoryEntry).join("")}
    </div>
    ${renderHistoryPager(history.length, safePage)}`;
}

export function renderSyncPane(state: SyncTabState, historyPage: number = 0): string {
  const isLoading = state.status === "loading";
  const statusIconMap = {
    synced: "check",
    "not-synced": "warning",
    syncing: "sync~spin",
    loading: "sync~spin",
    error: "error",
  };
  const statusLabelMap = {
    synced: t("synced"),
    "not-synced": t("notSynced"),
    syncing: t("syncing"),
    loading: t("loading"),
    error: t("syncError"),
  };

  const statusIcon = statusIconMap[state.status];
  const statusLabel = statusLabelMap[state.status];
  const lastSyncText = state.lastSyncTime ? relativeTime(state.lastSyncTime) : t("never");
  const directionIcon = state.lastSyncDirection === "push" ? "arrow-up" : state.lastSyncDirection === "pull" ? "arrow-down" : "";
  const directionLabel =
    state.lastSyncDirection === "push"
      ? t("push")
      : state.lastSyncDirection === "pull"
        ? t("pull")
        : "";
  const cursorLogoSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 746.78 746.78">
    <rect fill="transparent" width="746.78" height="746.78"/>
    <g>
      <path class="st0" d="M373.39,373.39l239.25,138.13c-1.47,2.55-3.6,4.72-6.24,6.24l-223.63,129.11c-5.81,3.35-12.97,3.35-18.78,0l-223.63-129.11c-2.64-1.52-4.77-3.7-6.24-6.24l239.25-138.13h.02Z"/>
      <path class="st1" d="M373.39,97.39v276l-239.25,138.13c-1.47-2.55-2.29-5.49-2.29-8.53V243.79c0-6.1,3.25-11.72,8.53-14.77l223.62-129.11c2.91-1.68,6.15-2.52,9.39-2.52h.01s-.01,0-.01,0Z"/>
      <path class="st3" d="M612.64,235.26c-1.47-2.55-3.6-4.72-6.24-6.24l-223.63-129.11c-2.9-1.68-6.14-2.52-9.38-2.52v276l239.25,138.13c1.47-2.55,2.29-5.49,2.29-8.53V243.79c0-3.05-.81-5.97-2.29-8.53h-.01.01Z"/>
      <path class="st4" d="M595.9,244.93c1.36,2.34,1.54,5.34,0,8.01l-217.18,376.15c-1.46,2.55-5.34,1.5-5.34-1.43v-247.87c0-1.98-.53-3.88-1.49-5.55l224-129.33h.01v.02Z"/>
      <path class="st2" d="M595.9,244.93l-224,129.33c-.95-1.66-2.34-3.06-4.06-4.06l-214.65-123.93c-2.55-1.46-1.5-5.34,1.43-5.34h434.34c3.08,0,5.59,1.67,6.93,4.01h.01Z"/>
    </g>
  </svg>`;

  const historyHtml = renderHistorySection(state.history, historyPage, {
    loading: state.historyLoading === true,
  });

  const chatStatusLine = state.chatCountsLoading
    ? `<span class="chat-sync-loading">${escapeHtml(t("loading"))}</span>`
    : state.chatsSyncEnabled
    ? state.remoteChatCount !== undefined
      ? escapeHtml(
          t("chatsInBackup", {
            remote: state.remoteChatCount,
            local: state.localChatCount,
          })
        )
      : escapeHtml(t("chatsLocalNotInBackup", { local: state.localChatCount }))
    : `<span class="chat-sync-disabled">${escapeHtml(t("chatsNotIncluded"))}</span>`;

  return `<div id="sync-pane" class="tab-pane">
  <div class="status-card ${state.status}">
    <div class="status-icon-wrapper">
      ${state.status === "synced" ? cursorLogoSvg : `<span class="codicon codicon-${statusIcon}"></span>`}
    </div>
    <div class="status-info">
      <div class="status-header">
        <span class="status-label">${escapeHtml(statusLabel)}</span>
        <span class="status-version" title="${escapeHtml(t("extensionVersionTitle"))}">v${escapeHtml(state.extensionVersion)}</span>
      </div>
      <div class="status-meta">
        ${
          isLoading
            ? `<span class="status-loading">${escapeHtml(t("loading"))}</span>`
            : `<span>${escapeHtml(lastSyncText)}</span>
        ${directionLabel ? `<span class="codicon codicon-${directionIcon}"></span><span>${escapeHtml(directionLabel)}</span>` : ""}`
        }
      </div>
      ${!isLoading && state.fileCount > 0 ? `<div class="file-count">${state.fileCount} ${state.fileCount !== 1 ? t("filesTracked") : t("fileTracked")}</div>` : ""}
      ${
        !isLoading && (state.remoteLabel || state.destinationKind)
          ? `<div class="remote-row">
        ${
          state.remoteLabel
            ? `<div class="file-count remote-dest">${
                state.remoteUrl
                  ? `<a href="${escapeHtml(state.remoteUrl)}">${escapeHtml(state.remoteLabel)}</a>`
                  : escapeHtml(state.remoteLabel)
              }</div>`
            : `<div class="file-count remote-dest">${escapeHtml(t("notLinked"))}</div>`
        }
        ${
          state.destinationKind
            ? `<span class="dest-badge dest-badge-repo">${escapeHtml(t("destBadgeRepo"))}</span>`
            : ""
        }
      </div>`
          : ""
      }
    </div>
  </div>

  <div class="file-count chat-sync-status">${chatStatusLine}</div>

  ${""}

  <button class="sync-now-btn" data-command="syncNow" title="${escapeHtml(t("syncNowHint"))}">
    <span class="codicon codicon-sync" aria-hidden="true"></span>
    <span class="sync-now-label">${escapeHtml(t("syncNow"))}</span>
  </button>

  <div class="section">
    <div class="section-header">${escapeHtml(t("actions"))}</div>
    <div class="action-grid">
      <button class="action-btn" data-command="push" title="${escapeHtml(t("pushHint"))}"><span class="codicon codicon-cloud-upload"></span> ${escapeHtml(t("push"))}</button>
      <button class="action-btn" data-command="pull" title="${escapeHtml(t("pullHint"))}"><span class="codicon codicon-cloud-download"></span> ${escapeHtml(t("pull"))}</button>
      <button class="action-btn action-btn-secondary" data-command="resetToRemote" title="${escapeHtml(t("resetToRemoteHint"))}"><span class="codicon codicon-discard"></span> ${escapeHtml(t("resetToRemote"))}</button>
      <button class="action-btn action-btn-secondary" data-command="openSyncClone" title="${escapeHtml(t("openSyncCloneHint"))}"><span class="codicon codicon-repo"></span> ${escapeHtml(t("openSyncClone"))}</button>
      <button class="action-btn action-btn-secondary" data-command="openCursorFolder" title="${escapeHtml(t("openCursorFolderHint"))}"><span class="codicon codicon-folder-opened"></span> ${escapeHtml(t("openCursorFolder"))}</button>
    </div>
  </div>

  <div class="section">
    <div class="section-header history-section-header">
      <span>${escapeHtml(t("history"))}</span>
      ${
        state.history.length > 0
          ? `<button type="button" class="clear-btn" data-command="history:clearAll" title="${escapeHtml(t("historyClearHint"))}">${escapeHtml(t("clear"))}</button>`
          : ""
      }
    </div>
    <div id="history-section-body">
    ${historyHtml}
    </div>
    <div id="sync-active-section" class="sync-active-section" style="display:none" aria-live="polite">
      <div id="sync-active"></div>
    </div>
  </div>
</div>`;
}
