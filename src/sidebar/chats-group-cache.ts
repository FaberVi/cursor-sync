import type { ConversationProjectGroup } from "../chat-discovery.js";

let cachedGroups: ConversationProjectGroup[] | undefined;

export function setGroupedDiscoveryCache(groups: ConversationProjectGroup[]): void {
  cachedGroups = groups;
}

export function getGroupedDiscoveryCache(): ConversationProjectGroup[] | undefined {
  return cachedGroups;
}

export function clearGroupedDiscoveryCache(): void {
  cachedGroups = undefined;
}
