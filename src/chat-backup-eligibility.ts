import type { ChatBundle } from "./chat-persistence.js";
import {
  bundleHasNativeDiskKv,
  summarizeBundleFidelity,
  type ChatBundleFidelitySummary,
} from "./chat-bundle-fidelity.js";

/** Cross-machine backup quality tier. */
export type BackupTier = "full" | "resume" | "partial" | "archive";

export interface LocalDiskKvProbe {
  rowCount: number;
  toolBubbleCount: number;
}

export interface BackupDiscoverable {
  hasStore: boolean;
  jsonlCount: number;
  subagentJsonlCount?: number;
  conversationId?: string;
}

export interface BackupTierSummary {
  tier: BackupTier;
  label: string;
  detail: string;
  warnings: string[];
}

const TIER_LABELS: Record<BackupTier, string> = {
  full: "Full backup",
  resume: "Resumable",
  partial: "Partial",
  archive: "Archive only",
};

export function backupTierLabel(tier: BackupTier): string {
  return TIER_LABELS[tier];
}

export function classifyBundleTier(bundle: ChatBundle): BackupTier {
  const fidelity = summarizeBundleFidelity(bundle);
  const hasStore = Boolean(bundle.storeSnapshot?.content);
  const hasDiskKv = bundleHasNativeDiskKv(bundle);
  const toolBubbles = fidelity.toolBubbleCount;

  if (hasStore && hasDiskKv && toolBubbles > 0) {
    return "full";
  }
  if (hasStore || hasDiskKv) {
    return "resume";
  }
  if (bundle.transcriptFiles && bundle.transcriptFiles.length > 0) {
    if (bundle.sidebarSnapshot) {
      return "resume";
    }
    return "archive";
  }
  return "archive";
}

export function classifyDiscoveredTier(
  item: Pick<BackupDiscoverable, "hasStore" | "jsonlCount">,
  diskKv?: LocalDiskKvProbe | null
): BackupTier {
  const hasJsonl = item.jsonlCount > 0;
  const rowCount = diskKv?.rowCount ?? 0;
  const toolBubbles = diskKv?.toolBubbleCount ?? 0;
  const hasDiskKv = rowCount > 0;

  if (item.hasStore && hasDiskKv && toolBubbles > 0) {
    return "full";
  }
  if (item.hasStore || hasDiskKv) {
    return hasDiskKv && toolBubbles === 0 ? "partial" : "resume";
  }
  if (hasJsonl) {
    return "archive";
  }
  return "archive";
}

export function summarizeDiscoveredBackupTier(
  item: Pick<
    BackupDiscoverable,
    "hasStore" | "jsonlCount" | "subagentJsonlCount" | "conversationId"
  >,
  diskKv?: LocalDiskKvProbe | null
): BackupTierSummary {
  const tier = classifyDiscoveredTier(item, diskKv);
  const warnings: string[] = [];
  const parts = [
    backupTierLabel(tier),
    item.jsonlCount > 0 ? `${item.jsonlCount} jsonl` : "no jsonl",
    item.hasStore ? "store.db" : "no store.db",
  ];
  const subagentCount = item.subagentJsonlCount ?? 0;
  if (subagentCount > 0) {
    parts.push(`${subagentCount} subagent jsonl`);
  }
  if (diskKv && diskKv.rowCount > 0) {
    parts.push(`diskKv ${diskKv.rowCount} rows`);
    parts.push(`${diskKv.toolBubbleCount} tool bubbles`);
  }
  if (tier === "archive") {
    warnings.push(
      "Transcript-only: open in Composer on source machine before sync for tool/MCP fidelity."
    );
  } else if (tier === "partial") {
    warnings.push(
      "store.db present but Layer 4 tool bubbles missing; tool/MCP UI may differ on import."
    );
  }
  return {
    tier,
    label: backupTierLabel(tier),
    detail: parts.join(" · "),
    warnings,
  };
}

export function summarizeBundleBackupTier(bundle: ChatBundle): BackupTierSummary {
  const tier = classifyBundleTier(bundle);
  const fidelity = summarizeBundleFidelity(bundle);
  const warnings = [...fidelity.warnings];
  const parts = [
    backupTierLabel(tier),
    `schema v${fidelity.schemaVersion}`,
    fidelity.diskKvRowCount > 0 ? `diskKv ${fidelity.diskKvRowCount} rows` : "no diskKv",
    `${fidelity.toolBubbleCount} tool bubbles`,
  ];
  return {
    tier,
    label: backupTierLabel(tier),
    detail: parts.join(" · "),
    warnings,
  };
}

export function tierMeetsMinimum(tier: BackupTier, minimum: BackupTier): boolean {
  const order: BackupTier[] = ["archive", "partial", "resume", "full"];
  return order.indexOf(tier) >= order.indexOf(minimum);
}

export function shouldWarnBeforeOpeningChat(tier: BackupTier | undefined): boolean {
  if (!tier) {
    return false;
  }
  return tier === "archive" || tier === "partial";
}

export function openChatTierWarningMessage(tier: BackupTier): string {
  if (tier === "archive") {
    return (
      "This chat is transcript-only (Archive). Composer may open empty or show only JSONL. " +
      "Open it in Composer on the source machine and sync again for full fidelity."
    );
  }
  return (
    "This chat has partial backup fidelity (store without Layer 4 tool bubbles). " +
    "Tool/MCP cards may differ after open."
  );
}

export function isBundleSyncEligible(
  bundle: ChatBundle,
  syncOnlyFullBackups: boolean
): boolean {
  if (!syncOnlyFullBackups) {
    return tierMeetsMinimum(classifyBundleTier(bundle), "archive");
  }
  return tierMeetsMinimum(classifyBundleTier(bundle), "resume");
}

export interface ChatSyncFidelityReport {
  total: number;
  byTier: Record<BackupTier, number>;
  textOnlyLayer4: number;
  warnings: string[];
}

export function aggregateChatSyncFidelity(bundles: ChatBundle[]): ChatSyncFidelityReport {
  const byTier: Record<BackupTier, number> = {
    full: 0,
    resume: 0,
    partial: 0,
    archive: 0,
  };
  let textOnlyLayer4 = 0;
  const warnings: string[] = [];

  for (const bundle of bundles) {
    const summary = summarizeBundleBackupTier(bundle);
    byTier[summary.tier] += 1;
    const fidelity = summarizeBundleFidelity(bundle);
    if (fidelity.textOnlyLayer4) {
      textOnlyLayer4 += 1;
    }
    if (summary.tier === "archive" || summary.tier === "partial") {
      warnings.push(`${bundle.title || bundle.conversationId}: ${summary.label}`);
    }
  }

  return { total: bundles.length, byTier, textOnlyLayer4, warnings };
}

export function formatChatSyncFidelityToast(report: ChatSyncFidelityReport): string {
  const parts = [
    `${report.total} chat(s)`,
    `full ${report.byTier.full}`,
    `resumable ${report.byTier.resume}`,
    `partial ${report.byTier.partial}`,
    `archive ${report.byTier.archive}`,
  ];
  if (report.textOnlyLayer4 > 0) {
    parts.push(`${report.textOnlyLayer4} text-only Layer 4`);
  }
  return parts.join(" · ");
}

export function fidelitySummaryFromBundle(bundle: ChatBundle): ChatBundleFidelitySummary {
  return summarizeBundleFidelity(bundle);
}
