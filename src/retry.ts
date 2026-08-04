import type { ApiResult, ApiError, FailureCategory } from "./types.js";

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

export async function withRetry<T>(
  fn: () => Promise<ApiResult<T>>
): Promise<ApiResult<T>> {
  let lastError: ApiError | undefined;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const result = await fn();

    if (result.ok) {
      return result;
    }

    lastError = result.error;

    if (result.error.statusCode && NON_RETRYABLE_CODES.has(result.error.statusCode)) {
      return result;
    }

    if (attempt < MAX_ATTEMPTS - 1) {
      const capped = clampRetryAfterSeconds(result.error.retryAfter);
      const delay = capped
        ? capped * 1000
        : BACKOFF_BASE_MS * Math.pow(BACKOFF_MULTIPLIER, attempt);
      await sleep(delay);
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
