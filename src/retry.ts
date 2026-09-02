import type { ApiResult, ApiError, FailureCategory } from "./types.js";
import { cancelledApiError, getSyncAbortSignal } from "./sync-abort.js";

const MAX_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MULTIPLIER = 3;
/** Upper bound for Retry-After driven sleeps (seconds). */
export const MAX_RETRY_AFTER_SECONDS = 120;

const NON_RETRYABLE_CODES = new Set([401, 403, 404, 422]);

export function clampRetryAfterSeconds(retryAfter: number | undefined): number | undefined {
  if (retryAfter === undefined || !Number.isFinite(retryAfter) || retryAfter <= 0) {
    return undefined;
  }
  return Math.min(Math.floor(retryAfter), MAX_RETRY_AFTER_SECONDS);
}

function isCancelledError(error?: ApiError): boolean {
  return error?.category === "CANCELLED" || getSyncAbortSignal()?.aborted === true;
}

export async function withRetry<T>(
  fn: () => Promise<ApiResult<T>>
): Promise<ApiResult<T>> {
  let lastError: ApiError | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (getSyncAbortSignal()?.aborted) {
      return { ok: false, error: cancelledApiError };
    }

    const result = await fn();

    if (result.ok) {
      return result;
    }

    lastError = result.error;

    if (isCancelledError(result.error)) {
      return result;
    }

    if (result.error.statusCode && NON_RETRYABLE_CODES.has(result.error.statusCode)) {
      return result;
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      const capped = clampRetryAfterSeconds(result.error.retryAfter);
      const delay = capped
        ? capped * 1000
        : BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
      const slept = await abortableSleep(delay);
      if (!slept) {
        return { ok: false, error: cancelledApiError };
      }
    }
  }

  return {
    ok: false,
    error: lastError ?? {
      category: "UNKNOWN" as FailureCategory,
      message: "All retry attempts exhausted",
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Returns false if aborted before the delay elapsed. */
async function abortableSleep(ms: number): Promise<boolean> {
  const signal = getSyncAbortSignal();
  if (!signal) {
    await sleep(ms);
    return true;
  }
  if (signal.aborted) {
    return false;
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
