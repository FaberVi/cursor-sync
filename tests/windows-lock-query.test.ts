import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { LOCK_QUERY_SCRIPT, parseLockQueryStdout } from "../src/windows-lock-query-script.js";

const execFileAsync = promisify(execFile);

const HOLD_SCRIPT = `
$stream = [System.IO.File]::Open(
  $env:CURSOR_SYNC_HOLD_FILE,
  [System.IO.FileMode]::Open,
  [System.IO.FileAccess]::Read,
  [System.IO.FileShare]::None
)
Write-Output 'HOLDING'
[Console]::Out.Flush()
Start-Sleep -Seconds 60
$stream.Close()
`;

function waitForOutput(child: ChildProcess, needle: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`timed out waiting for ${needle}: ${buffer}`));
    }, timeoutMs);
    const onData = (chunk: Buffer): void => {
      buffer += chunk.toString("utf8");
      if (buffer.includes(needle)) {
        finish();
      }
    };
    const onExit = (code: number | null): void => {
      finish(new Error(`holder exited ${code} before ${needle}: ${buffer}`));
    };
    const finish = (err?: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.off("data", onData);
      child.off("exit", onExit);
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    };
    child.stdout?.on("data", onData);
    child.once("exit", onExit);
  });
}

describe("parseLockQueryStdout", () => {
  it("merges batches and skips a broken line", () => {
    const stdout = [
      'LOCKS_JSON:[{"pid":7,"name":"notepad","path":"C:\\\\Windows\\\\notepad.exe","appType":1}]',
      "LOCKS_JSON:not-json",
      'LOCKS_JSON:[{"pid":7,"name":"notepad","path":"","appType":1},{"pid":9,"name":"powershell","path":"C:\\\\pwsh.exe","appType":5}]',
    ].join("\n");
    const processes = parseLockQueryStdout(stdout);
    expect(processes.map((proc) => proc.pid)).toEqual([7, 9]);
    expect(processes[0]?.path).toBe("C:\\Windows\\notepad.exe");
    expect(processes[1]?.appType).toBe(5);
  });

  it("returns nothing when the query printed no marker", () => {
    expect(parseLockQueryStdout("")).toEqual([]);
  });
});

describe.skipIf(process.platform !== "win32")("windows lock query batches", () => {
  it("finds a process that holds a file past the first batch", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "cursor-sync-lock-"));
    const dir = path.join(root, "skill");
    await mkdir(dir);
    await writeFile(path.join(dir, "a.txt"), "a");
    const locked = path.join(dir, "z.txt");
    await writeFile(locked, "z");

    const holder = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", HOLD_SCRIPT], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, CURSOR_SYNC_HOLD_FILE: locked },
    });

    try {
      await waitForOutput(holder, "HOLDING", 15_000);
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LOCK_QUERY_SCRIPT],
        {
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 4 * 1024 * 1024,
          env: {
            ...process.env,
            CURSOR_SYNC_LOCK_PATH: dir,
            CURSOR_SYNC_LOCK_BATCH: "1",
          },
        }
      );
      const processes = parseLockQueryStdout(stdout);
      expect(processes.some((proc) => proc.pid === holder.pid)).toBe(true);
    } finally {
      if (holder.pid) {
        await execFileAsync("taskkill", ["/F", "/PID", String(holder.pid)]).catch(() => undefined);
      }
      holder.kill();
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
