import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  clearStaleResult,
  composerIdFromPartial,
  defaultActivationPaths,
  normalizeActivationManifest,
  stagePendingManifest,
  writeResultJson,
  type ComposerActivationOutcome,
  type RawActivationManifest,
  type RunPythonComposerBridgeOptions,
} from "./chat-activation-manifest.js";
import { resolveComposerBridgeScript } from "./chat-transport-scripts.js";
import { runPythonProcess } from "./chat-python.js";

export function pingServerProbe(
  conversationId: string,
  log: (message: string) => void = () => {}
): void {
  log(
    `note: --ping-server probe not implemented for ${conversationId} ` +
      "(no agentClient HTTP contract in v1; see activation-architecture.md)"
  );
}

export { resolveComposerBridgeScript };

export function parseBridgeStdout(stdout: string): string | null {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  for (const line of trimmed.split("\n")) {
    const row = line.trim();
    if (!row) {
      continue;
    }
    try {
      const data = JSON.parse(row) as Record<string, unknown>;
      const cid = data.composerId;
      if (typeof cid === "string" && cid.trim()) {
        return cid.trim();
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function runPythonComposerBridge(
  rawManifest: RawActivationManifest,
  options: RunPythonComposerBridgeOptions = {}
): Promise<ComposerActivationOutcome> {
  const paths = options.paths ?? defaultActivationPaths();
  const log = options.log ?? (() => {});
  const waitResultMs = Math.max(0, options.waitResultMs ?? 0);
  const partial = rawManifest.partialState as Record<string, unknown>;
  const fallbackComposerId = composerIdFromPartial(partial);

  if (options.dryRun) {
    log("[dry-run] would run python cursor_composer_bridge.py --manifest <tmp>");
    return {
      ok: true,
      composerId: fallbackComposerId,
      exitCode: 0,
      stagedOnly: false,
    };
  }

  const scriptPath =
    options.bridgeScriptPath ?? (await resolveComposerBridgeScript(options.extensionPath));
  if (!scriptPath) {
    log("error: bridge script missing (scripts/cursor_composer_bridge.py)");
    const manifest = normalizeActivationManifest(
      rawManifest as unknown as Record<string, unknown>
    );
    await clearStaleResult(paths);
    await stagePendingManifest(manifest, paths);
    return { ok: false, exitCode: 1, stagedOnly: false };
  }

  const tmpPath = path.join(
    os.tmpdir(),
    `cursor-sync-activation-${Date.now()}.json`
  );
  const args = [scriptPath, "--manifest", tmpPath];
  if (waitResultMs > 0) {
    args.push("--wait-result", String(waitResultMs / 1000));
  }

  try {
    await fs.writeFile(
      tmpPath,
      JSON.stringify(rawManifest, null, 2) + "\n",
      "utf8"
    );

    const { exitCode, stdout, stderr } = await runPythonProcess(args, {
      cwd: rawManifest.workspaceFolder,
    });

    if (stderr.trim()) {
      for (const line of stderr.trim().split("\n")) {
        log(`bridge: ${line}`);
      }
    }

    const composerId = parseBridgeStdout(stdout) ?? fallbackComposerId;
    if (exitCode === 0) {
      await writeResultJson(composerId, true, paths);
      log(`Activation OK (bridge): composerId=${composerId}`);
      return {
        ok: true,
        composerId,
        exitCode: 0,
        stagedOnly: false,
      };
    }

    if (exitCode === 2) {
      log(
        `Activation staged only (exit 2): manifest at ${paths.pendingPath}; Cursor must be open on the workspace.`
      );
      return {
        ok: false,
        composerId: fallbackComposerId,
        exitCode: 2,
        stagedOnly: true,
      };
    }

    log(`error: bridge exited ${exitCode}`);
    return { ok: false, exitCode: 1, stagedOnly: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`bridge subprocess failed: ${message}`);
    return { ok: false, exitCode: 1, stagedOnly: false };
  } finally {
    try {
      await fs.unlink(tmpPath);
    } catch {
      /* ignore */
    }
  }
}
