import * as vscode from "vscode";
import type { ChatBundleFidelitySummary } from "./chat-bundle-fidelity.js";

export type ChatImportPhase = "A" | "B";

export interface ChatImportProgressEvent {
  conversationId: string;
  phase: ChatImportPhase;
  step: string;
  detail?: string;
  ok?: boolean;
  fidelity?: ChatBundleFidelitySummary;
  timestamp: string;
}

let emitterInstance: vscode.EventEmitter<ChatImportProgressEvent> | undefined;

function getEmitter(): vscode.EventEmitter<ChatImportProgressEvent> {
  if (!emitterInstance) {
    emitterInstance = new vscode.EventEmitter<ChatImportProgressEvent>();
  }
  return emitterInstance;
}

export const onChatImportProgress: vscode.Event<ChatImportProgressEvent> = (
  listener,
  thisArgs,
  disposables
) => getEmitter().event(listener, thisArgs, disposables);

export function emitChatImportProgress(
  event: Omit<ChatImportProgressEvent, "timestamp">
): void {
  getEmitter().fire({ ...event, timestamp: new Date().toISOString() });
}

export function disposeChatImportProgress(): void {
  emitterInstance?.dispose();
  emitterInstance = undefined;
}
