import * as fs from "node:fs/promises";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";

const execFileAsync = promisify(execFile);

async function revealPathInOsShell(fsPath: string): Promise<boolean> {
  const normalized = path.normalize(fsPath);
  try {
    const stat = await fs.stat(normalized);
    if (process.platform === "win32") {
      if (stat.isDirectory()) {
        await execFileAsync("explorer.exe", [normalized], { windowsHide: true });
      } else {
        await execFileAsync("explorer.exe", [`/select,${normalized}`], { windowsHide: true });
      }
      return true;
    }
    if (process.platform === "darwin") {
      if (stat.isDirectory()) {
        await execFileAsync("open", [normalized], { windowsHide: true });
      } else {
        await execFileAsync("open", ["-R", normalized], { windowsHide: true });
      }
      return true;
    }
    const target = stat.isDirectory() ? normalized : path.dirname(normalized);
    await execFileAsync("xdg-open", [target], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Reveal a file or folder in the OS file manager (works outside the workspace). */
export async function revealFsPathInOs(fsPath: string): Promise<void> {
  const uri = vscode.Uri.file(fsPath);
  const commands = ["revealFileInOS", "revealInExplorer"] as const;
  for (const commandId of commands) {
    try {
      await vscode.commands.executeCommand(commandId, uri);
      return;
    } catch {
      continue;
    }
  }
  if (await revealPathInOsShell(fsPath)) {
    return;
  }
  try {
    await vscode.env.openExternal(uri);
  } catch {
    void vscode.window.showWarningMessage(`Could not open folder in file manager: ${fsPath}`);
  }
}
