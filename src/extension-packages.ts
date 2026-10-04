import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { getLogger } from "./diagnostics.js";
import type { ExtensionEntry } from "./extensions.js";

/** Same cap as `vsix/**` in the sync file scan. */
const MAX_PRIVATE_VSIX_BYTES = 50 * 1024 * 1024;

const EXTENSION_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9\-]*\.[A-Za-z0-9][A-Za-z0-9\-]*$/;

/** ZIP general-purpose bit 11: file names are UTF-8. */
const ZIP_UTF8_FLAG = 0x800;

export function privateExtensionPackageKey(id: string, version: string): string {
  const safeVersion = version.replace(/[^A-Za-z0-9._-]/g, "_");
  return `vsix/${id}-${safeVersion}.vsix`;
}

/** Gallery entries stay id + version + source. VSIX entries also name the synced package. */
export function annotateExtensionPackages(
  entries: readonly ExtensionEntry[]
): ExtensionEntry[] {
  return entries.map((entry) => {
    if (entry.source === "vsix") {
      return {
        id: entry.id,
        version: entry.version,
        source: "vsix",
        package: privateExtensionPackageKey(entry.id, entry.version),
      };
    }
    if (entry.source === "gallery") {
      return { id: entry.id, version: entry.version, source: "gallery" };
    }
    return { id: entry.id, version: entry.version };
  });
}

type PrivateInstall = {
  id: string;
  version: string;
  folder: string;
};

/**
 * Writes a `.vsix` under Cursor User for every extension installed from a
 * local package (`metadata.source === "vsix"`). Gallery installs are not copied.
 * Returns the number of packages written.
 */
export async function syncPrivateExtensionPackages(
  cursorUser: string,
  dotCursor: string
): Promise<number> {
  const installs = await readPrivateInstalls(dotCursor);
  let written = 0;
  for (const install of installs) {
    const relative = privateExtensionPackageKey(install.id, install.version);
    const destination = path.join(cursorUser, ...relative.split("/"));
    const didWrite = await writePrivateVsix(install, destination);
    if (didWrite) {
      written += 1;
    }
  }
  return written;
}

async function readPrivateInstalls(dotCursor: string): Promise<PrivateInstall[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(
      await fs.readFile(path.join(dotCursor, "extensions", "extensions.json"), "utf-8")
    );
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) {
    return [];
  }
  const installs: PrivateInstall[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as {
      identifier?: { id?: unknown };
      version?: unknown;
      relativeLocation?: unknown;
      metadata?: { source?: unknown; isBuiltin?: unknown };
    };
    if (record.metadata?.isBuiltin === true || record.metadata?.source !== "vsix") {
      continue;
    }
    const id = record.identifier?.id;
    const version = record.version;
    const location = record.relativeLocation;
    if (typeof id !== "string" || !EXTENSION_ID_RE.test(id)) {
      continue;
    }
    if (typeof version !== "string" || version.length === 0) {
      continue;
    }
    if (typeof location !== "string" || !isSafeExtensionFolder(location)) {
      getLogger().appendLine(
        `[${new Date().toISOString()}] Skipping private extension ${id}: installed folder is missing or not a single directory name`
      );
      continue;
    }
    installs.push({
      id,
      version,
      folder: path.join(dotCursor, "extensions", location),
    });
  }
  return installs;
}

function isSafeExtensionFolder(location: string): boolean {
  if (location.includes("..") || location.includes("/") || location.includes("\\")) {
    return false;
  }
  return location.length > 0 && location !== "." && location !== "..";
}

