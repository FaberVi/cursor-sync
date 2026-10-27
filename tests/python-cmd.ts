import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/** Windows Store `python3` stubs hang; use the py launcher. */
export function pythonArgv(): { command: string; prefix: string[] } {
  if (process.platform === "win32") {
    return { command: "py", prefix: ["-3"] };
  }
  return { command: "python3", prefix: [] };
}

export async function execPython(
  args: string[],
  opts?: { timeout?: number }
): Promise<{ stdout: string; stderr: string }> {
  const { command, prefix } = pythonArgv();
  return execFile(command, [...prefix, ...args], {
    timeout: opts?.timeout ?? 15_000,
    maxBuffer: 16 * 1024 * 1024,
  });
}
