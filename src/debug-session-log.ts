const DEBUG_ENDPOINT =
  "http://127.0.0.1:7508/ingest/28529ffa-a1d4-4a2e-a459-ac5b8454a959";
const DEBUG_SESSION_ID = "f25764";

export function agentDebugLog(
  hypothesisId: string,
  location: string,
  message: string,
  data: Record<string, unknown>,
  runId = "repro"
): void {
  // #region agent log
  fetch(DEBUG_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": DEBUG_SESSION_ID,
    },
    body: JSON.stringify({
      sessionId: DEBUG_SESSION_ID,
      hypothesisId,
      location,
      message,
      data,
      runId,
      timestamp: Date.now(),
    }),
  }).catch(() => {});
  // #endregion
}

export function pythonDebugEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CURSOR_SYNC_DEBUG_LOG: "1",
    CURSOR_SYNC_DEBUG_SESSION: DEBUG_SESSION_ID,
  };
}
