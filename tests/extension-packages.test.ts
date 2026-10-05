import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { inflateRawSync } from "node:zlib";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
import {
  privateExtensionPackageKey,
  syncPrivateExtensionPackages,
} from "../src/extension-packages.js";

describe("private extension packages", () => {
  it("names the synced package from the extension id and version", () => {
    expect(privateExtensionPackageKey("domo.local", "1.0.0+build")).toBe(
      "vsix/domo.local-1.0.0_build.vsix"
    );
  });

  it("packs a local extension folder and leaves store extensions unpacked", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-vsix-"));
    const dotCursor = path.join(root, "dot");
    const cursorUser = path.join(root, "user");
    const folder = path.join(dotCursor, "extensions", "domo.local-1.0.0");
    await fs.mkdir(folder, { recursive: true });
    await fs.writeFile(
      path.join(folder, "package.json"),
      JSON.stringify({ name: "local", version: "1.0.0", publisher: "domo" }),
      "utf-8"
    );
    await fs.writeFile(path.join(folder, "readme"), "hello", "utf-8");
    await fs.writeFile(path.join(folder, "notes&more"), "amp", "utf-8");
    await fs.mkdir(path.join(dotCursor, "extensions"), { recursive: true });
    await fs.writeFile(
      path.join(dotCursor, "extensions", "extensions.json"),
      JSON.stringify([
        {
          identifier: { id: "vue.volar" },
          version: "3.3.12",
          relativeLocation: "vue.volar-3.3.12",
          metadata: { source: "gallery" },
        },
        {
          identifier: { id: "domo.local" },
          version: "1.0.0",
          relativeLocation: "domo.local-1.0.0",
          metadata: { source: "vsix" },
        },
        {
          identifier: { id: "domo.escape" },
          version: "1.0.0",
          relativeLocation: "../outside",
          metadata: { source: "vsix" },
        },
      ]),
      "utf-8"
    );

    await fs.mkdir(path.join(cursorUser, "vsix"), { recursive: true });
    const kept = path.join(cursorUser, "vsix", "domo.local-0.9.0.vsix");
    await fs.writeFile(kept, "user-file", "utf-8");

    expect(await syncPrivateExtensionPackages(cursorUser, dotCursor)).toBe(1);
    expect(await fs.readFile(kept, "utf-8")).toBe("user-file");
    const vsixPath = path.join(cursorUser, "vsix", "domo.local-1.0.0.vsix");
    const archive = await fs.readFile(vsixPath);
    const names = zipEntryNames(archive);
    expect(names).toContain("extension/package.json");
    expect(names).toContain("extension/readme");
    expect(names).toContain("extension.vsixmanifest");
    expect(zipText(archive, "extension/readme")).toBe("hello");
    expect(zipText(archive, "[Content_Types].xml")).toContain("notes&amp;more");
    expect(archive.readUInt16LE(6) & 0x800).toBe(0x800);

    const again = await syncPrivateExtensionPackages(cursorUser, dotCursor);
    expect(again).toBe(0);

    await fs.rm(root, { recursive: true, force: true });
  });
});

function zipEntryNames(archive: Buffer): string[] {
  return readZipEntries(archive).map((entry) => entry.name);
}

function zipText(archive: Buffer, name: string): string {
  const entry = readZipEntries(archive).find((item) => item.name === name);
  if (!entry) {
    throw new Error(`missing zip entry ${name}`);
  }
  return entry.data.toString("utf-8");
}

function readZipEntries(archive: Buffer): { name: string; data: Buffer }[] {
  const entries: { name: string; data: Buffer }[] = [];
  let offset = 0;
  while (offset + 30 <= archive.length) {
    const signature = archive.readUInt32LE(offset);
    if (signature !== 0x04034b50) {
      break;
    }
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const name = archive.subarray(nameStart, nameStart + nameLength).toString("utf-8");
    const dataStart = nameStart + nameLength + extraLength;
    const compressed = archive.subarray(dataStart, dataStart + compressedSize);
    const data = method === 0 ? compressed : inflateRawSync(compressed);
    entries.push({ name, data: Buffer.from(data) });
    offset = dataStart + compressedSize;
  }
  return entries;
}
