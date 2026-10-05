import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { revealFsPathInOs } from "./reveal-fs-path.js";
import { getSyncClonePath } from "./sync-clone.js";

export async function executeOpenSyncClone(
  context: vscode.ExtensionContext
): Promise<void> {
  const clonePath = getSyncClonePath(context);
  try {
    const st = await fs.stat(clonePath);
    if (!st.isDirectory()) {
      vscode.window.showWarningMessage(
        "The local sync clone is missing. Connect a repository and run Pull or Push first."
      );
      return;
    }
  } catch {
    vscode.window.showWarningMessage(
      "The local sync clone is missing. Connect a repository and run Pull or Push first."
    );
    return;
  }
  await revealFsPathInOs(clonePath);
}
