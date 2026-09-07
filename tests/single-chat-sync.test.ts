import { describe, expect, it, vi } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";
import {
  chatBundleFromNativeChatJson,
  nativeChatJsonFromBundle,
} from "../src/native-chat-json/bundle-bridge.js";
import { nativeCollectionFromBundles } from "../src/native-chat-json/collection.js";
import {
  computeChatCollectionChecksum,
  mergeChatCollections,
  parseSyncChatCollection,
  selectChatsForPull,
} from "../src/chat-sync.js";
import {
  decryptChatGistPayload,
  encryptChatGistPayload,
} from "../src/chat-gist-crypto.js";

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: (_key: string, defaultValue: unknown) => defaultValue,
    }),
  },
}));

const SINGLE_CHAT_ID = "11111111-2222-4333-8444-555555555555";

function singleChatBundle(): ChatBundle {
  return {
    schemaVersion: 2,
    type: "chat-persistence",
    createdAt: "2026-06-15T12:00:00.000Z",
    conversationId: SINGLE_CHAT_ID,
    title: "Unica chat di prova",
    subtitle: "",
    previewText: "preview",
    sidebarSnapshot: {
      conversationId: SINGLE_CHAT_ID,
      composerHeaders: { allComposers: [{ composerId: SINGLE_CHAT_ID, name: "Unica chat" }] },
    },
    storeSnapshot: null,
    transcriptFiles: [
      {
        relativePath: `${SINGLE_CHAT_ID}/main.jsonl`,
        content: Buffer.from('{"role":"user","text":"ciao"}\n').toString("base64"),
        encoding: "base64",
        checksum: "abc123",
        sizeBytes: 28,
      },
    ],
    diskKvSnapshot: {
      sourceStateDbPath: "/mock/global/state.vscdb",
      rows: [
        {
          key: `composerData:${SINGLE_CHAT_ID}`,
          value: JSON.stringify({
            composerId: SINGLE_CHAT_ID,
            name: "Unica chat di prova",
            conversationState: "~cHJvdG8x",
          }),
          checksum: "cd1",
        },
        {
          key: `bubbleId:${SINGLE_CHAT_ID}:bubble-1`,
          value: JSON.stringify({
            bubbleId: "bubble-1",
            type: 1,
            text: "risposta",
          }),
          checksum: "cd2",
        },
      ],
      rowCount: 2,
      toolBubbleCount: 0,
    },
  };
}

describe("single-chat sync pipeline", () => {
  it("exports exactly one chat in cursor-chat-collection", () => {
    const bundle = singleChatBundle();
    const collection = nativeCollectionFromBundles([bundle]);

    expect(collection.chats).toHaveLength(1);
    expect(collection.type).toBe("cursor-chat-collection");
    expect(collection.chats[0]!.conversationId).toBe(SINGLE_CHAT_ID);
    expect(collection.chats[0]!.title).toBe("Unica chat di prova");
    expect(collection.chats[0]!.transcripts).toHaveLength(1);
  });

  it("parseSyncChatCollection restores one importable bundle", () => {
    const bundle = singleChatBundle();
    const plaintext = JSON.stringify(nativeCollectionFromBundles([bundle]), null, 2);
    const parsed = parseSyncChatCollection(plaintext);

    expect(parsed.format).toBe("native");
    expect(parsed.bundles).toHaveLength(1);
    expect(parsed.bundles[0]!.conversationId).toBe(SINGLE_CHAT_ID);
    expect(parsed.bundles[0]!.transcriptFiles).toHaveLength(1);
    expect(parsed.bundles[0]!.diskKvSnapshot?.rowCount).toBe(2);
  });

  it("encrypts and decrypts single-chat gist payload", async () => {
    const plaintext = JSON.stringify(nativeCollectionFromBundles([singleChatBundle()]));
    const encrypted = await encryptChatGistPayload(
      plaintext,
      "single-chat-test-password",
      "cursor-chat-collection"
    );
    const decrypted = await decryptChatGistPayload(encrypted, "single-chat-test-password");
    const parsed = parseSyncChatCollection(decrypted);

    expect(parsed.bundles).toHaveLength(1);
    expect(parsed.bundles[0]!.title).toBe("Unica chat di prova");
  });

  it("selectChatsForPull imports the one remote chat when not local", () => {
    const remote = parseSyncChatCollection(
      JSON.stringify(nativeCollectionFromBundles([singleChatBundle()]))
    ).bundles;
    const localIds = new Set<string>();

    const selection = selectChatsForPull(remote, localIds, {
      pullUpdates: false,
      policy: "skip",
    });

    expect(selection.toImport).toHaveLength(1);
    expect(selection.toImport[0]!.conversationId).toBe(SINGLE_CHAT_ID);
    expect(selection.skipped).toBe(0);
  });

  it("skips the one chat when already local (no pull updates)", () => {
    const remote = parseSyncChatCollection(
      JSON.stringify(nativeCollectionFromBundles([singleChatBundle()]))
    ).bundles;
    const localIds = new Set([SINGLE_CHAT_ID]);

    const selection = selectChatsForPull(remote, localIds, {
      pullUpdates: false,
      policy: "skip",
    });

    expect(selection.toImport).toHaveLength(0);
    expect(selection.skipped).toBe(1);
  });

  it("merge + checksum stable for single-chat push payload", () => {
    const bundle = singleChatBundle();
    const json = JSON.stringify(nativeCollectionFromBundles([bundle]), null, 2);
    const checksum = computeChatCollectionChecksum(json);

    const merged = mergeChatCollections([], [bundle]);
    const mergedJson = JSON.stringify(nativeCollectionFromBundles(merged), null, 2);

    expect(merged).toHaveLength(1);
    expect(computeChatCollectionChecksum(mergedJson)).toBe(checksum);

    const roundTrip = chatBundleFromNativeChatJson(nativeChatJsonFromBundle(bundle));
    expect(roundTrip.conversationId).toBe(SINGLE_CHAT_ID);
    expect(roundTrip.transcriptFiles).toHaveLength(1);
    expect(roundTrip.diskKvSnapshot?.rows).toHaveLength(2);
  });
});
