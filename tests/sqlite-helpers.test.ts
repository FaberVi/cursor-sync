import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import { mergeComposerHeadersChain } from "../src/composer-merge.js";
import { __transcriptsTestUtils } from "../src/transcripts.js";

const execFile = promisify(execFileCallback);
const { isCommandMissingError, querySqliteRowsImpl } = __transcriptsTestUtils;

describe("isCommandMissingError", () => {
  it("detects POSIX spawn ENOENT", () => {
    expect(isCommandMissingError(new Error("spawn sqlite3 ENOENT"), "sqlite3")).toBe(true);
    expect(isCommandMissingError(new Error("spawn python3 ENOENT"), "python3")).toBe(true);
  });

  it("detects Windows-style not recognized messages", () => {
    expect(
      isCommandMissingError(
        new Error("'python3' is not recognized as an internal or external command"),
        "python3"
      )
    ).toBe(true);
    expect(
      isCommandMissingError(new Error("'sqlite3' is not recognized as an internal or external command"), "sqlite3")
    ).toBe(true);
  });

  it("detects exit code 9009 hint", () => {
    expect(isCommandMissingError(new Error("Command failed with exit code 9009"), "sqlite3")).toBe(true);
  });

  it("returns false for unrelated failures", () => {
    expect(isCommandMissingError(new Error("SQLITE_BUSY: database is locked"), "sqlite3")).toBe(false);
    expect(isCommandMissingError(new Error("syntax error near foo"), "sqlite3")).toBe(false);
  });
});

describe("querySqliteRowsImpl", () => {
  it("returns parsed rows on success", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: '[{"key":"k","value":"v"}]', stderr: "" });
    const rows = await querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 1 });
    expect(rows).toEqual([{ key: "k", value: "v" }]);
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("returns empty array when stdout is empty", async () => {
    const runQuery = vi.fn().mockResolvedValue({ stdout: "   \n", stderr: "" });
    const rows = await querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 1 });
    expect(rows).toEqual([]);
  });

  it("propagates non-timeout errors immediately", async () => {
    const err = new Error("spawn python3 ENOENT");
    const runQuery = vi.fn().mockRejectedValue(err);
    await expect(querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 3 })).rejects.toThrow(
      "spawn python3 ENOENT"
    );
    expect(runQuery).toHaveBeenCalledTimes(1);
  });

  it("retries on timeout then succeeds", async () => {
    vi.useFakeTimers();
    const timeoutErr = Object.assign(new Error("Command timed out"), {
      killed: true,
      code: "ETIMEDOUT",
    });
    const runQuery = vi
      .fn()
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue({ stdout: "[]", stderr: "" });

    const rowsPromise = querySqliteRowsImpl(runQuery, "/tmp/x.db", "SELECT 1", { retries: 2 });
    await vi.runAllTimersAsync();
    const rows = await rowsPromise;

    expect(rows).toEqual([]);
    expect(runQuery).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});

describe("runSqliteQuery python fallback", () => {
  it("decodes ItemTable BLOB values as UTF-8 text when sqlite3 CLI is missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cursor-sync-sql-"));
    const dbPath = path.join(tmpDir, "state.vscdb");
    const sql =
      "SELECT key, value FROM ItemTable WHERE key = 'composer.composerHeaders';";
    await execFile("python3", [
      "-c",
      [
        "import json, sqlite3, sys",
        "db = sys.argv[1]",
        "payload = json.dumps({'allComposers': [{'composerId': 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'name': 'keep'}]})",
        "conn = sqlite3.connect(db)",
        "conn.execute('CREATE TABLE ItemTable (key TEXT PRIMARY KEY, value BLOB)')",
        "conn.execute('INSERT INTO ItemTable VALUES (?, ?)', ('composer.composerHeaders', payload.encode()))",
        "conn.commit()",
        "conn.close()",
      ].join(";"),
      dbPath,
    ]);

    const pyScript = [
      "import json, sqlite3, sys",
      "def cell(v):",
      "    if isinstance(v, memoryview):",
      "        v = bytes(v)",
      "    if isinstance(v, (bytes, bytearray)):",
      "        return bytes(v).decode('utf-8', errors='replace')",
      "    return v",
      "db_path = sys.argv[1]",
      "sql = sys.argv[2]",
      "conn = sqlite3.connect(db_path)",
      "conn.row_factory = sqlite3.Row",
      "cur = conn.cursor()",
      "cur.execute(sql)",
      "rows = [{k: cell(r[k]) for k in r.keys()} for r in cur.fetchall()]",
      "print(json.dumps(rows))",
      "conn.close()",
    ].join("\n");

    const runQuery = async (_dbPath: string, _sql: string) => {
      const { stdout, stderr } = await execFile("python3", ["-c", pyScript, dbPath, sql]);
      return { stdout, stderr };
    };

    const rows = await querySqliteRowsImpl(runQuery, dbPath, sql, { retries: 1 });
    expect(rows).toHaveLength(1);
    const raw = rows[0]?.value;
    expect(typeof raw).toBe("string");
    expect(raw).not.toMatch(/^[0-9a-f]+$/i);

    const merged = mergeComposerHeadersChain(String(raw), [
      {
        allComposers: [
          {
            composerId: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
            name: "imported",
            type: "head",
          },
        ],
      },
    ]);
    const ids = merged.allComposers.map((c) => c.composerId);
    expect(ids).toContain("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    expect(ids).toContain("bbbbbbbb-cccc-dddd-eeee-ffffffffffff");
  });
});
