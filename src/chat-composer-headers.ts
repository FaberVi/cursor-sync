import {
  deriveComposerHeadersPayloadFromSidebarSnapshot,
  mergeComposerHeadersChain,
} from "./composer-merge.js";
import { clearSessionBindingInTree } from "./chat-partial-state.js";
import type { ChatBundle } from "./chat-persistence.js";

export interface WorkspaceIdentifier {
  id: string;
  uri: Record<string, unknown>;
}

export interface PrepareHeadersOptions {
  pinRecent?: boolean;
}

function composerTimestampMs(record: Record<string, unknown>): number {
  let best = 0;
  for (const field of ["lastUpdatedAt", "lastOpenedAt", "createdAt"] as const) {
    const raw = record[field];
    if (typeof raw === "number" && raw > 0) {
      const v = Math.trunc(raw);
      best = Math.max(best, v >= 1_000_000_000_000 ? v : v * 1000);
    } else if (typeof raw === "string" && raw.trim().length > 0) {
      if (/^\d+$/.test(raw.trim())) {
        const v = parseInt(raw.trim(), 10);
        best = Math.max(best, v >= 1_000_000_000_000 ? v : v * 1000);
      } else {
        const parsed = Date.parse(raw.replace("Z", "+00:00"));
        if (!Number.isNaN(parsed)) {
          best = Math.max(best, parsed);
        }
      }
    }
  }
  return best;
}

function maxComposerTimestampMs(headers: Record<string, unknown>): number {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return 0;
  }
  let max = 0;
  for (const entry of composers) {
    if (entry && typeof entry === "object" && !Array.isArray(entry)) {
      max = Math.max(max, composerTimestampMs(entry as Record<string, unknown>));
    }
  }
  return max;
}

export function filterComposerHeadersForConversation(
  headers: Record<string, unknown>,
  conversationId: string
): { allComposers: Array<Record<string, unknown>> } {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return { allComposers: [] };
  }
  const kept = composers.filter(
    (c): c is Record<string, unknown> =>
      !!c && typeof c === "object" && !Array.isArray(c) && c.composerId === conversationId
  );
  return { allComposers: kept };
}

function deriveHeadersFromBundle(bundle: ChatBundle): { allComposers: Array<Record<string, unknown>> } {
  const derived = deriveComposerHeadersPayloadFromSidebarSnapshot({
    conversationId: bundle.conversationId,
    title: bundle.title,
    subtitle: bundle.subtitle,
    lastUpdatedAt: bundle.createdAt,
  });
  if (derived && Array.isArray(derived.allComposers)) {
    return { allComposers: derived.allComposers as Array<Record<string, unknown>> };
  }
  return { allComposers: [] };
}

export function headersPayloadForImport(bundle: ChatBundle): { allComposers: Array<Record<string, unknown>> } {
  const cid = bundle.conversationId?.trim();
  if (!cid) {
    return deriveHeadersFromBundle(bundle);
  }

  const payloads: Array<Record<string, unknown>> = [];
  let snapshotHasName = false;
  const snap = bundle.sidebarSnapshot;
  if (snap && typeof snap === "object" && !Array.isArray(snap)) {
    const rawHeaders = snap.composerHeaders;
    if (rawHeaders && typeof rawHeaders === "object" && !Array.isArray(rawHeaders)) {
      const filtered = filterComposerHeadersForConversation(rawHeaders as Record<string, unknown>, cid);
      if (filtered.allComposers.length > 0) {
        payloads.push(filtered);
        const row = filtered.allComposers[0]!;
        const name = row.name;
        snapshotHasName = typeof name === "string" && name.trim().length > 0;
      }
    }
  }
  const derived = deriveHeadersFromBundle(bundle);
  if (snapshotHasName) {
    payloads.push({
      allComposers: derived.allComposers.map((row) => {
        if (row.composerId !== cid) {
          return row;
        }
        const { name: _name, ...rest } = row;
        return rest;
      }),
    });
  } else {
    payloads.push(derived);
  }
  return mergeComposerHeadersChain(undefined, payloads);
}

