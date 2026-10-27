import { afterEach, describe, expect, it, vi } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

const fsGate = vi.hoisted(() => ({
  lockedRmdir: "",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const pathMod = await import("node:path");
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rmdir: (target: Parameters<typeof actual.rmdir>[0]) => {
      if (
        fsGate.lockedRmdir &&
        pathMod.resolve(String(target)) === pathMod.resolve(fsGate.lockedRmdir)
      ) {
        return Promise.reject(Object.assign(new Error("EPERM"), { code: "EPERM" }));
      }
      return actual.rmdir(target);
    },
  };
});

import * as fs from "node:fs/promises";
import {
  clearDirectoryChildren,
  removePathWithRetry,
  tryRemoveEmptyDirectory,
} from "../src/remove-path-with-retry.js";

describe("remove-path-with-retry", () => {
  let tmp = "";

  afterEach(async () => {
    fsGate.lockedRmdir = "";
    vi.restoreAllMocks();
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  it("removes an existing file", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rm-"));
    const file = path.join(tmp, "a.txt");
    await fs.writeFile(file, "x");
    await removePathWithRetry(file);
    await expect(fs.access(file)).rejects.toThrow();
  });

  it("clears children and leaves the directory", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rm-"));
    const nested = path.join(tmp, "nested");
    await fs.mkdir(nested);
    await fs.writeFile(path.join(tmp, "a.txt"), "a");
    await fs.writeFile(path.join(nested, "b.txt"), "b");
    await clearDirectoryChildren(tmp, (child) => removePathWithRetry(child, { recursive: true }));
    expect(await fs.readdir(tmp)).toEqual([]);
    const stat = await fs.stat(tmp);
    expect(stat.isDirectory()).toBe(true);
  });

  it("leaves a file in place when the path is not a directory", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rm-"));
    const file = path.join(tmp, "operations.json");
    await fs.writeFile(file, "{}");
    await clearDirectoryChildren(file, (child) => removePathWithRetry(child, { recursive: true }));
    expect(await fs.readFile(file, "utf8")).toBe("{}");
  });

  it("resolves when the directory is already gone", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rm-"));
    const missing = path.join(tmp, "missing");
    await clearDirectoryChildren(missing, (child) =>
      removePathWithRetry(child, { recursive: true })
    );
  });

  it("removes an empty directory", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rm-"));
    const empty = path.join(tmp, "empty");
    await fs.mkdir(empty);
    await expect(tryRemoveEmptyDirectory(empty)).resolves.toBe("removed");
    await expect(fs.access(empty)).rejects.toThrow();
  });

  it("rethrows when the directory is not empty", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rm-"));
    const full = path.join(tmp, "full");
    await fs.mkdir(full);
    await fs.writeFile(path.join(full, "a.txt"), "a");
    await expect(tryRemoveEmptyDirectory(full)).rejects.toMatchObject({ code: "ENOTEMPTY" });
  }, 15_000);

  it("keeps an empty directory when rmdir is locked", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-rm-"));
    const locked = path.join(tmp, "locked");
    await fs.mkdir(locked);
    fsGate.lockedRmdir = locked;
    await expect(tryRemoveEmptyDirectory(locked)).resolves.toBe("kept");
    expect(await fs.readdir(locked)).toEqual([]);
  }, 15_000);

});
