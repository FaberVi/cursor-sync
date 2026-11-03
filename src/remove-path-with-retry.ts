import * as fs from "node:fs/promises";
import * as path from "node:path";

const RETRYABLE_REMOVE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);
const LOCKED_EMPTY_ROOT_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRemoveError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return Boolean(code && RETRYABLE_REMOVE_CODES.has(code));
}

async function removeOnce(
  absPath: string,
  options: { recursive?: boolean; emptyDir?: boolean }
): Promise<void> {
  if (options.recursive) {
    await fs.rm(absPath, { recursive: true, force: true });
    return;
  }
  if (options.emptyDir) {
    await fs.rmdir(absPath);
    return;
  }
  await fs.rm(absPath, { force: true });
}

/**
 * Delete a file or directory; retries transient Windows locks (EBUSY/EPERM).
 */
export async function removePathWithRetry(
  absPath: string,
  options: { recursive?: boolean; emptyDir?: boolean } = {}
): Promise<void> {
  const maxAttempts = process.platform === "win32" ? 8 : 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await removeOnce(absPath, options);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === "ENOENT") {
        return;
      }
      lastErr = err;
      if (!isRetryableRemoveError(err) || attempt >= maxAttempts - 1) {
        break;
      }
      await sleep(Math.min(50 * 2 ** attempt, 500));
    }
  }

  throw lastErr;
}

/**
 * Delete direct children of a directory. The directory itself stays.
 * `ENOENT` on the directory is success (nothing on disk yet).
 */
export async function clearDirectoryChildren(
  absPath: string,
  removeChild: (child: string) => Promise<void>
): Promise<void> {
  let names: string[];
  try {
    names = await fs.readdir(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return;
    }
    throw err;
  }
  for (const name of names) {
    await removeChild(path.join(absPath, name));
  }
}

/**
 * `rmdir` an empty directory. A lock on an already-empty root is `"kept"`.
 * A non-empty directory or any other error is rethrown.
 */
export async function tryRemoveEmptyDirectory(
  absPath: string
): Promise<"removed" | "kept"> {
  try {
    await removePathWithRetry(absPath, { emptyDir: true });
    return "removed";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (!code || !LOCKED_EMPTY_ROOT_CODES.has(code)) {
      throw err;
    }
    let names: string[];
    try {
      names = await fs.readdir(absPath);
    } catch (readErr) {
      const readCode = (readErr as NodeJS.ErrnoException).code;
      if (readCode === "ENOENT") {
        return "removed";
      }
      throw err;
    }
    if (names.length === 0) {
      return "kept";
    }
    throw err;
  }
}
