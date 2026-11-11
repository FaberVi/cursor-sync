import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  BULK_FILE_MIN,
  findUnsyncedBulkDirs,
  formatUnsyncedBulkList,
} from "../src/unsynced-bulk.js";

async function writeFiles(dir: string, count: number): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  for (let index = 0; index < count; index += 1) {
    await fs.writeFile(path.join(dir, `file-${index}.txt`), "x");
  }
}

describe("unsynced bulk folders", () => {
  it("reports outside-sync folders by file count, not by name", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-bulk-"));
    const dotCursor = path.join(root, "dot");
    const cursorUser = path.join(root, "user");
    await writeFiles(path.join(dotCursor, "archive-dump"), BULK_FILE_MIN);
    await writeFiles(path.join(dotCursor, "skill-forge-workspaces"), BULK_FILE_MIN - 1);
    await writeFiles(path.join(dotCursor, "skills", "coding"), BULK_FILE_MIN);
    await writeFiles(path.join(dotCursor, "projects", "app"), 3);
    await fs.mkdir(cursorUser, { recursive: true });

    const found = await findUnsyncedBulkDirs({ cursorUser, dotCursor });
    expect(found.map((dir) => dir.label)).toEqual([".cursor/archive-dump"]);
    expect(found[0]?.fileCount).toBe(BULK_FILE_MIN);
    expect(found[0]?.capped).toBe(false);
    expect(formatUnsyncedBulkList(found)).toContain(".cursor/archive-dump");
    expect(formatUnsyncedBulkList(found)).toContain(`${BULK_FILE_MIN} files`);

    await fs.rm(root, { recursive: true, force: true });
  });
});
