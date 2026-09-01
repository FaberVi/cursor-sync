import {
  CHAT_BUNDLE_GIST_FILE_NAME,
  buildChatBundleFixture,
  configurationValues,
  createGistMock,
  decryptChatGistPayloadMock,
  encryptChatGistPayloadMock,
  gistConversationId,
  folderToProjectKey,
  flushMicrotasks,
  getGistMock,
  isEncryptedChatGistPayloadMock,
  mockExportPicker,
  requireChatEncryptionPasswordMock,
  setupChatGistCase,
  setupExportConversation,
  showErrorMessageMock,
  showInformationMessageMock,
  showInputBoxMock,
  showQuickPickMock,
  teardownChatGistCase,
  type ChatGistExtensionContext,
} from "./chat-gist-export-import-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("chat gist encryption", () => {
  let tmpRoot: string;
  let mockWorkspaceFolder: string;
  let extensionContext: ChatGistExtensionContext;

  beforeEach(async () => {
    const env = await setupChatGistCase();
    tmpRoot = env.tmpRoot;
    mockWorkspaceFolder = env.mockWorkspaceFolder;
    extensionContext = env.extensionContext;
  });

  afterEach(async () => {
    await teardownChatGistCase(tmpRoot);
  });

  it("encrypts gist payload when chatGist.encrypt is true", async () => {
    configurationValues["chatGist.encrypt"] = true;
    requireChatEncryptionPasswordMock.mockResolvedValue("test-pass");
    encryptChatGistPayloadMock.mockImplementation(async (plain: string) =>
      JSON.stringify({ cursorSyncEncrypted: { mock: true }, plainLen: plain.length })
    );

    const workspaceKey = "enc-export-wk";
    const projectKey = "enc-export-project";
    const conversationId = gistConversationId(11);
    await setupExportConversation(tmpRoot, workspaceKey, conversationId, { projectKey });
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-enc",
        html_url: "https://gist.github.com/example/gist-enc",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(requireChatEncryptionPasswordMock).toHaveBeenCalledWith(extensionContext, "export");
    expect(encryptChatGistPayloadMock).toHaveBeenCalledTimes(1);
    const uploaded = createGistMock.mock.calls[0]![0] as Record<string, { content: string }>;
    expect(uploaded[CHAT_BUNDLE_GIST_FILE_NAME]!.content).toContain("cursorSyncEncrypted");
    expect(
      showInformationMessageMock.mock.calls.some((c) =>
        String(c[0]).includes("encrypted") && !String(c[0]).includes("Anyone with the link")
      )
    ).toBe(true);
  });

  it("skips password and encryption when chatGist.encrypt is false", async () => {
    configurationValues["chatGist.encrypt"] = false;
    const workspaceKey = "plain-export-wk";
    const conversationId = gistConversationId(12);
    await setupExportConversation(tmpRoot, workspaceKey, conversationId);
    mockExportPicker(workspaceKey, [conversationId]);
    showInformationMessageMock.mockResolvedValue(undefined);
    createGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-plain",
        html_url: "https://gist.github.com/example/gist-plain",
        description: "Cursor Sync - Chat Export",
        files: {},
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    const { executeExportChatToGist } = await import("../src/export-gist-chat.js");
    await executeExportChatToGist(extensionContext as never);
    await flushMicrotasks();

    expect(requireChatEncryptionPasswordMock).not.toHaveBeenCalled();
    expect(encryptChatGistPayloadMock).not.toHaveBeenCalled();
    const uploaded = createGistMock.mock.calls[0]![0] as Record<string, { content: string }>;
    const bundle = JSON.parse(uploaded[CHAT_BUNDLE_GIST_FILE_NAME]!.content);
    expect(bundle.type).toBe("chat-persistence");
  });

  it("downloads full gist file when API marks content truncated", async () => {
    const bundle = buildChatBundleFixture({
      conversationId: gistConversationId(13),
      projectKey: folderToProjectKey(mockWorkspaceFolder),
    });
    const plainJson = JSON.stringify(bundle);
    const originalFetch = globalThis.fetch;

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-truncated",
        html_url: "https://gist.github.com/example/gist-truncated",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: {
            content: plainJson.slice(0, 120),
            truncated: true,
            raw_url: "https://gist.githubusercontent.com/example/raw/chat-bundle.json",
          },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => plainJson,
    });

    isEncryptedChatGistPayloadMock.mockReturnValue(false);
    showInputBoxMock.mockResolvedValue("gist-truncated");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) =>
        items.find((item) => item.activate === false) ??
        items.find((item) => item.description === folderToProjectKey(mockWorkspaceFolder))
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    try {
      const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
      await executeImportChatFromGist(extensionContext as never);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://gist.githubusercontent.com/example/raw/chat-bundle.json",
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: expect.stringContaining("token"),
          }),
        })
      );
      expect(restoreSpy).toHaveBeenCalledTimes(1);
      expect(showErrorMessageMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
      restoreSpy.mockRestore();
    }
  });

  it("decrypts encrypted gist on import", async () => {
    const sourceProjectKey = "enc-import-project";
    const conversationId = gistConversationId(14);
    const targetProjectKey = folderToProjectKey(mockWorkspaceFolder);
    const bundle = buildChatBundleFixture({ conversationId, projectKey: sourceProjectKey });
    const plainJson = JSON.stringify(bundle, null, 2);
    const envelopeJson = JSON.stringify({ cursorSyncEncrypted: { v: 1 } });

    isEncryptedChatGistPayloadMock.mockReturnValue(true);
    decryptChatGistPayloadMock.mockResolvedValue(plainJson);
    requireChatEncryptionPasswordMock.mockResolvedValue("import-pass");

    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-enc-import",
        html_url: "https://gist.github.com/example/gist-enc-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: envelopeJson },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });

    showInputBoxMock.mockResolvedValue("gist-enc-import");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) =>
        items.find((item) => item.activate === false) ??
        items.find((item) => item.description === targetProjectKey)
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(requireChatEncryptionPasswordMock).toHaveBeenCalledWith(
      extensionContext,
      "import-envelope"
    );
    expect(decryptChatGistPayloadMock).toHaveBeenCalledWith(envelopeJson, "import-pass");
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    restoreSpy.mockRestore();
  });

  it("does not require password for plain gist when encrypt setting is false", async () => {
    configurationValues["chatGist.encrypt"] = false;
    const bundle = buildChatBundleFixture({
      conversationId: gistConversationId(15),
      projectKey: "plain-import-project",
    });
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-plain-import",
        html_url: "https://gist.github.com/example/gist-plain-import",
        description: "Cursor Sync - Chat Export",
        files: {
          [CHAT_BUNDLE_GIST_FILE_NAME]: { content: JSON.stringify(bundle) },
        },
        created_at: "2026-05-20T12:00:00.000Z",
        updated_at: "2026-05-20T12:00:00.000Z",
      },
    });
    isEncryptedChatGistPayloadMock.mockReturnValue(false);
    showInputBoxMock.mockResolvedValue("gist-plain-import");
    showQuickPickMock.mockImplementation(
      async (items: Array<{ description?: string; activate?: boolean }>) =>
        items.find((item) => item.activate === false) ??
        items.find((item) => item.description === folderToProjectKey(mockWorkspaceFolder))
    );
    showInformationMessageMock.mockResolvedValue(undefined);

    const chatMod = await import("../src/chat-persistence.js");
    const restoreSpy = vi.spyOn(chatMod, "restoreChatBundle");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(requireChatEncryptionPasswordMock).not.toHaveBeenCalled();
    expect(decryptChatGistPayloadMock).not.toHaveBeenCalled();
    expect(restoreSpy).toHaveBeenCalledTimes(1);
    restoreSpy.mockRestore();
  });

  it("surfaces DECRYPT_FAILED without leaking password", async () => {
    const { ChatGistCryptoError } = await import("../src/chat-gist-crypto.js");
    isEncryptedChatGistPayloadMock.mockReturnValue(true);
    requireChatEncryptionPasswordMock.mockResolvedValue("wrong");
    decryptChatGistPayloadMock.mockRejectedValue(
      new ChatGistCryptoError("Decryption failed.", "DECRYPT_FAILED")
    );
    getGistMock.mockResolvedValue({
      ok: true,
      data: {
        id: "gist-bad-pass",
        files: { [CHAT_BUNDLE_GIST_FILE_NAME]: { content: '{"cursorSyncEncrypted":{}}' } },
      },
    });
    showInputBoxMock.mockResolvedValue("gist-bad-pass");

    const { executeImportChatFromGist } = await import("../src/import-gist-chat.js");
    await executeImportChatFromGist(extensionContext as never);

    expect(showErrorMessageMock).toHaveBeenCalledWith(
      expect.stringMatching(/decrypt|password/i)
    );
    expect(showErrorMessageMock.mock.calls[0]![0]).not.toContain("wrong");
  });
});
