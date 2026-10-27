import { execFile } from "node:child_process";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { removePathWithRetry } from "./remove-path-with-retry.js";
import { t } from "./sidebar/i18n.js";
import {
  LOCK_QUERY_MARKER,
  LOCK_QUERY_SCRIPT,
  parseLockQueryStdout,
} from "./windows-lock-query-script.js";

const execFileAsync = promisify(execFile);

const PATH_LOCK_CODES = new Set(["EBUSY", "EPERM", "EACCES", "ENOTEMPTY"]);

export function isPathLockError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code && PATH_LOCK_CODES.has(code)) {
    return true;
  }
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return msg.includes("busy") || msg.includes("locked");
}

type LockRecoveryChoice = "retry" | "cancel" | "force";

export interface LockingProcess {
  pid: number;
  name: string;
  path: string;
  /** Restart Manager application type. 1000 is RmCritical and is never closed. */
  appType?: number;
}

/** Restart Manager `RmCritical`: shutting these down can take the machine with them. */
export const RESTART_MANAGER_CRITICAL_APP = 1000;

const HOST_PROCESS_NAMES = new Set(["cursor", "code"]);

const CRITICAL_PROCESS_NAMES = new Set([
  "system",
  "idle",
  "registry",
  "secure system",
  "memory compression",
  "csrss",
  "wininit",
  "winlogon",
  "lsass",
  "lsaiso",
  "services",
  "smss",
  "dwm",
  "fontdrvhost",
  "svchost",
]);

function processKey(name: string): string {
  return name.trim().toLowerCase().replace(/\.exe$/, "");
}

/** Cursor and VS Code stay open. Match the executable, not a name that merely contains "cursor". */
export function isHostIdeProcess(name: string, executablePath: string): boolean {
  const candidates = [name, executablePath ? path.win32.basename(executablePath) : ""];
  return candidates.some((candidate) => HOST_PROCESS_NAMES.has(processKey(candidate)));
}

function isCriticalProcess(proc: LockingProcess): boolean {
  const keys = [processKey(proc.name)];
  if (proc.path) {
    keys.push(processKey(path.win32.basename(proc.path)));
  }
  return keys.some((key) => CRITICAL_PROCESS_NAMES.has(key));
}

/**
 * Refuses a drive root, a very short path, and the user profile so a bad target
 * cannot scan the whole disk.
 */
export function isSafeLockReleaseTarget(targetPath: string): boolean {
  const resolved = path.resolve(targetPath);
  const root = path.parse(resolved).root;
  if (!root || resolved.toLowerCase() === root.toLowerCase()) {
    return false;
  }
  const parts = path.relative(root, resolved).split(path.sep).filter(Boolean);
  if (parts.length < 3) {
    return false;
  }
  return resolved.toLowerCase() !== path.resolve(os.homedir()).toLowerCase();
}

export function selectStoppableLockers(
  processes: readonly LockingProcess[],
  protectedIds: readonly number[]
): LockingProcess[] {
  const protectedSet = new Set(protectedIds);
  const selected: LockingProcess[] = [];
  const seen = new Set<number>();
  for (const proc of processes) {
    if (
      !Number.isInteger(proc.pid) ||
      proc.pid <= 4 ||
      seen.has(proc.pid) ||
      protectedSet.has(proc.pid) ||
      proc.appType === RESTART_MANAGER_CRITICAL_APP
    ) {
      continue;
    }
    seen.add(proc.pid);
    if (isHostIdeProcess(proc.name, proc.path) || isCriticalProcess(proc)) {
      continue;
    }
    selected.push(proc);
  }
  return selected;
}

function sameProcessImage(expected: LockingProcess, liveName: string): boolean {
  const liveKey = processKey(liveName);
  const expectedKeys = [processKey(expected.name)];
  if (expected.path) {
    expectedKeys.push(processKey(path.win32.basename(expected.path)));
  }
  return expectedKeys.includes(liveKey);
}

function protectedProcessIds(): number[] {
  const ids = [process.pid];
  if (process.ppid) {
    ids.push(process.ppid);
  }
  return ids;
}

async function listWindowsProcessesUsingPath(absPath: string): Promise<LockingProcess[]> {
  if (process.platform !== "win32" || !isSafeLockReleaseTarget(absPath)) {
    return [];
  }
  let stdout = "";
  let detail = "";
  try {
    const result = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", LOCK_QUERY_SCRIPT],
      {
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
        timeout: 20_000,
        env: { ...process.env, CURSOR_SYNC_LOCK_PATH: path.resolve(absPath) },
      }
    );
    stdout = result.stdout ?? "";
    detail = (result.stderr ?? "").trim();
  } catch (err) {
    const failed = err as { stdout?: string; stderr?: string; message?: string };
    stdout = failed.stdout ?? "";
    detail = (failed.stderr || failed.message || String(err)).trim();
  }

  if (!stdout.includes(LOCK_QUERY_MARKER)) {
    getLogger().appendLine(
      `[${new Date().toISOString()}] path-lock-recovery could not list processes locking ${absPath}: ${detail || "no LOCKS_JSON"}`
    );
    return [];
  }
  return parseLockQueryStdout(stdout);
}

