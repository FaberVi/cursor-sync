import * as fs from "node:fs/promises";
import * as vscode from "vscode";
import { resolveSyncRoots } from "./paths.js";
import { revealFsPathInOs } from "./reveal-fs-path.js";
import { t } from "./sidebar/i18n.js";

type CursorDataFolder = "dotCursor" | "cursorUser";

interface FolderTarget {
  id: CursorDataFolder;
  fsPath: string;
  label: string;
}

function listCursorDataFolders(): FolderTarget[] {
  const roots = resolveSyncRoots();
  return [
    {
      id: "dotCursor",
      fsPath: roots.dotCursor,
      label: t("openCursorFolderDotCursor"),
    },
    {
      id: "cursorUser",
      fsPath: roots.cursorUser,
      label: t("openCursorFolderUser"),
    },
  ];
}

async function ensureFolderExists(fsPath: string): Promise<void> {
  try {
    await fs.mkdir(fsPath, { recursive: true });
  } catch {
    // reveal may still work if the parent exists
  }
}

async function openFolderTarget(target: FolderTarget): Promise<void> {
  await ensureFolderExists(target.fsPath);
  await revealFsPathInOs(target.fsPath);
}

/** Open ~/.cursor or Cursor User in the OS file manager. */
export async function executeOpenCursorFolder(
  options: { pick?: boolean; folder?: CursorDataFolder } = {}
): Promise<void> {
  const folders = listCursorDataFolders();
  const preset = options.folder
    ? folders.find((entry) => entry.id === options.folder)
    : undefined;

  if (preset && !options.pick) {
    await openFolderTarget(preset);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    folders.map((entry) => ({
      id: entry.id,
      label: entry.label,
      description: entry.fsPath,
    })),
    { placeHolder: t("openCursorFolderPick") }
  );
  if (!picked) {
    return;
  }
  const target = folders.find((entry) => entry.id === picked.id);
  if (!target) {
    return;
  }
  await openFolderTarget(target);
}
