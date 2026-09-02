import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  EXTENSIONS_GIST_FILE_NAME,
  planPullDownloadNames,
} from "../src/pull-download-plan.js";

const CHAT = {
  syncKey: "dot-cursor/cursor-chat.json",
  gistName: "cursor-chat.json",
} as const;

const ALL_NAMES = [
  "manifest.json",
  "cursor-user--settings.json",
  "cursor-user--keybindings.json",
  EXTENSIONS_GIST_FILE_NAME,
  "cursor-chat.json",
];

describe("planPullDownloadNames", () => {
  it("returns empty when settings are already in sync and extensions are absent", () => {
    expect(
      planPullDownloadNames({
        manifestChecksums: {
          "cursor-user/settings.json": "aaa",
        },
        localChecksums: {
          "cursor-user/settings.json": "aaa",
        },
        allFileNames: ["manifest.json", "cursor-user--settings.json"],
        keepLocalKeys: new Set(),
        chatEnabled: true,
        chatFiles: [CHAT],
      })
    ).toEqual([]);
  });

  it("includes a settings file whose checksum changed", () => {
    expect(
      planPullDownloadNames({
        manifestChecksums: {
          "cursor-user/settings.json": "new",
          "cursor-user/keybindings.json": "same",
        },
        localChecksums: {
          "cursor-user/settings.json": "old",
          "cursor-user/keybindings.json": "same",
        },
        allFileNames: ALL_NAMES,
        keepLocalKeys: new Set(),
        chatEnabled: false,
        chatFiles: [CHAT],
      })
    ).toEqual(["cursor-user--extensions.json", "cursor-user--settings.json"]);
  });

  it("omits unchanged chat even when chat sync is on", () => {
    const names = planPullDownloadNames({
      manifestChecksums: {
        "cursor-user/settings.json": "aaa",
        "dot-cursor/cursor-chat.json": "chat-same",
      },
      localChecksums: {
        "cursor-user/settings.json": "aaa",
        "dot-cursor/cursor-chat.json": "chat-same",
      },
      allFileNames: ALL_NAMES,
      keepLocalKeys: new Set(),
      chatEnabled: true,
      chatFiles: [CHAT],
    });
    expect(names).toEqual([EXTENSIONS_GIST_FILE_NAME]);
    expect(names).not.toContain("cursor-chat.json");
  });

  it("includes chat when its remote checksum differs", () => {
    const names = planPullDownloadNames({
      manifestChecksums: {
        "cursor-user/settings.json": "aaa",
        "dot-cursor/cursor-chat.json": "chat-new",
      },
      localChecksums: {
        "cursor-user/settings.json": "aaa",
        "dot-cursor/cursor-chat.json": "chat-old",
      },
      allFileNames: ALL_NAMES,
      keepLocalKeys: new Set(),
      chatEnabled: true,
      chatFiles: [CHAT],
    });
    expect(names).toContain("cursor-chat.json");
  });

  it("always includes extensions.json when present on the remote", () => {
    const names = planPullDownloadNames({
      manifestChecksums: {
        "cursor-user/settings.json": "aaa",
        "cursor-user/extensions.json": "ext-same",
      },
      localChecksums: {
        "cursor-user/settings.json": "aaa",
        "cursor-user/extensions.json": "ext-same",
      },
      allFileNames: ALL_NAMES,
      keepLocalKeys: new Set(),
      chatEnabled: false,
      chatFiles: [CHAT],
    });
    expect(names).toEqual([EXTENSIONS_GIST_FILE_NAME]);
  });

  it("excludes keepLocal keys, including extensions", () => {
    expect(
      planPullDownloadNames({
        manifestChecksums: {
          "cursor-user/settings.json": "new",
          "cursor-user/extensions.json": "ext-new",
          "dot-cursor/cursor-chat.json": "chat-new",
        },
        localChecksums: {},
        allFileNames: ALL_NAMES,
        keepLocalKeys: new Set([
          "cursor-user/settings.json",
          "cursor-user/extensions.json",
          "dot-cursor/cursor-chat.json",
        ]),
        chatEnabled: true,
        chatFiles: [CHAT],
      })
    ).toEqual([]);
  });

  it("treats a missing local checksum as changed", () => {
    expect(
      planPullDownloadNames({
        manifestChecksums: {
          "cursor-user/settings.json": "aaa",
        },
        localChecksums: {},
        allFileNames: ["manifest.json", "cursor-user--settings.json"],
        keepLocalKeys: new Set(),
        chatEnabled: false,
        chatFiles: [],
      })
    ).toEqual(["cursor-user--settings.json"]);
  });

  it("skips mcp.json when MCP sync is off", () => {
    const names = planPullDownloadNames({
      manifestChecksums: {
        "cursor-user/settings.json": "aaa",
        "dot-cursor/mcp.json": "mcp-new",
      },
      localChecksums: {
        "cursor-user/settings.json": "aaa",
      },
      allFileNames: [
        "manifest.json",
        "cursor-user--settings.json",
        "dot-cursor--mcp.json",
      ],
      keepLocalKeys: new Set(),
      chatEnabled: false,
      chatFiles: [],
    });
    expect(names).not.toContain("dot-cursor--mcp.json");
  });

  it("omits denylisted skill node_modules and skill-snapshot paths", () => {
    const nodeModulesKey = "dot-cursor/skills/foo/node_modules/leftpad/index.js";
    const snapshotKey = "dot-cursor/skills/my-skill-workspace/skill-snapshot/SKILL.md";
    const nodeModulesName = "dot-cursor--skills--foo--node_modules--leftpad--index.js";
    const snapshotName =
      "dot-cursor--skills--my-skill-workspace--skill-snapshot--SKILL.md";
    const names = planPullDownloadNames({
      manifestChecksums: {
        "cursor-user/settings.json": "new",
        [nodeModulesKey]: "nm-new",
        [snapshotKey]: "snap-new",
      },
      localChecksums: {},
      allFileNames: [
        "manifest.json",
        "cursor-user--settings.json",
        EXTENSIONS_GIST_FILE_NAME,
        nodeModulesName,
        snapshotName,
      ],
      keepLocalKeys: new Set(),
      chatEnabled: false,
      chatFiles: [],
    });
    expect(names).toContain("cursor-user--settings.json");
    expect(names).toContain(EXTENSIONS_GIST_FILE_NAME);
    expect(names).not.toContain(nodeModulesName);
    expect(names).not.toContain(snapshotName);
  });
});
