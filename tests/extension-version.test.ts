import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readExtensionVersion } from "../src/extension-version.js";

describe("readExtensionVersion", () => {
  it("reads version from extensionPath package.json for sidebar badge", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { version: string };

    const version = readExtensionVersion({
      extensionPath: process.cwd(),
    } as import("vscode").ExtensionContext);

    expect(version).toBe(packageJson.version);
  });

  it("falls back to bundled package.json without context", () => {
    const packageJson = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8")
    ) as { version: string };

    expect(readExtensionVersion()).toBe(packageJson.version);
  });
});
