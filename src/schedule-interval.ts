import type * as vscode from "vscode";

export const MIN_INTERVAL_SECONDS = 30;
export const MAX_INTERVAL_SECONDS = 24 * 60 * 60;
export const DEFAULT_INTERVAL = 30;
export const DEFAULT_INTERVAL_UNIT: ScheduleIntervalUnit = "minutes";

export type ScheduleIntervalUnit = "seconds" | "minutes";

export interface ResolvedScheduleInterval {
  enabled: boolean;
  intervalMs: number;
  /** Effective interval in seconds after clamping. */
  intervalSeconds: number;
  unit: ScheduleIntervalUnit;
  /** Display value in the configured unit (after clamp). */
  displayValue: number;
}

/**
 * Resolve auto-sync interval from settings.
 * Prefers schedule.interval + schedule.intervalUnit; falls back to deprecated schedule.intervalMin (minutes).
 */
export function resolveScheduleInterval(
  config: vscode.WorkspaceConfiguration
): ResolvedScheduleInterval {
  const enabled = config.get<boolean>("schedule.enabled") ?? true;
  const unitRaw = config.get<string>("schedule.intervalUnit");
  const unit: ScheduleIntervalUnit =
    unitRaw === "seconds" || unitRaw === "minutes"
      ? unitRaw
      : DEFAULT_INTERVAL_UNIT;

  const inspectedInterval =
    typeof config.inspect === "function"
      ? config.inspect<number>("schedule.interval")
      : undefined;
  const hasExplicitInterval =
    inspectedInterval?.globalValue !== undefined ||
    inspectedInterval?.workspaceValue !== undefined ||
    inspectedInterval?.workspaceFolderValue !== undefined;

  let rawValue: number;
  let effectiveUnit = unit;

  if (hasExplicitInterval) {
    rawValue = config.get<number>("schedule.interval") ?? DEFAULT_INTERVAL;
  } else {
    const legacyMin = config.get<number>("schedule.intervalMin");
    if (legacyMin !== undefined && legacyMin !== null) {
      rawValue = legacyMin;
      effectiveUnit = "minutes";
    } else {
      rawValue = config.get<number>("schedule.interval") ?? DEFAULT_INTERVAL;
    }
  }

  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    rawValue = DEFAULT_INTERVAL;
    effectiveUnit = DEFAULT_INTERVAL_UNIT;
  }

  let seconds =
    effectiveUnit === "seconds" ? rawValue : rawValue * 60;
  seconds = Math.max(
    MIN_INTERVAL_SECONDS,
    Math.min(MAX_INTERVAL_SECONDS, Math.floor(seconds))
  );

  const displayValue =
    effectiveUnit === "seconds" ? seconds : Math.max(1, Math.round(seconds / 60));

  return {
    enabled,
    intervalMs: seconds * 1000,
    intervalSeconds: seconds,
    unit: effectiveUnit,
    displayValue,
  };
}
