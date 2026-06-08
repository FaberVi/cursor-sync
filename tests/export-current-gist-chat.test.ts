import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "export-gist-chat.ts"), "utf8");

function currentGistExportFunctionBody(): string {
  const start = source.indexOf("export async function executeExportCurrentChatBundleToGist");
  if (start < 0) {
    throw new Error("executeExportCurrentChatBundleToGist function not found");
  }
  const nextExport = source.indexOf("\nexport ", start + 1);
  return source.slice(start, nextExport < 0 ? undefined : nextExport);
}

describe("current chat gist export command source", () => {
  it("defines a context-specific gist export command", () => {
    expect(source).toContain("export async function executeExportCurrentChatBundleToGist");
    expect(source).toContain("resolveChatEditorExportTarget");
    expect(source).toContain("exportChatSelectionToGist");
  });

  it("does not use the multi-chat picker inside the context command", () => {
    expect(currentGistExportFunctionBody()).not.toContain("pickChatsForExport");
  });

  it("exports exactly one resolved conversation to gist", () => {
    expect(currentGistExportFunctionBody()).toContain(
      "conversationIds: [resolution.target.conversationId]"
    );
    expect(currentGistExportFunctionBody()).toContain("workspaceKey: resolution.target.workspaceKey");
  });
});
