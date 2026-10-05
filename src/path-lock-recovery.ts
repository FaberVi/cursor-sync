import { execFile } from "node:child_process";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { getLogger } from "./diagnostics.js";
import { removePathWithRetry } from "./remove-path-with-retry.js";
import { t } from "./sidebar/i18n.js";

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

type WindowsProcessRef = {
  ProcessId: number;
  Name: string;
};

function escapePowerShellSingleQuoted(value: string): string {
  return value.replace(/'/g, "''");
}

function protectedProcessIds(): number[] {
  const ids = [process.pid];
  if (process.ppid) {
    ids.push(process.ppid);
  }
  return ids;
}

async function runPowerShellJson<T>(script: string): Promise<T | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
    );
    const trimmed = stdout.trim();
    if (!trimmed) {
      return undefined;
    }
    return JSON.parse(trimmed) as T;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    getLogger().appendLine(
      `[${new Date().toISOString()}] path-lock-recovery PowerShell failed: ${msg}`
    );
    return undefined;
  }
}

async function listWindowsProcessesUsingPath(
  absPath: string
): Promise<Array<{ pid: number; name: string }>> {
  if (process.platform !== "win32") {
    return [];
  }
  const protectedIds = protectedProcessIds();
  const pathLiteral = escapePowerShellSingleQuoted(absPath);
  const needle = escapePowerShellSingleQuoted(path.basename(absPath));
  const script = `
$path = '${pathLiteral}'
$needle = '${needle}'
$protected = @(${protectedIds.join(",")})
$blockedNames = @('Cursor','Code')
$matches = Get-CimInstance Win32_Process | Where-Object {
  $_.ProcessId -notin $protected -and
  ($blockedNames -notcontains ($_.Name -replace '\\.exe$','')) -and
  $_.CommandLine -and (
    $_.CommandLine -like "*$needle*" -or $_.CommandLine -like "*$path*"
  )
} | Select-Object ProcessId, Name
if (-not $matches) { return }
if ($matches -is [array]) { $matches | ConvertTo-Json -Compress } else { @($matches) | ConvertTo-Json -Compress }
`;
  const parsed = await runPowerShellJson<WindowsProcessRef | WindowsProcessRef[]>(script);
  if (!parsed) {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows
    .filter((row) => row && Number.isFinite(row.ProcessId) && row.Name)
    .map((row) => ({ pid: row.ProcessId, name: row.Name }));
}

async function stopWindowsProcesses(
  processes: Array<{ pid: number; name: string }>
): Promise<string[]> {
  const stopped: string[] = [];
  for (const proc of processes) {
    try {
      await execFileAsync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], {
        windowsHide: true,
      });
      stopped.push(`${proc.name} (${proc.pid})`);
      getLogger().appendLine(
        `[${new Date().toISOString()}] path-lock-recovery stopped ${proc.name} pid=${proc.pid}`
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
  const candidates = await listWindowsProcessesUsingPath(absPath);
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

/**
 * Delete path; on Windows lock errors, offer retry or guided process stop (never Cursor/Code).
 */
export async function removePathResolvingLocks(
  absPath: string,
  options: { recursive?: boolean; emptyDir?: boolean } = {}
): Promise<void> {
  for (;;) {
    try {
      await removePathWithRetry(absPath, options);
      return;
    } catch (err) {
      if (!isPathLockError(err)) {
        throw err;
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
