import * as vscode from "vscode";
import {
  renderSidebarHtml,
  renderSidebarShellHtml,
  renderSyncPaneHtml,
} from "./html.js";
import { dispatchSidebarMessage } from "./messages.js";
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
  private _hydrateGeneration = 0;

  constructor(private context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((message: unknown) => {
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
      this._hydrateGeneration += 1;
    });
    if (!this._htmlInitialized) {
      webviewView.webview.html = renderSidebarShellHtml(
        this.context,
        webviewView.webview
      );
      this._htmlInitialized = true;
      void this._hydrateSidebar();
      return;
    }
    void this._update();
  }

  refresh(): void {
    void this._update();
  }

  rebuild(): void {
    this._htmlInitialized = false;
    this._hydrateGeneration += 1;
    if (!this._view) {
      return;
    }
    this._view.webview.html = renderSidebarShellHtml(this.context, this._view.webview);
    this._htmlInitialized = true;
    void this._hydrateSidebar();
  }

  private async _hydrateSidebar(): Promise<void> {
    const generation = this._hydrateGeneration;
    const view = this._view;
    if (!view) {
      return;
    }

    try {
      const syncPaneHtml = await renderSyncPaneHtml(this.context, {
        deferHeavyMetrics: true,
      });
      if (generation !== this._hydrateGeneration || this._view !== view) {
        return;
      }
      await view.webview.postMessage({ type: "sync:update", html: syncPaneHtml });

      const fullSyncPaneHtml = await renderSyncPaneHtml(this.context, {
        deferHeavyMetrics: false,
      });
      if (generation !== this._hydrateGeneration || this._view !== view) {
        return;
      }
      await view.webview.postMessage({ type: "sync:update", html: fullSyncPaneHtml });
    } catch {
      // Shell is already visible; a later refresh can recover.
    }
  }

  private async _update(): Promise<void> {
    if (!this._view) {
      return;
    }
    const syncPaneHtml = await renderSyncPaneHtml(this.context);
    await this._view.webview.postMessage({ type: "sync:update", html: syncPaneHtml });
  }
}
