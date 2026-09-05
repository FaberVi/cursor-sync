import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function readPackageJson(): Record<string, any> {
  return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
}

describe("package menu contributions", () => {
  it("declares the current-chat bundle export command", () => {
    const pkg = readPackageJson();
    const command = pkg.contributes.commands.find(
      (entry: { command: string }) => entry.command === "cursorSync.exportCurrentChatBundle"
    );
    expect(command).toEqual({
      command: "cursorSync.exportCurrentChatBundle",
      title: "Cursor Sync: Export into Bundle",
      icon: "$(archive)",
    });
  });

  it("contributes current-chat export to editor title and tab context menus", () => {
    const pkg = readPackageJson();
    expect(pkg.contributes.menus["editor/title"]).toContainEqual({
      command: "cursorSync.exportCurrentChatBundle",
      when: "resourceScheme == 'cursor.composer'",
      group: "navigation",
    });
    expect(pkg.contributes.menus["editor/title/context"]).toContainEqual({
      command: "cursorSync.exportCurrentChatBundle",
      when: "resourceScheme == 'cursor.composer'",
      group: "navigation",
    });
  });

  it("hides the context command from the Command Palette", () => {
    const pkg = readPackageJson();
    expect(pkg.contributes.menus.commandPalette).toContainEqual({
      command: "cursorSync.exportCurrentChatBundle",
      when: "false",
    });
  });

  it("does not contribute Gist, Mirror, or conflict commands", () => {
    const pkg = readPackageJson();
    const commands = (pkg.contributes.commands as Array<{ command: string }>).map(
      (c) => c.command
    );
    expect(commands).not.toContain("cursorSync.exportCurrentChatBundleToGist");
    expect(commands).not.toContain("cursorSync.pullMirror");
    expect(commands).not.toContain("cursorSync.resolveConflicts");
    expect(commands).not.toContain("cursorSync.exportChatToGist");
    expect(commands).not.toContain("cursorSync.importChatFromGist");
    expect(pkg.contributes.menus["editor/title"]).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ command: "cursorSync.exportCurrentChatBundleToGist" }),
      ])
    );
  });

  it("declares chat encryption setting default true", () => {
    const pkg = readPackageJson();
    expect(pkg.contributes.configuration.properties["cursorSync.chats.encrypt"]).toEqual({
      type: "boolean",
      default: true,
      description: expect.stringMatching(/encrypt/i),
    });
    expect(pkg.contributes.configuration.properties["cursorSync.chatGist.encrypt"]).toBeUndefined();
    expect(pkg.contributes.configuration.properties["cursorSync.destination.type"]).toBeUndefined();
    expect(pkg.contributes.configuration.properties["cursorSync.safeMode"]).toBeUndefined();
    expect(pkg.contributes.configuration.properties["cursorSync.transcripts.enabled"]).toBeUndefined();
    expect(pkg.contributes.configuration.properties["cursorSync.transcripts.maxFileSizeKB"]).toBeUndefined();
    expect(
      pkg.contributes.configuration.properties["cursorSync.transcripts.importFallbackToCurrentWorkspace"]
    ).toBeUndefined();
  });

  it("declares Pull, Reset to Remote, and Open Sync Clone commands", () => {
    const pkg = readPackageJson();
    const commands = pkg.contributes.commands as Array<{ command: string; title: string }>;
    expect(commands.find((c) => c.command === "cursorSync.pull")?.title).toBe(
      "Cursor Sync: Pull Now"
    );
    expect(commands.find((c) => c.command === "cursorSync.resetToRemote")).toEqual({
      command: "cursorSync.resetToRemote",
      title: "Cursor Sync: Reset to Remote",
      icon: "$(discard)",
      enablement: "cursorSync.configured",
    });
    expect(commands.find((c) => c.command === "cursorSync.openSyncClone")).toEqual({
      command: "cursorSync.openSyncClone",
      title: "Cursor Sync: Open Sync Clone",
      icon: "$(repo)",
      enablement: "cursorSync.configured",
    });
  });

  it("declares cancel sync command", () => {
    const pkg = readPackageJson();
    const command = pkg.contributes.commands.find(
      (entry: { command: string }) => entry.command === "cursorSync.cancelSync"
    );
    expect(command).toEqual({
      command: "cursorSync.cancelSync",
      title: "Cursor Sync: Stop Sync",
    });
  });

  it("defaults chats and MCP sync off and includes extra file globs", () => {
    const pkg = readPackageJson();
    const props = pkg.contributes.configuration.properties;
    expect(props["cursorSync.chats.syncEnabled"].default).toBe(false);
    expect(props["cursorSync.mcp.syncEnabled"].default).toBe(false);
    expect(props["cursorSync.syncExtensions.autoInstall"].default).toBe(true);
    expect(props["cursorSync.enabledPaths"].default).toEqual(
      expect.arrayContaining(["cli-config.json", "hooks.json", "tasks.json"])
    );
    expect(props["cursorSync.enabledPaths"].default).not.toContain("mcp.json");
  });

  it("declares set chat encryption password command", () => {
    const pkg = readPackageJson();
    const command = pkg.contributes.commands.find(
      (entry: { command: string }) => entry.command === "cursorSync.setChatEncryptionPassword"
    );
    expect(command?.title).toMatch(/Set Chat Encryption Password/i);
  });
});
