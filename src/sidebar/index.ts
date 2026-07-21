import * as vscode from "vscode";
import { renderSidebarHtml, renderSyncPaneHtml } from "./html.js";
import { dispatchSidebarMessage, type SidebarMessage } from "./messages.js";
import { onChatImportProgress } from "../chat-progress-events.js";
import { onSyncProgress } from "../sync-progress-events.js";
let sidebarProviderInstance: SidebarProvider | undefined;

export function initializeSidebar(context: vscode.ExtensionContext): SidebarProvider {
  sidebarProviderInstance = new SidebarProvider(context);
  return sidebarProviderInstance;
}

export function refreshSidebar(): void {
  sidebarProviderInstance?.refresh();
}

/** Force a full sidebar HTML rebuild (e.g. after UI language change). */
export function rebuildSidebar(): void {
  sidebarProviderInstance?.rebuild();
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private _progressSub: vscode.Disposable | undefined;
  private _syncProgressSub: vscode.Disposable | undefined;
  private _htmlInitialized = false;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: SidebarMessage) => {
      void dispatchSidebarMessage(this.context, webviewView.webview, message);
    });
    this._progressSub = onChatImportProgress((event) => {
      void webviewView.webview.postMessage({ type: "chats:progress", event });
    });
    this._syncProgressSub = onSyncProgress((event) => {
      void webviewView.webview.postMessage({ type: "sync:progress", event });
    });
    webviewView.onDidDispose(() => {
      this._progressSub?.dispose();
      this._syncProgressSub?.dispose();
      this._htmlInitialized = false;
    });
    void this._update();
  }

  refresh(): void { void this._update(); }

  rebuild(): void {
    this._htmlInitialized = false;
    void this._update();
  }

  private async _update(): Promise<void> {
    if (!this._view) return;
    if (!this._htmlInitialized) {
      this._view.webview.html = await renderSidebarHtml(
        this.context,
        this._view.webview
      );
      this._htmlInitialized = true;
      return;
    }
    const syncPaneHtml = await renderSyncPaneHtml(this.context);
    await this._view.webview.postMessage({ type: "sync:update", html: syncPaneHtml });
  }
}
