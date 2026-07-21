import type { ApiResult, FailureCategory } from "../types.js";

export const GITHUB_API = "https://api.github.com";
export const USER_AGENT = "cursor-sync-extension";

export async function githubRequest<T>(
  method: string,
  endpoint: string,
  pat: string | undefined,
  body?: unknown,
  transform?: (data: unknown) => T
): Promise<ApiResult<T>> {
  const url = endpoint.startsWith("http") ? endpoint : `${GITHUB_API}${endpoint}`;
  const headers: Record<string, string> = {
    Accept: "application/vnd.github.v3+json",
    "User-Agent": USER_AGENT,
  };

  if (pat) {
    headers.Authorization = `token ${pat}`;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    return {
      ok: false,
      error: {
        category: "NETWORK_ERROR",
        message: err instanceof Error ? err.message : "Network request failed",
      },
    };
  }

  const retryAfterHeader = response.headers.get("Retry-After");

  if (response.status === 429) {
    return {
      ok: false,
      error: {
        category: "RATE_LIMITED",
        message: "GitHub API rate limit exceeded",
        statusCode: 429,
        retryAfter: retryAfterHeader ? parseInt(retryAfterHeader, 10) : 60,
      },
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      error: {
        category: "AUTH_FAILED",
        message: `Authentication failed (${response.status})`,
        statusCode: response.status,
      },
    };
  }

  if (response.status >= 500) {
    return {
      ok: false,
      error: {
        category: "NETWORK_ERROR",
        message: `Server error (${response.status})`,
        statusCode: response.status,
      },
    };
  }

  if (response.status === 404) {
    let message = `Not found (${response.status})`;
    try {
      const errorBody = (await response.json()) as { message?: string };
      if (errorBody.message) {
        message = errorBody.message;
      }
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: {
        category: "UNKNOWN",
        message,
        statusCode: 404,
      },
    };
  }

  if (!response.ok) {
    let errorMessage = `GitHub API error (${response.status})`;
    try {
      const errorBody = (await response.json()) as {
        message?: string;
        errors?: Array<{ message?: string }>;
      };
      if (errorBody.message) {
        errorMessage = errorBody.message;
      }
      if (errorBody.errors?.length) {
        const details = errorBody.errors
          .map((e) => e.message)
          .filter(Boolean)
          .join("; ");
        if (details) {
          errorMessage = `${errorMessage} (${details})`;
        }
      }
    } catch {
      // ignore
    }
    return {
      ok: false,
      error: {
        category: "UNKNOWN" as FailureCategory,
        message: errorMessage,
        statusCode: response.status,
      },
    };
  }

  if (response.status === 204) {
    return { ok: true, data: (transform ? transform(undefined) : undefined) as T };
  }

  try {
    const data = await response.json();
    const result = transform ? transform(data) : (data as T);
    return { ok: true, data: result };
  } catch {
    return {
      ok: false,
      error: {
        category: "UNKNOWN",
        message: "Failed to parse response JSON",
      },
    };
  }
}
