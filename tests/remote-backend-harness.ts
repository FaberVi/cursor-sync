import { afterEach, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

let originalFetch: typeof fetch | undefined;

export type FetchImpl = (
  input: RequestInfo | URL,
  init?: RequestInit
) => Promise<Response>;

/** Shared mock-fetch factory used by RepoBackend snapshot/write tests. */
export function mockFetch(impl: FetchImpl): ReturnType<typeof vi.fn> {
  if (originalFetch === undefined) {
    originalFetch = globalThis.fetch;
  }
  const fn = vi.fn(impl) as typeof fetch;
  globalThis.fetch = fn;
  return fn as unknown as ReturnType<typeof vi.fn>;
}

export function restoreRemoteFetch(): void {
  if (originalFetch !== undefined) {
    globalThis.fetch = originalFetch;
  }
  vi.useRealTimers();
}

export function restoreRemoteFetchAfterEach(): void {
  afterEach(() => {
    restoreRemoteFetch();
  });
}
