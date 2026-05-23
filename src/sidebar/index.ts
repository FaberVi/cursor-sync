import * as vscode from "vscode";
import { renderSidebarHtml } from "./html.js";
import { dispatchSidebarMessage, type SidebarMessage } from "./messages.js";
import { onChatImportProgress } from "../chat-progress-events.js";

let sidebarProviderInstance: SidebarProvider | undefined;

export function initializeSidebar(context: vscode.ExtensionContext): SidebarProvider {
  sidebarProviderInstance = new SidebarProvider(context);
  return sidebarProviderInstance;
}

export function refreshSidebar(): void {
  sidebarProviderInstance?.refresh();
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  private _view: vscode.WebviewView | undefined;
  private _progressSub: vscode.Disposable | undefined;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: SidebarMessage) =>
      dispatchSidebarMessage(this.context, webviewView.webview, message)
    );
    this._progressSub = onChatImportProgress((event) => {
      void webviewView.webview.postMessage({ type: "chats:progress", event });
    });
    webviewView.onDidDispose(() => {
      this._progressSub?.dispose();
    });
    void this._update();
  }

  refresh(): void { void this._update(); }

  private async _update(): Promise<void> {
    if (!this._view) return;
    this._view.webview.html = await renderSidebarHtml(this.context);
  }
}
