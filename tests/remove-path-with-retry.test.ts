import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removePathWithRetry } from "../src/remove-path-with-retry.js";

describe("remove-path-with-retry", () => {
  let tmp = "";

  afterEach(async () => {
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

});
