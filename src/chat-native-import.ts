import type * as vscode from "vscode";
import type { ChatBundle, LoadChatResult, RestoreChatBundleOptions } from "./chat-persistence.js";
import { restoreChatBundlesBatch } from "./chat-import-ux.js";
import { chatBundleFromNativeChatJson, nativeChatJsonFromBundle } from "./native-chat-json/bundle-bridge.js";
import type { NativeChatJsonDocument } from "./native-chat-json/types.js";

export async function restoreNativeChatJson(
  context: vscode.ExtensionContext,
  doc: NativeChatJsonDocument,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options: RestoreChatBundleOptions = {}
): Promise<LoadChatResult> {
  const bundle = chatBundleFromNativeChatJson(doc);
  const { restoreChatBundle } = await import("./chat-persistence.js");
  return restoreChatBundle(context, bundle, progress, options);
}

export async function restoreNativeChatsBatch(
  context: vscode.ExtensionContext,
  docs: NativeChatJsonDocument[],
  restoreOptions: RestoreChatBundleOptions,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  logTag: "chat-load" | "gist-chat-import" | "chat-sync"
): Promise<import("./chat-import-ux.js").BatchChatImportResult> {
  const bundles: ChatBundle[] = docs.map(chatBundleFromNativeChatJson);
  return restoreChatBundlesBatch(context, bundles, restoreOptions, progress, logTag);
}

export function nativeDocsFromBundles(bundles: ChatBundle[]): NativeChatJsonDocument[] {
  return bundles.map(nativeChatJsonFromBundle);
}
