import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { writeAtomicFile } from "../src/atomic-file-write.js";

describe("atomic-file-write", () => {
  let tmp = "";

  afterEach(async () => {
    vi.restoreAllMocks();
    if (tmp) {
      await fs.rm(tmp, { recursive: true, force: true });
      tmp = "";
    }
  });

  it("writes content atomically via rename", async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-atomic-"));
    const target = path.join(tmp, "nested", "file.txt");
    await writeAtomicFile(target, Buffer.from("hello"), async (absPath) => {
      await fs.mkdir(path.dirname(absPath), { recursive: true });
    });
    await expect(fs.readFile(target, "utf8")).resolves.toBe("hello");
    await expect(fs.access(`${target}.tmp`)).rejects.toThrow();
  });

});
