import type { ChatBundle } from "./chat-persistence.js";

export interface ChatBundleFidelitySummary {
  schemaVersion: 1 | 2;
  diskKvRowCount: number;
  toolBubbleCount: number;
  textOnlyLayer4: boolean;
  warnings: string[];
}

const TEXT_ONLY_LAYER4_WARNING =
  "Text-only Layer 4 (cursorDiskKV): bundle has no diskKvSnapshot. Tool/MCP UI cards will not match the source.";

export function bundleHasNativeDiskKv(bundle: ChatBundle): boolean {
  const snap = bundle.diskKvSnapshot;
  return Boolean(snap && Array.isArray(snap.rows) && snap.rows.length > 0);
}

export function summarizeBundleFidelity(bundle: ChatBundle): ChatBundleFidelitySummary {
  const snap = bundle.diskKvSnapshot;
  const diskKvRowCount =
    snap?.rowCount ?? (Array.isArray(snap?.rows) ? snap.rows.length : 0);
  const toolBubbleCount = snap?.toolBubbleCount ?? 0;
  const textOnlyLayer4 = !bundleHasNativeDiskKv(bundle);
  const warnings: string[] = [];

  if (textOnlyLayer4) {
    warnings.push(
      bundle.schemaVersion === 1
        ? `${TEXT_ONLY_LAYER4_WARNING} (schema v1).`
        : TEXT_ONLY_LAYER4_WARNING
    );
  } else if (toolBubbleCount === 0) {
    warnings.push(
      "diskKvSnapshot present but toolBubbleCount is 0; tool/MCP cards may still be missing on destination."
    );
  }

  return {
    schemaVersion: bundle.schemaVersion,
    diskKvRowCount,
    toolBubbleCount,
    textOnlyLayer4,
    warnings,
  };
}

export function formatFidelityDetailLine(summary: ChatBundleFidelitySummary): string {
  const parts = [
    `schema v${summary.schemaVersion}`,
    `diskKv ${summary.diskKvRowCount} rows`,
    `${summary.toolBubbleCount} tool bubbles`,
  ];
  if (summary.textOnlyLayer4) {
    parts.push("text-only Layer 4");
  }
  if (summary.warnings.length > 0) {
    parts.push(summary.warnings[0]!);
  }
  return parts.join(" · ");
}

export function parsePythonInspectStdout(
  stdout: string
): Partial<ChatBundleFidelitySummary> | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }

  const schemaMatch = trimmed.match(/"schemaVersion":\s*(\d+)/);
  const diskMatch = trimmed.match(
    /diskKvSnapshot:\s*(\d+)\s*rows,\s*(\d+)\s*tool bubbles/
  );

  const schemaRaw = schemaMatch ? Number(schemaMatch[1]) : undefined;
  const schemaVersion =
    schemaRaw === 1 || schemaRaw === 2 ? (schemaRaw as 1 | 2) : undefined;
  const diskKvRowCount = diskMatch ? Number(diskMatch[1]) : undefined;
  const toolBubbleCount = diskMatch ? Number(diskMatch[2]) : undefined;
  const hasDiskKv =
    diskKvRowCount !== undefined && Number.isFinite(diskKvRowCount) && diskKvRowCount > 0;
  const textOnlyLayer4 =
    diskKvRowCount !== undefined ? !hasDiskKv : undefined;

  if (
    schemaVersion === undefined &&
    diskKvRowCount === undefined &&
    toolBubbleCount === undefined
  ) {
    return null;
  }

  const partial: Partial<ChatBundleFidelitySummary> = {};
  if (schemaVersion !== undefined) {
    partial.schemaVersion = schemaVersion;
    if (!diskMatch) {
      partial.textOnlyLayer4 = true;
      partial.warnings = [TEXT_ONLY_LAYER4_WARNING];
    }
  }
  if (diskKvRowCount !== undefined && Number.isFinite(diskKvRowCount)) {
    partial.diskKvRowCount = diskKvRowCount;
  }
  if (toolBubbleCount !== undefined && Number.isFinite(toolBubbleCount)) {
    partial.toolBubbleCount = toolBubbleCount;
  }
  if (textOnlyLayer4 !== undefined) {
    partial.textOnlyLayer4 = textOnlyLayer4;
    if (textOnlyLayer4) {
      partial.warnings = [TEXT_ONLY_LAYER4_WARNING];
    }
  }
  return partial;
}

export function mergeFidelitySummaries(
  fromBundle: ChatBundleFidelitySummary,
  fromInspect: Partial<ChatBundleFidelitySummary> | null
): ChatBundleFidelitySummary {
  if (!fromInspect) {
    return fromBundle;
  }
  const merged: ChatBundleFidelitySummary = { ...fromBundle, warnings: [...fromBundle.warnings] };
  if (fromInspect.schemaVersion !== undefined) {
    merged.schemaVersion = fromInspect.schemaVersion;
  }
  if (fromInspect.diskKvRowCount !== undefined) {
    merged.diskKvRowCount = fromInspect.diskKvRowCount;
  }
  if (fromInspect.toolBubbleCount !== undefined) {
    merged.toolBubbleCount = fromInspect.toolBubbleCount;
  }
  if (fromInspect.textOnlyLayer4 !== undefined) {
    merged.textOnlyLayer4 = fromInspect.textOnlyLayer4;
  }
  if (fromInspect.warnings && fromInspect.warnings.length > 0 && merged.warnings.length === 0) {
    merged.warnings = [...fromInspect.warnings];
  }
  return merged;
}
