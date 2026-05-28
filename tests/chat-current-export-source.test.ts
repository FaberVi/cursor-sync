import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(path.join(root, "src", "chat-persistence.ts"), "utf8");

function currentExportFunctionBody(): string {
  const start = source.indexOf("export async function executeExportCurrentChatBundle");
  if (start < 0) {
    throw new Error("executeExportCurrentChatBundle function not found");
  }
  const nextExport = source.indexOf("\nexport ", start + 1);
  return source.slice(start, nextExport < 0 ? undefined : nextExport);
}

describe("current chat export command source", () => {
  it("defines a context-specific export command", () => {
    expect(source).toContain("export async function executeExportCurrentChatBundle");
    expect(source).toContain("resolveChatEditorExportTarget");
  });

  it("does not use the multi-chat picker inside the context command", () => {
    expect(currentExportFunctionBody()).not.toContain("pickChatsForExport");
  });

  it("exports exactly one resolved conversation", () => {
    expect(currentExportFunctionBody()).toContain("conversationIds: [resolution.target.conversationId]");
    expect(currentExportFunctionBody()).toContain("workspaceKey: resolution.target.workspaceKey");
  });
});
