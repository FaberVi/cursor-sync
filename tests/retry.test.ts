import { describe, it, expect, vi } from "vitest";
import { clampRetryAfterSeconds, MAX_RETRY_AFTER_SECONDS, withRetry } from "../src/retry.js";

describe("retry", () => {
  it("clamps Retry-After to MAX_RETRY_AFTER_SECONDS", () => {
    expect(clampRetryAfterSeconds(999_999)).toBe(MAX_RETRY_AFTER_SECONDS);
    expect(clampRetryAfterSeconds(30)).toBe(30);
    expect(clampRetryAfterSeconds(NaN)).toBeUndefined();
    expect(clampRetryAfterSeconds(-1)).toBeUndefined();
    expect(clampRetryAfterSeconds(0)).toBeUndefined();
  });

  it("does not sleep longer than the clamped Retry-After", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const promise = withRetry(async () => {
      calls += 1;
      if (calls < 2) {
        return {
          ok: false as const,
          error: {
            category: "RATE_LIMITED" as const,
            message: "rate",
            statusCode: 429,
            retryAfter: 10_000,
          },
        };
      }
      return { ok: true as const, data: "ok" };
    });

    await vi.advanceTimersByTimeAsync(MAX_RETRY_AFTER_SECONDS * 1000);
    await expect(promise).resolves.toEqual({ ok: true, data: "ok" });
    expect(calls).toBe(2);
    vi.useRealTimers();
  });
});
