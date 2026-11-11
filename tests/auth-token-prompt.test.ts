import { afterEach, describe, expect, it, vi } from "vitest";

const validateAccess = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
vi.mock("../src/retry.js", () => ({
  withRetry: async <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));
vi.mock("../src/github-repo.js", () => ({
  GitHubRepoClient: class {
    validateAccess(): Promise<unknown> {
      return validateAccess();
    }
  },
}));

import * as vscode from "vscode";
import { __setMockGlobalConfig, __clearMockGlobalConfigKeys } from "./__mocks__/vscode.js";
import { validateStoredToken } from "../src/auth.js";

const rejected = {
  ok: false as const,
  error: {
    category: "AUTH_FAILED" as const,
    message: "Authentication failed (401)",
    statusCode: 401,
  },
};

function context(token: string | undefined): vscode.ExtensionContext {
  return {
    secrets: {
      get: async () => token,
      store: async () => {},
      delete: async () => {},
    },
    globalStorageUri: { fsPath: "/tmp/cursor-sync-auth" },
  } as unknown as vscode.ExtensionContext;
}

describe("validateStoredToken", () => {
  afterEach(() => {
    validateAccess.mockReset();
    __clearMockGlobalConfigKeys("destination.repo");
    vi.restoreAllMocks();
  });

  it("offers reconfigure and does not ask again when the new token entry is cancelled", async () => {
    __setMockGlobalConfig({ "destination.repo": "owner/repo" });
    validateAccess.mockResolvedValue(rejected);
    const showError = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(
      "Reconfigure token" as unknown as undefined
    );
    const showInput = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);

    const ok = await validateStoredToken(context("stored-token"));

    expect(ok).toBe(false);
    expect(showError).toHaveBeenCalledTimes(1);
    expect(showError).toHaveBeenCalledWith(
      "Stored GitHub token cannot access the configured repository. Reconfigure it (repo scope required).",
      "Reconfigure token"
    );
    expect(showInput).toHaveBeenCalledTimes(1);
    expect(validateAccess).toHaveBeenCalledTimes(2);
  });

  it("marks the account unconfigured when reconfigure is dismissed", async () => {
    __setMockGlobalConfig({ "destination.repo": "owner/repo" });
    validateAccess.mockResolvedValue(rejected);
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    const executed: string[] = [];
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command: string) => {
      executed.push(command);
      return undefined;
    });

    const ok = await validateStoredToken(context("stored-token"));

    expect(ok).toBe(false);
    expect(executed).toContain("setContext");
    expect(validateAccess).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["404", { category: "UNKNOWN" as const, message: "Not Found", statusCode: 404 }],
    ["500", { category: "NETWORK_ERROR" as const, message: "Server error (500)", statusCode: 500 }],
  ])("continues when GitHub returns %s instead of an auth rejection", async (_label, error) => {
    __setMockGlobalConfig({ "destination.repo": "owner/repo" });
    validateAccess.mockResolvedValue({ ok: false, error });
    const showError = vi.spyOn(vscode.window, "showErrorMessage");
    const executed: string[] = [];
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation(async (command: string) => {
      executed.push(command);
      return undefined;
    });

    const ok = await validateStoredToken(context("stored-token"));

    expect(ok).toBe(true);
    expect(showError).not.toHaveBeenCalled();
    expect(executed).not.toContain("setContext");
  });
});