async function writePrivateVsix(
  install: PrivateInstall,
  destination: string
): Promise<boolean> {
  const listed: ListedFile[] = [];
  try {
    const withinLimit = await listExtensionFiles(install.folder, "extension", listed, {
      total: 0,
    });
    if (!withinLimit) {
      getLogger().appendLine(
        `[${new Date().toISOString()}] Skipping private extension ${install.id}: package is over the ${MAX_PRIVATE_VSIX_BYTES} byte sync limit`
      );
      return false;
    }
  } catch (err) {
    getLogger().appendLine(
      `[${new Date().toISOString()}] Could not read private extension ${install.id}: ${err instanceof Error ? err.message : String(err)}`
    );
    return false;
  }
  if (listed.length === 0) {
    return false;
  }
  const newest = listed.reduce((max, file) => Math.max(max, file.mtimeMs), 0);
  try {
    const existing = await fs.stat(destination);
    if (existing.mtimeMs >= newest && existing.size > 0) {
      return false;
    }
  } catch {
    // Missing package — write below.
  }

  const files: PackedFile[] = [];
  for (const file of listed) {
    files.push({
      zipPath: file.zipPath,
      data: await fs.readFile(file.abs),
      mtimeMs: file.mtimeMs,
    });
  }
  files.sort((a, b) => a.zipPath.localeCompare(b.zipPath, "en"));
  const archive = buildStoredZip(install, files);
  const temporary = path.join(
    os.tmpdir(),
    `cursor-sync-${install.id}-${Date.now()}.vsix.tmp`
  );
  try {
    await fs.writeFile(temporary, archive);
    const written = await fs.stat(temporary);
    if (written.size > MAX_PRIVATE_VSIX_BYTES) {
      getLogger().appendLine(
        `[${new Date().toISOString()}] Skipping private extension ${install.id}: packed file is ${written.size} bytes, over the ${MAX_PRIVATE_VSIX_BYTES} byte sync limit`
      );
      return false;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    try {
      await fs.rename(temporary, destination);
    } catch {
      await fs.copyFile(temporary, destination);
    }
    return true;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

type ListedFile = {
  abs: string;
  zipPath: string;
  mtimeMs: number;
};

type PackedFile = {
  zipPath: string;
  data: Buffer;
  mtimeMs: number;
};

async function listExtensionFiles(
  dir: string,
  zipDir: string,
  listed: ListedFile[],
  budget: { total: number }
): Promise<boolean> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink() || entry.name === ".git") {
      continue;
    }
    const abs = path.join(dir, entry.name);
    const zipPath = `${zipDir}/${entry.name}`;
    if (entry.isDirectory()) {
      const ok = await listExtensionFiles(abs, zipPath, listed, budget);
      if (!ok) {
        return false;
      }
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    const stat = await fs.stat(abs);
    budget.total += stat.size;
    if (budget.total > MAX_PRIVATE_VSIX_BYTES) {
      return false;
    }
    listed.push({ abs, zipPath, mtimeMs: stat.mtimeMs });
  }
  return true;
}

function buildStoredZip(install: PrivateInstall, files: readonly PackedFile[]): Buffer {
  const [publisher, name] = install.id.split(".");
  const manifest = Buffer.from(vsixManifest(publisher ?? install.id, name ?? install.id, install.version), "utf-8");
  const contentTypes = Buffer.from(contentTypesXml(files), "utf-8");
  const payload: PackedFile[] = [
    { zipPath: "[Content_Types].xml", data: contentTypes, mtimeMs: 0 },
    { zipPath: "extension.vsixmanifest", data: manifest, mtimeMs: 0 },
    ...files,
  ];
  return writeStoredZip(payload);
}

function vsixManifest(publisher: string, name: string, version: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xmlEscape(name)}" Version="${xmlEscape(version)}" Publisher="${xmlEscape(publisher)}" />
    <DisplayName>${xmlEscape(name)}</DisplayName>
    <Description>Synced local extension package</Description>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code"/>
  </Installation>
  <Dependencies/>
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
`;
}

function contentTypeForExtension(ext: string): string {
  if (ext === "json") {
    return "application/json";
  }
  if (ext === "xml" || ext === "vsixmanifest") {
    return "text/xml";
  }
  return "application/octet-stream";
}

function contentTypesXml(files: readonly PackedFile[]): string {
  const defaults = new Set<string>(["vsixmanifest", "xml", "json"]);
  const overrides: string[] = [];
  for (const file of files) {
    const base = file.zipPath.split("/").pop() ?? "";
    const dot = base.lastIndexOf(".");
    if (dot <= 0 || dot === base.length - 1) {
      overrides.push(
        `  <Override PartName="/${xmlEscape(file.zipPath)}" ContentType="application/octet-stream" />`
      );
      continue;
    }
    defaults.add(base.slice(dot + 1).toLowerCase());
  }
  const defaultLines = [...defaults]
    .sort()
    .map(
      (ext) =>
        `  <Default Extension="${xmlEscape(ext)}" ContentType="${contentTypeForExtension(ext)}" />`
    );
  return `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
${defaultLines.join("\n")}
${overrides.join("\n")}
</Types>
`;
}

function xmlEscape(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function writeStoredZip(files: readonly PackedFile[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const name = Buffer.from(file.zipPath, "utf-8");
    const crc = crc32(file.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, file.data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);
    offset += local.length + name.length + file.data.length;
  }
  const centralDir = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDir.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralDir, end]);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) {
    c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}
