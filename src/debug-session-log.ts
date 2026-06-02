export function agentDebugLog(
  _hypothesisId: string,
  _location: string,
  _message: string,
  _data: Record<string, unknown>,
  _runId = "repro"
): void {}

export function pythonDebugEnv(): NodeJS.ProcessEnv {
  return process.env;
}
