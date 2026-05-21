export class TreeItem {
  label: string;
  description?: string;
  collapsibleState?: number;
  command?: { command: string; title: string };
  iconPath?: unknown;
  tooltip?: unknown;
  contextValue?: string;
  constructor(label: string, collapsibleState?: number) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class ThemeIcon {
  constructor(public id: string, public color?: unknown) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  value = "";
  appendMarkdown(val: string): this {
    this.value += val;
    return this;
  }
}

export class EventEmitter<T> {
  private listeners: Array<(e: T) => void> = [];
  event: (listener: (e: T) => void) => { dispose: () => void } = (listener) => {
    this.listeners.push(listener);
    return { dispose: () => {} };
  };
  fire(data: T): void {
    for (const l of this.listeners) l(data);
  }
  dispose(): void {}
}

let mockWorkspaceFolders: Array<{ uri: { fsPath: string } }> = [];

export function __setWorkspaceFolders(
  folders: Array<{ uri: { fsPath: string } }>
): void {
  mockWorkspaceFolders = folders;
}

export class RelativePattern {
  constructor(
    public base: { fsPath?: string },
    public pattern: string
  ) {}
}

export class Disposable {
  constructor(private callOnDispose?: () => void) {}
  dispose(): void {
    this.callOnDispose?.();
  }
}

export const workspace = {
  get workspaceFolders() {
    return mockWorkspaceFolders.length ? mockWorkspaceFolders : undefined;
  },
  createFileSystemWatcher: (
    _pattern: unknown,
    _ignoreCreate?: boolean,
    _ignoreChange?: boolean,
    _ignoreDelete?: boolean
  ) => ({
    onDidCreate: (_cb: () => void) => ({ dispose: () => {} }),
    onDidChange: (_cb: () => void) => ({ dispose: () => {} }),
    onDidDelete: (_cb: () => void) => ({ dispose: () => {} }),
    dispose: () => {},
  }),
  onDidChangeWorkspaceFolders: (_cb: () => void) => ({ dispose: () => {} }),
  getConfiguration: (_section?: string) => ({
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      const defaults: Record<string, unknown> = {
        enabledPaths: [
          "settings.json",
          "keybindings.json",
          "snippets/**",
          "extensions.json",
          "vsix/**",
          "skills/**",
          "skills-cursor/**/SKILL.md",
          "commands/**/*.md",
          "rules/*.mdc",
        ],
        excludeGlobs: [],
        maxFileSizeKB: 512,
        syncProfileName: "default",
        safeMode: true,
        "schedule.enabled": false,
        "schedule.intervalMin": 30,
      };
      return (defaults[key] as T) ?? defaultValue;
    },
  }),
  onDidChangeConfiguration: () => ({ dispose: () => {} }),
};

export const window = {
  createOutputChannel: (_name: string) => ({
    appendLine: (_msg: string) => {},
    show: () => {},
    dispose: () => {},
  }),
  showInformationMessage: async (_msg: string, ..._items: string[]) => undefined,
  showWarningMessage: async (_msg: string, ..._items: string[]) => undefined,
  showErrorMessage: async (_msg: string, ..._items: string[]) => undefined,
  showInputBox: async () => undefined,
  showQuickPick: async <T>(items: T[]) => items[0],
};

let registeredCommands = new Set<string>();
let executeCommandImpl: (
  command: string,
  ...args: unknown[]
) => Promise<unknown> = async () => undefined;

export function __resetVscodeCommandsMock(): void {
  registeredCommands = new Set();
  executeCommandImpl = async () => undefined;
  mockWorkspaceFolders = [];
}

export function __setRegisteredCommands(commandIds: string[]): void {
  registeredCommands = new Set(commandIds);
}

export function __setExecuteCommandImpl(
  impl: (command: string, ...args: unknown[]) => Promise<unknown>
): void {
  executeCommandImpl = impl;
}

export const commands = {
  executeCommand: async (command: string, ...args: unknown[]) =>
    executeCommandImpl(command, ...args),
  getCommands: async (_filter?: boolean) => Array.from(registeredCommands),
  registerCommand: (_command: string, _callback: (...args: unknown[]) => unknown) => ({
    dispose: () => {},
  }),
};

export const extensions = {
  all: [],
};

export enum ExtensionKind {
  UI = 1,
  Workspace = 2,
}

export const Uri = {
  file: (p: string) => ({ fsPath: p, scheme: "file" }),
  parse: (value: string) => ({ fsPath: value, scheme: "file" }),
};

