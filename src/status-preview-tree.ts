import { t } from "./sidebar/i18n.js";
import { escapeHtml } from "./sidebar/sync-tab.js";
import {
  syncKeyChangeLabel,
  syncKeyChangeTone,
  type SyncKeyPreviewEntry,
} from "./sync-key-picker.js";

type PreviewTreeFile = {
  type: "file";
  entry: SyncKeyPreviewEntry;
};

type PreviewTreeFolder = {
  type: "folder";
  prefix: string;
  name: string;
  children: PreviewTreeNode[];
};

type PreviewTreeNode = PreviewTreeFile | PreviewTreeFolder;

function fileName(syncKey: string): string {
  const slash = syncKey.lastIndexOf("/");
  return slash === -1 ? syncKey : syncKey.slice(slash + 1);
}

function buildPreviewTree(
  entries: readonly SyncKeyPreviewEntry[]
): PreviewTreeFolder {
  const root: PreviewTreeFolder = {
    type: "folder",
    prefix: "",
    name: "",
    children: [],
  };
  for (const entry of entries) {
    const parts = entry.syncKey.split("/");
    let current = root;
    for (let index = 0; index < parts.length - 1; index++) {
      const prefix = parts.slice(0, index + 1).join("/");
      const segment = parts[index] ?? "";
      let child = current.children.find(
        (node): node is PreviewTreeFolder =>
          node.type === "folder" && node.prefix === prefix
      );
      if (!child) {
        child = { type: "folder", prefix, name: segment, children: [] };
        current.children.push(child);
      }
      current = child;
    }
    current.children.push({ type: "file", entry });
  }
  sortTreeChildren(root);
  return root;
}

function sortTreeChildren(folder: PreviewTreeFolder): void {
  for (const child of folder.children) {
    if (child.type === "folder") {
      sortTreeChildren(child);
    }
  }
  folder.children.sort((left, right) => {
    if (left.type !== right.type) {
      return left.type === "folder" ? -1 : 1;
    }
    const leftName = left.type === "folder" ? left.name : fileName(left.entry.syncKey);
    const rightName = right.type === "folder" ? right.name : fileName(right.entry.syncKey);
    return leftName.localeCompare(rightName);
  });
}

function renderNode(node: PreviewTreeNode): string {
  if (node.type === "file") {
    const change = syncKeyChangeLabel(node.entry.change);
    const tone = syncKeyChangeTone(node.entry.change);
    const changeClass =
      change && tone ? `preview-change preview-change-${tone}` : "preview-change";
    const badge = change
      ? `<span class="${changeClass}">${escapeHtml(change)}</span>`
      : "";
    return `<div class="preview-row" data-sync-key="${escapeHtml(node.entry.syncKey)}" role="button" tabindex="0">
        <span class="preview-path">${escapeHtml(fileName(node.entry.syncKey))}</span>
        ${badge}
      </div>`;
  }
  const children = node.children.map((child) => renderNode(child)).join("");
  return `<div class="preview-folder" data-prefix="${escapeHtml(node.prefix)}">
      <div class="preview-folder-head">
        <button type="button" class="folder-toggle" aria-expanded="true" aria-label="${escapeHtml(t("conflictFolderToggle"))}">▾</button>
        <span class="preview-folder-name" title="${escapeHtml(node.prefix)}">${escapeHtml(node.name)}/</span>
      </div>
      <div class="preview-folder-children">${children}</div>
    </div>`;
}

/** HTML for the status-preview file list, grouped by sync-key folders. */
export function renderStatusPreviewTree(
  entries: readonly SyncKeyPreviewEntry[]
): string {
  const root = buildPreviewTree(entries);
  const children = root.children.map((child) => renderNode(child)).join("");
  return `<div class="preview-list" id="preview-list">${children}</div>`;
}
