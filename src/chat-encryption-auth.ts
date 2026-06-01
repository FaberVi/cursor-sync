import * as vscode from "vscode";

export const CHAT_ENCRYPTION_PASSWORD_SECRET = "cursorSync.chatEncryption.password";

export function isChatGistEncryptionEnabled(): boolean {
  return vscode.workspace.getConfiguration("cursorSync").get<boolean>("chatGist.encrypt") ?? true;
}

export async function getChatEncryptionPassword(
  context: vscode.ExtensionContext
): Promise<string | undefined> {
  return context.secrets.get(CHAT_ENCRYPTION_PASSWORD_SECRET);
}

export async function setChatEncryptionPassword(
  context: vscode.ExtensionContext,
  password: string
): Promise<void> {
  await context.secrets.store(CHAT_ENCRYPTION_PASSWORD_SECRET, password);
}

export async function clearChatEncryptionPassword(
  context: vscode.ExtensionContext
): Promise<void> {
  await context.secrets.delete(CHAT_ENCRYPTION_PASSWORD_SECRET);
}

export type RequirePasswordReason = "export" | "import-envelope";

async function promptNewPassword(): Promise<string | undefined> {
  const password = await vscode.window.showInputBox({
    prompt: "Enter chat encryption password",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) =>
      value && value.trim().length > 0 ? undefined : "Password cannot be empty",
  });
  if (!password) {
    return undefined;
  }
  const confirm = await vscode.window.showInputBox({
    prompt: "Confirm chat encryption password",
    password: true,
    ignoreFocusOut: true,
    validateInput: (value) => (value === password ? undefined : "Passwords do not match"),
  });
  return confirm ? password : undefined;
}

export async function requireChatEncryptionPassword(
  context: vscode.ExtensionContext,
  reason: RequirePasswordReason
): Promise<string | undefined> {
  if (reason === "export" && !isChatGistEncryptionEnabled()) {
    return undefined;
  }

  const stored = await getChatEncryptionPassword(context);
  if (stored) {
    return stored;
  }

  const password = await promptNewPassword();
  if (!password) {
    return undefined;
  }
  if (reason === "export") {
    await setChatEncryptionPassword(context, password);
  }
  return password;
}

export async function executeSetChatEncryptionPassword(
  context: vscode.ExtensionContext
): Promise<void> {
  const hadPassword = Boolean(await getChatEncryptionPassword(context));
  const password = await promptNewPassword();
  if (!password) {
    return;
  }
  await setChatEncryptionPassword(context, password);
  if (hadPassword) {
    vscode.window.showWarningMessage(
      "Chat encryption password updated. Gists encrypted with a previous password cannot be decrypted unless you still know that password."
    );
  } else {
    vscode.window.showInformationMessage("Chat encryption password saved.");
  }
}
