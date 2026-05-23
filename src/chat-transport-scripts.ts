import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

export type TransportChatScriptName =
  | "cursor_chat_io.py"
  | "cursor_composer_bridge.py";

export async function resolveTransportChatScript(
  scriptName: TransportChatScriptName,
  extensionPath?: string
): Promise<string | null> {
  const overrideDir = vscode.workspace
    .getConfiguration("cursorSync")
    .get<string>("chatImport.transportChatScriptDir");

  const candidates: string[] = [];

  if (overrideDir) {
    candidates.push(path.join(overrideDir, scriptName));
  }

  if (extensionPath) {
    candidates.push(
      path.join(extensionPath, "resources", "transport-chat", "scripts", scriptName)
    );
    candidates.push(path.join(extensionPath, "scripts", scriptName));
    candidates.push(path.join(extensionPath, "..", "scripts", scriptName));
  }
  candidates.push(path.join(process.cwd(), "scripts", scriptName));
  candidates.push(
    path.join(process.cwd(), "resources", "transport-chat", "scripts", scriptName)
  );

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return path.resolve(candidate);
    } catch {
      continue;
    }
  }
  return null;
}

export interface RunPythonDiskImportOptions {
  bundlePath: string;
  workspaceFolder: string;
  /** Remap transcript paths to this ~/.cursor/projects folder name. */
  targetProject?: string;
  stateDbPath?: string;
  dryRun?: boolean;
  syncGlobal?: boolean;
  pinRecent?: boolean;
  extensionPath?: string;
  log?: (message: string) => void;
}

export interface RunPythonDiskImportResult {
  ok: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export async function runPythonDiskImport(
  options: RunPythonDiskImportOptions
): Promise<RunPythonDiskImportResult> {
  const log = options.log ?? (() => {});
  const scriptPath = await resolveTransportChatScript(
    "cursor_chat_io.py",
    options.extensionPath
  );
  if (!scriptPath) {
    return {
      ok: false,
      exitCode: 1,
      stdout: "",
      stderr: "transport-chat script not found (cursor_chat_io.py not in extension resources or fallback paths)",
    };
  }

  const args = [
    scriptPath,
    "import",
    options.bundlePath,
    "--workspace-folder",
    options.workspaceFolder,
  ];
  if (options.targetProject?.trim()) {
    args.push("--target-project", options.targetProject.trim());
  }
  if (options.stateDbPath) {
    args.push("--state-db", options.stateDbPath);
  }
  if (options.dryRun) {
    args.push("--dry-run");
  }
  if (options.syncGlobal === false) {
    args.push("--no-global-state");
  }
  if (options.pinRecent === false) {
    args.push("--no-pin-recent");
  }

  const { exitCode, stdout, stderr } = await new Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
  }>((resolve, reject) => {
    const proc = spawn("python3", args, { cwd: options.workspaceFolder });
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

  for (const line of stderr.trim().split("\n")) {
    if (line.trim()) {
      log(`chat_io: ${line}`);
    }
  }
  for (const line of stdout.trim().split("\n")) {
    if (line.trim()) {
      log(`chat_io: ${line}`);
    }
  }

  return { ok: exitCode === 0, exitCode, stdout, stderr };
}
