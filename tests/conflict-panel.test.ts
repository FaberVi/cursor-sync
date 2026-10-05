import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { renderConflictPanelHtml, unifiedDiff } from "../src/conflict-panel.js";
import { allConflictsResolved } from "../src/sync-conflicts.js";

describe("conflict panel html", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const conflicts = [
    {
      relativeSyncKey: "cursor-user/settings.json",
      localChecksum: "l",
      remoteChecksum: "r",
      baseChecksum: "b",
      kind: "bothModified" as const,
    },
  ];

  it("disables Apply while a row is undecided", () => {
    const html = renderConflictPanelHtml({
      conflicts,
      resolutions: {},
      selectedKey: "cursor-user/settings.json",
      preview: {
        localText: "local",
        remoteText: "remote",
        unified: "-local\n+remote",
        binary: false,
      },
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain('id="apply" disabled');
    expect(html).not.toContain("Skip");
    expect(allConflictsResolved(conflicts, {})).toBe(false);
  });

  it("enables Apply after keep-all local", () => {
    const resolutions = { "cursor-user/settings.json": "keepLocal" as const };
    expect(allConflictsResolved(conflicts, resolutions)).toBe(true);
    const html = renderConflictPanelHtml({
      conflicts,
      resolutions,
      selectedKey: "cursor-user/settings.json",
      preview: undefined,
      cssUri: "css",
      jsUri: "js",
      csp: "default-src 'none'",
    });
    expect(html).toContain('id="apply"');
    expect(html).not.toContain('id="apply" disabled');
  });
});

describe("unifiedDiff", () => {
  it("marks changed lines", () => {
    const diff = unifiedDiff("a\nb", "a\nc");
    expect(diff).toContain(" a");
    expect(diff).toContain("-b");
    expect(diff).toContain("+c");
  });
});
