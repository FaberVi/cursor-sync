/** Stable chat identity: tilde-path + conversationId (legacy: id only). */

export function chatIdentityKey(
  sourceFolderTilde: string | undefined,
  conversationId: string
): string {
  const tilde = (sourceFolderTilde ?? "").trim();
  return tilde ? `${tilde}\0${conversationId}` : conversationId;
}

export function conversationIdFromIdentityKey(key: string): string {
  const sep = key.lastIndexOf("\0");
  return sep === -1 ? key : key.slice(sep + 1);
}

export function sourceFolderTildeOf(item: {
  sourceFolderTilde?: string;
}): string {
  return (item.sourceFolderTilde ?? "").trim();
}

/**
 * Same conversationId with a missing tilde on either side is one chat.
 * Distinct tilde paths keep two chats.
 */
export function mergeByChatIdentity<
  T extends { conversationId: string; sourceFolderTilde?: string },
>(remote: T[], local: T[], timestamp: (item: T) => number): T[] {
  const byKey = new Map<string, T>();

  function keyOf(item: T): string {
    return chatIdentityKey(item.sourceFolderTilde, item.conversationId);
  }

  function pickWinner(existing: T, incoming: T): T {
    const winner = timestamp(incoming) >= timestamp(existing) ? incoming : existing;
    const other = winner === incoming ? existing : incoming;
    if (!sourceFolderTildeOf(winner) && sourceFolderTildeOf(other)) {
      return { ...winner, sourceFolderTilde: other.sourceFolderTilde };
    }
    return winner;
  }

  function entriesForConversation(conversationId: string): Array<[string, T]> {
    return [...byKey.entries()].filter(([, item]) => item.conversationId === conversationId);
  }

  function findMergeKey(incoming: T): string | undefined {
    const key = keyOf(incoming);
    if (byKey.has(key)) {
      return key;
    }
    const incomingTilde = sourceFolderTildeOf(incoming);
    const sameId = entriesForConversation(incoming.conversationId);
    if (sameId.length === 0) {
      return undefined;
    }
    if (!incomingTilde) {
      if (sameId.length === 1) {
        return sameId[0]![0];
      }
      let best = sameId[0]!;
      for (const entry of sameId) {
        if (timestamp(entry[1]) > timestamp(best[1])) {
          best = entry;
        }
      }
      return best[0];
    }
    const legacy = sameId.find(([, item]) => !sourceFolderTildeOf(item));
    return legacy?.[0];
  }

  for (const item of [...remote, ...local]) {
    const mergeKey = findMergeKey(item);
    if (mergeKey === undefined) {
      byKey.set(keyOf(item), item);
      continue;
    }
    const existing = byKey.get(mergeKey)!;
    const winner = pickWinner(existing, item);
    byKey.delete(mergeKey);
    byKey.set(keyOf(winner), winner);
  }

  return [...byKey.values()].sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

/** True when a remote chat already exists locally (composite key, with mixed-legacy). */
export function isRemoteChatPresentLocally(
  bundle: { conversationId: string; sourceFolderTilde?: string },
  localIdentities: Set<string>
): boolean {
  const key = chatIdentityKey(bundle.sourceFolderTilde, bundle.conversationId);
  if (localIdentities.has(key)) {
    return true;
  }
  const tilde = sourceFolderTildeOf(bundle);
  if (!tilde) {
    // Id-only remote matches any local chat with the same conversationId.
    for (const loc of localIdentities) {
      if (conversationIdFromIdentityKey(loc) === bundle.conversationId) {
        return true;
      }
    }
    return false;
  }
  // Remote with a tilde is present only on the exact composite key.
  return false;
}

export function formatChatPackSkipLabel(opts: {
  title?: string;
  sourceFolderTilde?: string;
  conversationId: string;
}): string {
  const shortId = opts.conversationId.slice(0, 8);
  const title = opts.title?.trim() || shortId;
  const tilde = (opts.sourceFolderTilde ?? "").trim();
  if (tilde) {
    return `${title} · ${tilde} · ${shortId}`;
  }
  return `${title} · ${shortId}`;
}

export function contentRecencyMs(item: {
  storeMtimeMs?: number;
  transcriptMtimeMs?: number;
}): number {
  return Math.max(item.storeMtimeMs ?? 0, item.transcriptMtimeMs ?? 0);
}

export function sortDiscoveredForChatPack<
  T extends { conversationId: string; storeMtimeMs?: number; transcriptMtimeMs?: number },
>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const recency = contentRecencyMs(b) - contentRecencyMs(a);
    if (recency !== 0) {
      return recency;
    }
    return a.conversationId.localeCompare(b.conversationId);
  });
}
