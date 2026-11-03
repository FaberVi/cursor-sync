/** Compact elapsed for sidebar: `12s`, `1m 08s`. */
export function formatElapsedMs(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  if (totalSec < 60) {
    return `${totalSec}s`;
  }
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Log-friendly elapsed: `0.8s`, `12.4s`, `1m 08.0s`. */
export function formatElapsedPrecise(ms: number): string {
  const clamped = Math.max(0, ms);
  const sec = clamped / 1000;
  if (sec < 60) {
    return `${sec.toFixed(1)}s`;
  }
  const minutes = Math.floor(sec / 60);
  const remainder = sec - minutes * 60;
  return `${minutes}m ${remainder.toFixed(1)}s`;
}
