import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as path from "node:path";
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("gist chat export/import", () => {
  const exportSrc = readFileSync(path.join(root, "src/export-gist-chat.ts"), "utf-8");
  const importSrc = readFileSync(path.join(root, "src/import-gist-chat.ts"), "utf-8");

  it("uses shared chat bundle gist file constant", () => {
    expect(exportSrc).toContain("CHAT_BUNDLE_GIST_FILE_NAME");
    expect(importSrc).toContain("CHAT_BUNDLE_GIST_FILE_NAME");
  });

  it("chat gist export calls createGist with two arguments only", () => {
    expect(exportSrc).toMatch(/\.createGist\(\s*gistFiles\s*,\s*GIST_DESCRIPTION\s*\)/s);
    expect(exportSrc).not.toMatch(
      /\.createGist\(\s*gistFiles\s*,\s*GIST_DESCRIPTION\s*,\s*true/s
    );
  });

  it("chat gist export UI copy describes private gist and link caveat", () => {
    expect(exportSrc).toContain("private Gist");
    expect(exportSrc).toContain("Anyone with the link can open it.");
  });

  it("chat gist import rejects transcript-only gists", () => {
    expect(importSrc).toContain("TRANSCRIPT_MANIFEST_FILE_NAME");
    expect(importSrc).toContain("agent transcripts, not a chat bundle");
  });

  it("import module uses parseChatBundle for validation", () => {
    expect(importSrc).toContain("parseChatBundle");
  });
});
