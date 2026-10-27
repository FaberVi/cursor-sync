import {
  ACTIVATION_PENDING_PATH,
  ACTIVATION_RESULT_PATH,
} from "./chat-import-activate.js";
import { defaultVerifyIoDeps, type VerifyCheck, type VerifyIoDeps } from "./chat-import-verify.js";

export interface VerifyActivationChecksOptions {
  deps?: Partial<VerifyIoDeps>;
  pendingPath?: string;
  resultPath?: string;
}

export async function verifyActivationChecks(
  conversationId: string,
  options: VerifyActivationChecksOptions = {}
): Promise<VerifyCheck[]> {
  const deps = { ...defaultVerifyIoDeps(), ...options.deps };
  const pendingPath = options.pendingPath ?? ACTIVATION_PENDING_PATH;
  const resultPath = options.resultPath ?? ACTIVATION_RESULT_PATH;
  const checks: VerifyCheck[] = [];

  let pendingCid: string | null = null;
  if (await deps.fileExists(pendingPath)) {
    try {
      const pending = JSON.parse(await deps.readTextFile(pendingPath)) as Record<
        string,
        unknown
      >;
      const raw = pending.composerId;
      if (typeof raw === "string") {
        pendingCid = raw.trim();
      }
      if (!pendingCid) {
        const partial = pending.partialState;
        if (partial && typeof partial === "object" && !Array.isArray(partial)) {
          const pc = (partial as Record<string, unknown>).composerId;
          if (typeof pc === "string") {
            pendingCid = pc.trim();
          }
        }
      }
      if (pendingCid === conversationId) {
        checks.push({
          name: "activation.pending",
          status: "OK",
          detail: `staged for ${conversationId}`,
        });
      } else if (pendingCid) {
        checks.push({
          name: "activation.pending",
          status: "WARN",
          detail: `pending composerId=${JSON.stringify(pendingCid)} (expected ${conversationId})`,
        });
      } else {
        checks.push({
          name: "activation.pending",
          status: "WARN",
          detail: "pending.json has no composerId",
        });
      }
    } catch {
      checks.push({
        name: "activation.pending",
        status: "WARN",
        detail: "pending.json unreadable",
      });
    }
  } else {
    checks.push({
      name: "activation.pending",
      status: "SKIP",
      detail: "no pending.json",
    });
  }

  let resultCid: string | null = null;
  let resultOk = false;
  if (await deps.fileExists(resultPath)) {
    try {
      const result = JSON.parse(await deps.readTextFile(resultPath)) as Record<
        string,
        unknown
      >;
      if (result.ok !== false) {
        const raw = result.composerId;
        if (typeof raw === "string" && raw.trim()) {
          resultCid = raw.trim();
          resultOk = true;
        }
      }
      if (resultOk && resultCid === conversationId) {
        checks.push({
          name: "activation.result",
          status: "OK",
          detail: `composerId=${resultCid}`,
        });
      } else if (resultCid) {
        checks.push({
          name: "activation.result",
          status: "WARN",
          detail: `composerId=${JSON.stringify(resultCid)} (expected ${conversationId})`,
        });
      } else {
        checks.push({
          name: "activation.result",
          status: "WARN",
          detail: "result.json missing composerId",
        });
      }
    } catch {
      checks.push({
        name: "activation.result",
        status: "WARN",
        detail: "result.json unreadable",
      });
    }
  } else {
    checks.push({
      name: "activation.result",
      status: "PENDING",
      detail:
        "awaiting IDE hook, CURSOR_COMPOSER_BRIDGE_COMMAND, or --bridge-wait-result",
    });
  }

  if (resultOk && resultCid === conversationId) {
    checks.push({
      name: "activation.status",
      status: "OK",
      detail: "completed",
    });
  } else if (pendingCid === conversationId) {
    checks.push({
      name: "activation.status",
      status: "PENDING",
      detail: "manifest staged; IDE activation not confirmed",
    });
  } else {
    checks.push({
      name: "activation.status",
      status: "SKIP",
      detail: "no matching activation artifacts for this conversation",
    });
  }

  return checks;
}
