import { spawn, execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import {
  resolvePythonInterpreterForSqlite,
  type PythonSqliteInterpreter,
} from "./transcripts-sqlite.js";

const execFile = promisify(execFileCallback);

export type { PythonSqliteInterpreter };

const PROBE_TIMEOUT_MS = 5000;

/** User-global override only; workspace/folder pythonPath cannot redirect execution. */
export function getUserPythonPath(): string | undefined {
  const inspect = vscode.workspace
    .getConfiguration("cursorSync")
    .inspect?.<string>("chatImport.pythonPath");
  const configured = inspect?.globalValue?.trim();
  return configured || undefined;
}

function interpreterFromConfiguredPath(configured: string): PythonSqliteInterpreter {
  const base = configured.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const argvPrefix = base === "py" || base === "py.exe" ? (["-3"] as const) : [];
  return { command: configured, argvPrefix };
}

async function probeInterpreter(interp: PythonSqliteInterpreter): Promise<boolean> {
  try {
    await execFile(interp.command, [...interp.argvPrefix, "-c", "raise SystemExit(0)"], {
      maxBuffer: 64 * 1024,
      timeout: PROBE_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

export async function resolveChatPythonInterpreter(): Promise<PythonSqliteInterpreter> {
  const configured = getUserPythonPath();
  if (configured) {
    const interp = interpreterFromConfiguredPath(configured);
    if (await probeInterpreter(interp)) {
      return interp;
    }
  }
  return resolvePythonInterpreterForSqlite();
}

export async function runPythonProcess(
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const py = await resolveChatPythonInterpreter();
  const argv = [...py.argvPrefix, ...args];
  return new Promise((resolve, reject) => {
    const proc = spawn(py.command, argv, {
      cwd: options?.cwd,
      env: options?.env ?? process.env,
    });
    let stdoutAcc = "";
    let stderrAcc = "";
    proc.stdout?.on("data", (chunk: Buffer | string) => {
      stdoutAcc += String(chunk);
    });
    proc.stderr?.on("data", (chunk: Buffer | string) => {
      stderrAcc += String(chunk);
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 1, stdout: stdoutAcc, stderr: stderrAcc });
    });
  });
}
