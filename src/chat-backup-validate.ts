import * as path from "node:path";
import * as vscode from "vscode";
import {
  summarizeDiscoveredBackupTier,
  type BackupTier,
} from "./chat-backup-eligibility.js";
import { discoverBackupEligibleConversations } from "./chat-discovery.js";
import { probeLocalDiskKv } from "./chat-disk-kv-export.js";
import { getLogger } from "./diagnostics.js";
import {
  findStoreDbForConversation,
  findWorkspaceKeysForConversation,
  resolveChatsRoot,
} from "./transcripts-cursor-paths.js";

export interface ChatBackupValidationRow {
  conversationId: string;
  titleHint: string;
  projectKey: string;
  workspaceKey: string;
  tier: BackupTier;
  tierDetail: string;
  warnings: string[];
  storePath: string | null;
  workspaceKeysOnDisk: string[];
}

export async function validateLocalChatBackups(options?: {
  probeDiskKv?: boolean;
}): Promise<ChatBackupValidationRow[]> {
  const probeDiskKv = options?.probeDiskKv !== false;
  const discovered = await discoverBackupEligibleConversations();
  const rows: ChatBackupValidationRow[] = [];

  for (const item of discovered) {
    const diskKv = probeDiskKv ? await probeLocalDiskKv(item.conversationId, { retries: 3 }) : null;
    const tierSummary = summarizeDiscoveredBackupTier(
      {
        ...item,
        subagentJsonlCount: item.subagentJsonlCount,
      },
      diskKv
    );
    const storeHit = await findStoreDbForConversation(item.conversationId);
    const workspaceKeysOnDisk = await findWorkspaceKeysForConversation(item.conversationId);
    const storePath =
      storeHit?.absolutePath ??
      (item.workspaceKey
        ? path.join(resolveChatsRoot(), item.workspaceKey, item.conversationId, "store.db")
        : null);

    rows.push({
      conversationId: item.conversationId,
      titleHint: item.conversationId.slice(0, 8),
      projectKey: item.projectKey ?? "",
      workspaceKey: item.workspaceKey,
      tier: tierSummary.tier,
      tierDetail: tierSummary.detail,
      warnings: tierSummary.warnings,
      storePath: storeHit?.absolutePath ?? (item.hasStore ? storePath : null),
      workspaceKeysOnDisk,
    });
  }

  rows.sort((a, b) => {
    const tierOrder: Record<BackupTier, number> = {
      archive: 0,
      partial: 1,
      resume: 2,
      full: 3,
    };
    const byTier = tierOrder[a.tier] - tierOrder[b.tier];
    if (byTier !== 0) {
      return byTier;
    }
    return a.conversationId.localeCompare(b.conversationId);
  });

  return rows;
}

function formatValidationReport(rows: ChatBackupValidationRow[]): string {
  const lines: string[] = [
    `Chat backup validation — ${rows.length} eligible conversation(s)`,
    "",
  ];
  const tierCounts = { full: 0, resume: 0, partial: 0, archive: 0 };
  for (const row of rows) {
    tierCounts[row.tier] += 1;
  }
  lines.push(
    `Tiers: full=${tierCounts.full} resume=${tierCounts.resume} partial=${tierCounts.partial} archive=${tierCounts.archive}`,
    ""
  );

  for (const row of rows) {
    lines.push(`[${row.tier}] ${row.conversationId}`);
    lines.push(`  ${row.tierDetail}`);
    if (row.projectKey) {
      lines.push(`  project: ${row.projectKey}`);
    }
    if (row.workspaceKey) {
      lines.push(`  chats workspace key: ${row.workspaceKey}`);
    }
    if (row.workspaceKeysOnDisk.length > 0) {
      lines.push(`  store keys on disk: ${row.workspaceKeysOnDisk.join(", ")}`);
    }
    if (row.storePath) {
      lines.push(`  store.db: ${row.storePath}`);
    } else if (row.tier !== "archive") {
      lines.push("  store.db: missing on disk");
    }
    for (const w of row.warnings) {
      lines.push(`  warning: ${w}`);
    }
    lines.push("");
  }

  const actionable = rows.filter((r) => r.tier === "archive" || r.tier === "partial");
  if (actionable.length > 0) {
    lines.push(
      "Tip: open transcript-only chats in Composer on this machine, then re-run validation before sync."
    );
  }

  return lines.join("\n");
}

export async function executeValidateChatBackups(
  _context: vscode.ExtensionContext
): Promise<void> {
  const logger = getLogger();
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Cursor Sync: validating chat backups",
      cancellable: false,
    },
    async () => {
      const rows = await validateLocalChatBackups({ probeDiskKv: true });
      const report = formatValidationReport(rows);
      logger.appendLine(`[${new Date().toISOString()}] [chat-backup-validate]\n${report}`);
      logger.show();

      if (rows.length === 0) {
        vscode.window.showInformationMessage(
          "No backup-eligible chats found (need store.db and/or transcript JSONL)."
        );
        return;
      }

      const archiveCount = rows.filter((r) => r.tier === "archive").length;
      const partialCount = rows.filter((r) => r.tier === "partial").length;
      const fullCount = rows.filter((r) => r.tier === "full").length;

      let summary = `${rows.length} chat(s): ${fullCount} full, ${rows.length - fullCount - archiveCount - partialCount} resumable`;
      if (partialCount > 0) {
        summary += `, ${partialCount} partial`;
      }
      if (archiveCount > 0) {
        summary += `, ${archiveCount} archive-only`;
      }
      summary += ". See Output → Cursor Sync for details.";

      if (archiveCount > 0 || partialCount > 0) {
        vscode.window.showWarningMessage(summary);
      } else {
        vscode.window.showInformationMessage(summary);
      }
    }
  );
}
