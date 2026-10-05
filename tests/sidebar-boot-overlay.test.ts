import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { renderSidebarShellHtml } from "../src/sidebar/html.js";

describe("sidebar boot overlay", () => {
  it("covers the shell with a spinner and the loading label", () => {
    const html = renderSidebarShellHtml(
      {
        extensionUri: { fsPath: "c:/ext" },
        extensionPath: "c:/missing-ext",
      } as import("vscode").ExtensionContext,
      {
        asWebviewUri: (uri: { fsPath: string }) => uri,
        cspSource: "https://mock.csp",
      } as unknown as import("vscode").Webview,
      3
    );

    expect(html).toContain('id="boot-overlay"');
    expect(html).toContain('data-boot="3"');
    expect(html).toContain('class="boot-spinner"');
    expect(html).toContain('<div class="boot-overlay-label">Loading</div>');
    expect(html.indexOf("boot-overlay")).toBeLessThan(html.indexOf('class="tab-bar"'));
  });
});
