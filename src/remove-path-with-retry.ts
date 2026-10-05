import * as fs from "node:fs/promises";

const RETRYABLE_REMOVE_CODES = new Set(["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"]);

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