export function pinComposerAsMostRecent(
  headers: { allComposers: Array<Record<string, unknown>> },
  conversationId: string
): { allComposers: Array<Record<string, unknown>> } {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return headers;
  }
  const nowMs = Date.now();
  const pinMs = Math.max(maxComposerTimestampMs(headers as Record<string, unknown>), nowMs) + 1;
  const updated: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of composers) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      updated.push(entry);
      continue;
    }
    if (entry.composerId !== conversationId) {
      updated.push(entry);
      continue;
    }
    found = true;
    const bumped = { ...entry };
    bumped.lastUpdatedAt = pinMs;
    bumped.lastOpenedAt = pinMs;
    if (!bumped.type) {
      bumped.type = "head";
    }
    bumped.hasUnreadMessages = false;
    bumped.isArchived = false;
    bumped.isDraft = false;
    updated.push(bumped);
  }
  if (!found) {
    const derived = deriveHeadersFromBundle({
      conversationId,
      title: conversationId,
      subtitle: "",
      createdAt: new Date(pinMs).toISOString(),
    } as ChatBundle);
    if (derived.allComposers.length > 0) {
      const row = { ...derived.allComposers[0]! };
      row.lastUpdatedAt = pinMs;
      row.lastOpenedAt = pinMs;
      updated.push(row);
    }
  }
  return { allComposers: updated };
}

export function rebindComposerRecord(
  record: Record<string, unknown>,
  workspaceIdentifier: WorkspaceIdentifier,
  nowMs: number = Date.now()
): Record<string, unknown> {
  const cleared = clearSessionBindingInTree(record);
  const row =
    cleared && typeof cleared === "object" && !Array.isArray(cleared)
      ? (cleared as Record<string, unknown>)
      : {};
  const out: Record<string, unknown> = {
    ...row,
    workspaceIdentifier,
    createdAt: nowMs,
    lastUpdatedAt: nowMs,
    lastOpenedAt: nowMs,
  };
  if ("conversationCheckpointLastUpdatedAt" in out) {
    out.conversationCheckpointLastUpdatedAt = nowMs;
  }
  const headers = out.fullConversationHeadersOnly;
  if (Array.isArray(headers)) {
    out.fullConversationHeadersOnly = headers.map((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        return entry;
      }
      return {
        ...entry,
        workspaceIdentifier,
        createdAt: nowMs,
        lastUpdatedAt: nowMs,
        lastOpenedAt: nowMs,
        conversationCheckpointLastUpdatedAt: nowMs,
      };
    });
  }
  return out;
}

export function stampWorkspaceIdentifierOnHeaders(
  headers: { allComposers: Array<Record<string, unknown>> },
  conversationId: string,
  workspaceIdentifier: WorkspaceIdentifier
): { allComposers: Array<Record<string, unknown>> } {
  const composers = headers.allComposers;
  if (!Array.isArray(composers)) {
    return headers;
  }
  const updated = composers.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    if (entry.composerId !== conversationId) {
      return entry;
    }
    const ts = typeof entry.lastUpdatedAt === "number" ? entry.lastUpdatedAt : Date.now();
    return rebindComposerRecord(entry, workspaceIdentifier, ts);
  });
  return { allComposers: updated };
}

export function prepareHeadersForImport(
  existingHeadersRaw: string | undefined,
  bundle: ChatBundle,
  conversationId: string,
  workspaceIdentifier: WorkspaceIdentifier,
  options: PrepareHeadersOptions = {}
): { allComposers: Array<Record<string, unknown>> } {
  const pinRecent = options.pinRecent !== false;
  const headersPayload = headersPayloadForImport(bundle);
  let merged = mergeComposerHeadersChain(existingHeadersRaw, [headersPayload]);
  if (pinRecent) {
    merged = pinComposerAsMostRecent(merged, conversationId);
  }
  return stampWorkspaceIdentifierOnHeaders(merged, conversationId, workspaceIdentifier);
}
