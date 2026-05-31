import { describe, it, expect, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { formatGistUrl } from "../src/gist-settings.js";
import { extractGistId } from "../src/transcripts-export.js";

describe("gist-settings", () => {
  it("formatGistUrl builds a gist.github.com URL", () => {
    expect(formatGistUrl("abc123def4567890abcdef1234567890")).toBe(
      "https://gist.github.com/abc123def4567890abcdef1234567890"
    );
  });

  it("extractGistId accepts URLs used by Change Gist ID", () => {
    const id = "a1b2c3d4e5f6789012345678abcdef01";
    expect(
      extractGistId(`https://gist.github.com/someuser/${id}`)
    ).toBe(id);
    expect(extractGistId(id)).toBe(id);
  });
});
