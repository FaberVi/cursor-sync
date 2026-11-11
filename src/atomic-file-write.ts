import * as fs from "node:fs/promises";

const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableRenameError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return Boolean(code && RETRYABLE_RENAME_CODES.has(code));
}

async function renameWithRetry(tmp: string, absPath: string): Promise<void> {
  const maxAttempts = process.platform === "win32" ? 8 : 3;
  let lastErr: unknown;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      await fs.rename(tmp, absPath);
      return;
    } catch (err) {
      lastErr = err;
      if (!isRetryableRenameError(err) || attempt >= maxAttempts - 1) {
        break;
      }
      await sleep(Math.min(50 * 2 ** attempt, 500));
    }
  }

  if (process.platform === "win32") {
    try {
      await fs.copyFile(tmp, absPath);
      await fs.unlink(tmp);
      return;
    } catch (fallbackErr) {
      throw lastErr ?? fallbackErr;
    }
  }

  throw lastErr;
}

export async function writeAtomicFile(
  absPath: string,
  content: Buffer,
  ensureParent: (absPath: string) => Promise<void>
): Promise<void> {
  await ensureParent(absPath);
  const tmp = `${absPath}.tmp`;
  await fs.writeFile(tmp, content);
  await renameWithRetry(tmp, absPath);
}
