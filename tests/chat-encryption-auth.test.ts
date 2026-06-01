import { beforeEach, describe, expect, it, vi } from "vitest";

const configurationValues: Record<string, unknown> = {
  "chatGist.encrypt": true,
};

const secretsStore = new Map<string, string>();
const showInputBoxMock = vi.fn();
const showWarningMessageMock = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      get: <T>(key: string, defaultValue?: T) =>
        (configurationValues[key] as T | undefined) ?? defaultValue,
    }),
  },
  window: {
    showInputBox: showInputBoxMock,
    showWarningMessage: showWarningMessageMock,
  },
}));

function makeContext() {
  return {
    secrets: {
      get: async (key: string) => secretsStore.get(key),
      store: async (key: string, value: string) => {
        secretsStore.set(key, value);
      },
      delete: async (key: string) => {
        secretsStore.delete(key);
      },
    },
  };
}

describe("chat-encryption-auth", () => {
  beforeEach(() => {
    secretsStore.clear();
    configurationValues["chatGist.encrypt"] = true;
    showInputBoxMock.mockReset();
    showWarningMessageMock.mockReset();
  });

  it("stores and retrieves password", async () => {
    const { getChatEncryptionPassword, setChatEncryptionPassword } = await import(
      "../src/chat-encryption-auth.js"
    );
    const ctx = makeContext() as never;
    await setChatEncryptionPassword(ctx, "secret-pass");
    expect(await getChatEncryptionPassword(ctx)).toBe("secret-pass");
  });

  it("requireChatEncryptionPassword returns undefined when encrypt is false on export", async () => {
    configurationValues["chatGist.encrypt"] = false;
    const { requireChatEncryptionPassword } = await import("../src/chat-encryption-auth.js");
    const ctx = makeContext() as never;
    const pw = await requireChatEncryptionPassword(ctx, { reason: "export" });
    expect(pw).toBeUndefined();
    expect(showInputBoxMock).not.toHaveBeenCalled();
  });

  it("requireChatEncryptionPassword prompts once when encrypt true and no stored password", async () => {
    showInputBoxMock.mockResolvedValueOnce("new-pass").mockResolvedValueOnce("new-pass");
    const { requireChatEncryptionPassword, getChatEncryptionPassword } = await import(
      "../src/chat-encryption-auth.js"
    );
    const ctx = makeContext() as never;
    const pw = await requireChatEncryptionPassword(ctx, { reason: "export" });
    expect(pw).toBe("new-pass");
    expect(await getChatEncryptionPassword(ctx)).toBe("new-pass");
    expect(showInputBoxMock).toHaveBeenCalledTimes(2);
  });

  it("requireChatEncryptionPassword uses stored password on import-envelope even when encrypt false", async () => {
    configurationValues["chatGist.encrypt"] = false;
    const { setChatEncryptionPassword, requireChatEncryptionPassword } = await import(
      "../src/chat-encryption-auth.js"
    );
    const ctx = makeContext() as never;
    await setChatEncryptionPassword(ctx, "stored-for-import");
    const pw = await requireChatEncryptionPassword(ctx, { reason: "import-envelope" });
    expect(pw).toBe("stored-for-import");
    expect(showInputBoxMock).not.toHaveBeenCalled();
  });

  it("returns undefined when user cancels password prompt", async () => {
    showInputBoxMock.mockResolvedValueOnce(undefined);
    const { requireChatEncryptionPassword } = await import("../src/chat-encryption-auth.js");
    const ctx = makeContext() as never;
    const pw = await requireChatEncryptionPassword(ctx, { reason: "export" });
    expect(pw).toBeUndefined();
  });
});