async function readLiveProcessName(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "tasklist.exe",
      ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
      { windowsHide: true, timeout: 10_000 }
    );
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.trim().match(/^"([^"]*)","(\d+)"/);
      if (match && Number(match[2]) === pid) {
        return match[1];
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().appendLine(
      `[${new Date().toISOString()}] path-lock-recovery tasklist failed pid=${pid}: ${msg}`
    );
  }
  return undefined;
}

async function stopWindowsProcesses(processes: LockingProcess[]): Promise<string[]> {
  const stopped: string[] = [];
  for (const proc of processes) {
    const liveName = await readLiveProcessName(proc.pid);
    if (!liveName || !sameProcessImage(proc, liveName)) {
      getLogger().appendLine(
        `[${new Date().toISOString()}] path-lock-recovery skipped pid=${proc.pid}: process image changed`
      );
      continue;
    }
    const stillStoppable = selectStoppableLockers(
      [{ ...proc, name: liveName, path: liveName }],
      protectedProcessIds()
    );
    if (stillStoppable.length !== 1) {
      continue;
    }
    try {
      await execFileAsync("taskkill", ["/F", "/PID", String(proc.pid)], {
        windowsHide: true,
        timeout: 15_000,
      });
      const label = proc.name || path.win32.basename(proc.path) || String(proc.pid);
      stopped.push(`${label} (${proc.pid})`);
      getLogger().appendLine(
        `[${new Date().toISOString()}] path-lock-recovery stopped ${label} pid=${proc.pid}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      getLogger().appendLine(
        `[${new Date().toISOString()}] path-lock-recovery taskkill failed pid=${proc.pid}: ${msg}`
      );
    }
  }
  return stopped;
}

async function promptForceStopProcesses(
  absPath: string,
  processes: Array<{ pid: number; name: string }>
): Promise<boolean> {
  const list = processes.map((p) => `${p.name} (${p.pid})`).join(", ");
  const choice = await vscode.window.showWarningMessage(
    t("pathLockForceConfirm", { path: absPath, processes: list }),
    { modal: true },
    t("pathLockForceProceed"),
    t("pathLockCancel")
  );
  return choice === t("pathLockForceProceed");
}

async function promptPathLockRecovery(absPath: string): Promise<LockRecoveryChoice> {
  const displayPath = absPath;
  const choice = await vscode.window.showWarningMessage(
    t("pathLockBlocked", { path: displayPath }),
    { modal: true },
    t("pathLockForce"),
    t("pathLockRetry"),
    t("pathLockCancel")
  );
  if (choice === t("pathLockForce")) {
    return "force";
  }
  if (choice === t("pathLockRetry")) {
    return "retry";
  }
  return "cancel";
}

async function forceUnlockPath(absPath: string): Promise<void> {
  if (process.platform !== "win32") {
    void vscode.window.showInformationMessage(t("pathLockForceUnsupported"));
    return;
  }
  const candidates = selectStoppableLockers(
    await listWindowsProcessesUsingPath(absPath),
    protectedProcessIds()
  );
  if (candidates.length === 0) {
    const choice = await vscode.window.showWarningMessage(
      t("pathLockNoExternalProcess", { path: absPath }),
      { modal: true },
      t("pathLockReloadWindow"),
      t("pathLockCancel")
    );
    if (choice === t("pathLockReloadWindow")) {
      await vscode.commands.executeCommand("workbench.action.reloadWindow");
    }
    return;
  }
  const proceed = await promptForceStopProcesses(absPath, candidates);
  if (!proceed) {
    return;
  }
  const stopped = await stopWindowsProcesses(candidates);
  if (stopped.length === 0) {
    void vscode.window.showWarningMessage(t("pathLockStopFailed"));
    return;
  }
  void vscode.window.showInformationMessage(
    t("pathLockStopped", { processes: stopped.join(", ") })
  );
}

async function stopExternalLockers(
  absPath: string,
  alreadyTried: Set<number>
): Promise<string[]> {
  if (process.platform !== "win32") {
    return [];
  }
  const fresh = selectStoppableLockers(
    await listWindowsProcessesUsingPath(absPath),
    protectedProcessIds()
  ).filter((proc) => !alreadyTried.has(proc.pid));
  for (const proc of fresh) {
    alreadyTried.add(proc.pid);
  }
  if (fresh.length === 0) {
    return [];
  }
  return stopWindowsProcesses(fresh);
}

/**
 * Delete path. On Windows, processes that have the path open are closed
 * (never Cursor, VS Code, or this extension host) and the delete is retried.
 * If nothing else can be closed, the user can retry or reload the window.
 */
export async function removePathResolvingLocks(
  absPath: string,
  options: { recursive?: boolean; emptyDir?: boolean } = {}
): Promise<void> {
  const alreadyTried = new Set<number>();
  for (;;) {
    try {
      await removePathWithRetry(absPath, options);
      return;
    } catch (err) {
      if (!isPathLockError(err)) {
        throw err;
      }
      const stopped = await stopExternalLockers(absPath, alreadyTried);
      if (stopped.length > 0) {
        void vscode.window.showInformationMessage(
          t("pathLockStopped", { processes: stopped.join(", ") })
        );
        continue;
      }
      const choice = await promptPathLockRecovery(absPath);
      if (choice === "cancel") {
        throw err;
      }
      if (choice === "force") {
        await forceUnlockPath(absPath);
      }
    }
  }
}
