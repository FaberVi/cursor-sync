import { describe, expect, it } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";
import {
  chatBundleFromNativeChatJson,
  nativeChatJsonFromBundle,
} from "../src/native-chat-json/bundle-bridge.js";
import {
  buildNativeChatCollection,
  isNativeChatCollection,
  nativeCollectionFromBundles,
  parseNativeChatCollection,
} from "../src/native-chat-json/collection.js";

function minimalBundle(overrides: Partial<ChatBundle> = {}): ChatBundle {
  return {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt: "2026-01-01T00:00:00Z",
    conversationId: "00000000-0000-4000-8000-000000000001",
    title: "Test chat",
    subtitle: "",
    previewText: "",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [],
    ...overrides,
  };
}

describe("native-chat-json bundle bridge", () => {
  it("round-trips diskKv through native document", () => {
    const bundle = minimalBundle({
      schemaVersion: 2,
      diskKvSnapshot: {
        sourceStateDbPath: "/tmp/state.vscdb",
        rows: [
          {
            key: "composerData:00000000-0000-4000-8000-000000000001",
            value: JSON.stringify({
              composerId: "00000000-0000-4000-8000-000000000001",
              conversationState: "~abc",
            }),
            checksum: "x",
          },
          {
            key: "bubbleId:00000000-0000-4000-8000-000000000001:b1",
            value: JSON.stringify({ toolFormerData: { name: "read" } }),
            checksum: "y",
          },
        ],
        rowCount: 2,
        toolBubbleCount: 1,
      },
    });
    const native = nativeChatJsonFromBundle(bundle);
    expect(native.conversationState).toBe("~abc");
    expect(native.blobs).toHaveLength(1);
    const back = chatBundleFromNativeChatJson(native);
    expect(back.diskKvSnapshot?.rowCount).toBeGreaterThan(0);
    expect(back.conversationId).toBe(bundle.conversationId);
  });
});

describe("native sync collection", () => {
  it("collectionJsonFromBundles emits cursor-chat-collection", () => {
    const json = JSON.stringify(nativeCollectionFromBundles([minimalBundle()]), null, 2);
    const parsed = JSON.parse(json);
    expect(isNativeChatCollection(parsed)).toBe(true);
    expect(parsed.type).toBe("cursor-chat-collection");
    expect(parsed.chats).toHaveLength(1);
  });

  it("parseNativeChatCollection accepts collection", () => {
    const collection = buildNativeChatCollection([
      nativeChatJsonFromBundle(minimalBundle()),
    ]);
    const parsed = parseNativeChatCollection(JSON.stringify(collection));
    expect(parsed.chats).toHaveLength(1);
  });
});
