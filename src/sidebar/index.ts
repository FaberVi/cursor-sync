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

export function isSidebarVisible(): boolean {
  return sidebarProviderInstance?.isVisible() === true;
}

export function revealSidebar(): void {
  sidebarProviderInstance?.reveal();
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
  private _bootId = 0;

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
      this._showShell();
      return;
    }
    void this._update();
  }

  refresh(): void {
    void this._update();
  }

  isVisible(): boolean {
    return this._view?.visible === true;
  }

  reveal(): void {
    this._view?.show?.(true);
  }

  rebuild(): void {
    this._htmlInitialized = false;
    this._hydrateGeneration += 1;
    if (!this._view) {
      return;
    }
    this._showShell();
  }

  private _showShell(): void {
    const view = this._view;
    if (!view) {
      return;
    }
    this._bootId += 1;
    view.webview.html = renderSidebarShellHtml(this.context, view.webview, this._bootId);
    this._htmlInitialized = true;
    void this._hydrateSidebar(this._bootId);
  }

  private async _finishBoot(view: vscode.WebviewView, bootId: number): Promise<void> {
    if (this._view !== view || bootId !== this._bootId) {
      return;
    }
    await view.webview.postMessage({ type: "sidebar:ready", bootId });
  }

  private async _hydrateSidebar(bootId: number): Promise<void> {
    this._hydrateGeneration += 1;
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
      await this._finishBoot(view, bootId);
    } catch {
      await this._finishBoot(view, bootId);
    }
  }

  private async _update(): Promise<void> {
    this._hydrateGeneration += 1;
    const generation = this._hydrateGeneration;
    const bootId = this._bootId;
    const view = this._view;
    if (!view) {
      return;
    }
    try {
      const syncPaneHtml = await renderSyncPaneHtml(this.context);
      if (generation !== this._hydrateGeneration || this._view !== view) {
        return;
      }
      await view.webview.postMessage({ type: "sync:update", html: syncPaneHtml });
      await this._finishBoot(view, bootId);
    } catch {
      await this._finishBoot(view, bootId);
    }
  }
}
