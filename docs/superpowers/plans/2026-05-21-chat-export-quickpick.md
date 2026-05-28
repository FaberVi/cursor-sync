# Chat Export QuickPick and Batch Bundle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace manual conversation-ID prompts with a two-step QuickPick export flow and support multi-chat batch export/import via `ChatBundlesCollection`.

**Architecture:** Extract shared `humanWorkspaceLabel` and disk-listing helpers; add `chat-export-ux.ts` for workspace + multi-select conversation picking; add `chat-bundle-format.ts` for collection parse/validate and gist filename selection; scope `buildChatBundle` store lookup to the picker workspace; wire three export commands and both import paths to batch-aware parsing.

**Tech Stack:** TypeScript, VS Code Extension API (`showQuickPick`, `withProgress`), Vitest, existing `transcripts` internals (`resolveChatsRoot`, `summarizeTranscriptForSidebar`).

**Spec:** `docs/superpowers/specs/2026-05-21-chat-export-quickpick-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/chat-workspace-label.ts` | Create | `humanWorkspaceLabel` (shared) |
| `src/chat-bundle-format.ts` | Create | `ChatBundlesCollection`, parse/validate, gist filename, collection builder |
| `src/chat-export-ux.ts` | Create | Disk discovery + `pickChatsForExport` |
| `src/chat-persistence.ts` | Modify | `buildChatBundle` options; export/save/import commands; remove local `humanWorkspaceLabel` |
| `src/export-gist-chat.ts` | Modify | Picker + batch gist export |
| `src/import-gist-chat.ts` | Modify | `chat-bundles.json` fetch + collection pick |
| `src/import-gist-transcripts.ts` | Modify | Import `humanWorkspaceLabel`, `listChatsWorkspaceDirs` from new modules |
| `tests/chat-workspace-label.test.ts` | Create | Label stripping tests |
| `tests/chat-bundle-format.test.ts` | Create | Parse/collection/gist filename tests |
| `tests/chat-export-ux.test.ts` | Create | Disk listing + picker mocks |
| `tests/chat-gist-export-import.test.ts` | Modify | QuickPick mocks, collection round-trip |
| `tests/export-visibility.test.ts` | Modify | Multi-chat success copy assertions |

---

### Task 1: Shared workspace label

**Files:**
- Create: `src/chat-workspace-label.ts`
- Create: `tests/chat-workspace-label.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/chat-workspace-label.test.ts`:

```typescript
import { describe, expect, it } from "vitest";

describe("humanWorkspaceLabel", () => {
  it("strips 40-char hex suffix", async () => {
    const { humanWorkspaceLabel } = await import("../src/chat-workspace-label.js");
    expect(humanWorkspaceLabel("my-repo-deadbeefdeadbeefdeadbeefdeadbeefde")).toBe(
      "my-repo"
    );
  });

  it("strips 8-char hex suffix", async () => {
    const { humanWorkspaceLabel } = await import("../src/chat-workspace-label.js");
    expect(humanWorkspaceLabel("workspace-abcdef12")).toBe("workspace");
  });

  it("returns folder name when no hash suffix", async () => {
    const { humanWorkspaceLabel } = await import("../src/chat-workspace-label.js");
    expect(humanWorkspaceLabel("plain-name")).toBe("plain-name");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-workspace-label.test.ts`
Expected: FAIL — cannot find module `chat-workspace-label.js`

- [ ] **Step 3: Write minimal implementation**

Create `src/chat-workspace-label.ts`:

```typescript
export function humanWorkspaceLabel(folderName: string): string {
  const parts = folderName.split("-");
  if (parts.length <= 1) return folderName;
  const last = parts[parts.length - 1]!;
  const withoutHash = last.length === 40 || last.length === 8 ? parts.slice(0, -1) : parts;
  return withoutHash.join("-");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-workspace-label.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/chat-workspace-label.ts tests/chat-workspace-label.test.ts
git commit -m "feat: extract humanWorkspaceLabel for chat import/export UX"
```

---

### Task 2: Batch bundle format and parse helpers

**Files:**
- Create: `src/chat-bundle-format.ts`
- Create: `tests/chat-bundle-format.test.ts`
- Modify: `src/chat-persistence.ts` (re-export `ChatBundle` type only if needed by format module — prefer import type from persistence)

- [ ] **Step 1: Write the failing tests**

Create `tests/chat-bundle-format.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";

const singleBundle: ChatBundle = {
  schemaVersion: 1,
  type: "chat-persistence",
  createdAt: "2026-05-21T00:00:00.000Z",
  conversationId: "conv-1",
  title: "One",
  subtitle: "1 file",
  previewText: "One",
  sidebarSnapshot: null,
  storeSnapshot: null,
  transcriptFiles: [],
};

describe("chat-bundle-format", () => {
  it("parseChatBundleOrCollection returns single", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify(singleBundle);
    const result = parseChatBundleOrCollection(raw);
    expect(result.kind).toBe("single");
    if (result.kind === "single") {
      expect(result.bundle.conversationId).toBe("conv-1");
    }
  });

  it("parseChatBundleOrCollection returns collection", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({
      schemaVersion: 1,
      type: "chat-bundles-collection",
      createdAt: "2026-05-21T00:00:00.000Z",
      sourceWorkspaceKey: "wk-md5",
      bundles: [singleBundle],
    });
    const result = parseChatBundleOrCollection(raw);
    expect(result.kind).toBe("collection");
    if (result.kind === "collection") {
      expect(result.collection.bundles).toHaveLength(1);
    }
  });

  it("rejects invalid JSON", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    expect(() => parseChatBundleOrCollection("{")).toThrow(/not valid JSON/i);
  });

  it("rejects wrong type", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({ ...singleBundle, type: "other" });
    expect(() => parseChatBundleOrCollection(raw)).toThrow(/chat-persistence|chat-bundles-collection/i);
  });

  it("rejects empty collection bundles", async () => {
    const { parseChatBundleOrCollection } = await import("../src/chat-bundle-format.js");
    const raw = JSON.stringify({
      schemaVersion: 1,
      type: "chat-bundles-collection",
      createdAt: "2026-05-21T00:00:00.000Z",
      sourceWorkspaceKey: "wk",
      bundles: [],
    });
    expect(() => parseChatBundleOrCollection(raw)).toThrow(/empty/i);
  });

  it("selectGistExportFile uses chat-bundle.json for one bundle", async () => {
    const { selectGistExportFile } = await import("../src/chat-bundle-format.js");
    expect(selectGistExportFile(1)).toEqual({
      fileName: "chat-bundle.json",
      content: expect.any(String),
    });
  });

  it("selectGistExportFile uses chat-bundles.json for multiple", async () => {
    const { selectGistExportFile, buildChatBundlesCollection } = await import(
      "../src/chat-bundle-format.js"
    );
    const collection = buildChatBundlesCollection("wk", [singleBundle, { ...singleBundle, conversationId: "conv-2", title: "Two" }]);
    const { fileName, content } = selectGistExportFile(2, collection);
    expect(fileName).toBe("chat-bundles.json");
    const parsed = JSON.parse(content);
    expect(parsed.type).toBe("chat-bundles-collection");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-bundle-format.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write minimal implementation**

Create `src/chat-bundle-format.ts`:

```typescript
import type { ChatBundle } from "./chat-persistence.js";

export const CHAT_BUNDLE_GIST_FILE_NAME = "chat-bundle.json";
export const CHAT_BUNDLES_GIST_FILE_NAME = "chat-bundles.json";

export interface ChatBundlesCollection {
  schemaVersion: 1;
  type: "chat-bundles-collection";
  createdAt: string;
  sourceWorkspaceKey: string;
  bundles: ChatBundle[];
}

export type ParsedChatExport =
  | { kind: "single"; bundle: ChatBundle }
  | { kind: "collection"; collection: ChatBundlesCollection };

function validateSingleBundle(bundle: Partial<ChatBundle>, label: string): ChatBundle {
  if (bundle.type !== "chat-persistence") {
    throw new Error(
      `${label}: expected type "chat-persistence", got "${String(bundle.type)}".`
    );
  }
  if (bundle.schemaVersion !== 1) {
    throw new Error(
      `${label}: unsupported schema version ${String(bundle.schemaVersion)}.`
    );
  }
  if (!bundle.conversationId || typeof bundle.conversationId !== "string") {
    throw new Error(`${label}: missing conversationId.`);
  }
  return bundle as ChatBundle;
}

export function buildChatBundlesCollection(
  sourceWorkspaceKey: string,
  bundles: ChatBundle[]
): ChatBundlesCollection {
  if (bundles.length < 1) {
    throw new Error("Cannot build collection with zero bundles.");
  }
  for (const b of bundles) {
    validateSingleBundle(b, "bundle");
  }
  return {
    schemaVersion: 1,
    type: "chat-bundles-collection",
    createdAt: new Date().toISOString(),
    sourceWorkspaceKey,
    bundles,
  };
}

export function parseChatBundleOrCollection(raw: string): ParsedChatExport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Invalid chat export JSON: not valid JSON.");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("Invalid chat export JSON: expected an object.");
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === "chat-persistence") {
    return { kind: "single", bundle: validateSingleBundle(obj as Partial<ChatBundle>, "chat bundle") };
  }
  if (obj.type === "chat-bundles-collection") {
    const col = obj as Partial<ChatBundlesCollection>;
    if (col.schemaVersion !== 1) {
      throw new Error(`Invalid collection schema version: ${String(col.schemaVersion)}.`);
    }
    const bundles = col.bundles;
    if (!Array.isArray(bundles) || bundles.length === 0) {
      throw new Error("Invalid chat bundles collection: bundles array is empty.");
    }
    const validated = bundles.map((b, i) =>
      validateSingleBundle(b as Partial<ChatBundle>, `bundles[${i}]`)
    );
    return {
      kind: "collection",
      collection: {
        schemaVersion: 1,
        type: "chat-bundles-collection",
        createdAt: String(col.createdAt ?? new Date().toISOString()),
        sourceWorkspaceKey: String(col.sourceWorkspaceKey ?? ""),
        bundles: validated,
      },
    };
  }
  throw new Error(
    `Invalid chat export: expected type "chat-persistence" or "chat-bundles-collection", got "${String(obj.type)}".`
  );
}

export function selectGistExportFile(
  bundleCount: number,
  singleOrCollection?: ChatBundle | ChatBundlesCollection
): { fileName: string; content: string } {
  if (bundleCount <= 1) {
    const bundle = singleOrCollection as ChatBundle;
    return {
      fileName: CHAT_BUNDLE_GIST_FILE_NAME,
      content: JSON.stringify(bundle, null, 2),
    };
  }
  const collection = singleOrCollection as ChatBundlesCollection;
  return {
    fileName: CHAT_BUNDLES_GIST_FILE_NAME,
    content: JSON.stringify(collection, null, 2),
  };
}

export function defaultLocalExportFilename(
  conversationIds: string[],
  timestamp: string
): string {
  if (conversationIds.length === 1) {
    const safe = conversationIds[0]!.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60);
    return `${safe}-chat-bundle.json`;
  }
  return `chat-bundles-${timestamp}.json`;
}

export function defaultGlobalStorageFilename(timestamp: string, multi: boolean): string {
  return multi ? `chat-bundles_${timestamp}.json` : undefined;
}
```

Adjust `selectGistExportFile` test in Step 1 to pass a real `ChatBundle` for the `bundleCount === 1` case:

```typescript
const { fileName } = selectGistExportFile(1, singleBundle);
expect(fileName).toBe("chat-bundle.json");
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-bundle-format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-bundle-format.ts tests/chat-bundle-format.test.ts
git commit -m "feat: add ChatBundlesCollection parse and gist filename helpers"
```

---

### Task 3: Pure disk discovery helpers

**Files:**
- Create: `src/chat-export-ux.ts` (partial — no VS Code picker yet)
- Create: `tests/chat-export-ux.test.ts` (disk tests only)

- [ ] **Step 1: Write the failing tests**

Create `tests/chat-export-ux.test.ts` (first section):

```typescript
import { beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

describe("chat-export-ux disk helpers", () => {
  let tmpRoot: string;
  let chatsRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "chat-export-ux-"));
    chatsRoot = path.join(tmpRoot, "chats");
    await fs.mkdir(chatsRoot, { recursive: true });
  });

  it("listChatsWorkspaceDirs returns sorted workspace dirs", async () => {
    await fs.mkdir(path.join(chatsRoot, "bbb-wk"), { recursive: true });
    await fs.mkdir(path.join(chatsRoot, "aaa-wk"), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, "file.txt"), "");
    const { listChatsWorkspaceDirs } = await import("../src/chat-export-ux.js");
    const dirs = await listChatsWorkspaceDirs(chatsRoot);
    expect(dirs.map((d) => d.name)).toEqual(["aaa-wk", "bbb-wk"]);
    expect(dirs[0]!.fullPath).toBe(path.join(chatsRoot, "aaa-wk"));
  });

  it("listConversationsForWorkspace includes dirs with store.db only", async () => {
    const wk = "workspace-md5";
    const withStore = path.join(chatsRoot, wk, "conv-a");
    const withoutStore = path.join(chatsRoot, wk, "conv-b");
    await fs.mkdir(withStore, { recursive: true });
    await fs.mkdir(withoutStore, { recursive: true });
    await fs.writeFile(path.join(withStore, "store.db"), "sqlite", "utf-8");
    const projectsRoot = path.join(tmpRoot, "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot);
    expect(rows.map((r) => r.conversationId)).toEqual(["conv-a"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-export-ux.test.ts`
Expected: FAIL

- [ ] **Step 3: Write disk helpers**

Create `src/chat-export-ux.ts` with:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { summarizeTranscriptForSidebar } from "./transcript-bundle.js";

export interface WorkspaceDir {
  name: string;
  fullPath: string;
}

export interface ConversationExportRow {
  conversationId: string;
  label: string;
  description: string;
  detail: string;
}

export async function listChatsWorkspaceDirs(chatsRoot: string): Promise<WorkspaceDir[]> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(chatsRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({ name: e.name, fullPath: path.join(chatsRoot, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function countJsonlForConversation(
  projectsRoot: string,
  conversationId: string
): Promise<number> {
  let count = 0;
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
    let files: string[];
    try {
      files = await fs.readdir(transcriptDir);
    } catch {
      continue;
    }
    count += files.filter((f) => f.endsWith(".jsonl")).length;
  }
  return count;
}

async function transcriptTitleForConversation(
  projectsRoot: string,
  conversationId: string
): Promise<string | null> {
  let projectDirs: import("node:fs").Dirent[];
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const dir of projectDirs) {
    if (!dir.isDirectory()) continue;
    const transcriptDir = path.join(projectsRoot, dir.name, "agent-transcripts", conversationId);
    let files: string[];
    try {
      files = await fs.readdir(transcriptDir);
    } catch {
      continue;
    }
    const jsonl = files.find((f) => f.endsWith(".jsonl"));
    if (!jsonl) continue;
    try {
      const content = (await fs.readFile(path.join(transcriptDir, jsonl), "utf-8")).toString();
      return summarizeTranscriptForSidebar(content, conversationId).title;
    } catch {
      continue;
    }
  }
  return null;
}

export async function listConversationsForWorkspace(
  workspaceKey: string,
  chatsRoot: string,
  projectsRoot: string
): Promise<ConversationExportRow[]> {
  const workspacePath = path.join(chatsRoot, workspaceKey);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(workspacePath, { withFileTypes: true });
  } catch {
    return [];
  }
  const rows: ConversationExportRow[] = [];
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const conversationId = ent.name;
    const storePath = path.join(workspacePath, conversationId, "store.db");
    try {
      const stat = await fs.stat(storePath);
      if (!stat.isFile()) continue;
    } catch {
      continue;
    }
    const jsonlCount = await countJsonlForConversation(projectsRoot, conversationId);
    const title =
      (await transcriptTitleForConversation(projectsRoot, conversationId)) ?? conversationId;
    const parts = [
      jsonlCount > 0 ? `${jsonlCount} jsonl` : "no jsonl",
      "store.db",
    ];
    rows.push({
      conversationId,
      label: title,
      description: conversationId,
      detail: parts.join(" · "),
    });
  }
  return rows.sort((a, b) => a.conversationId.localeCompare(b.conversationId));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-export-ux.test.ts`
Expected: PASS (2 disk tests)

- [ ] **Step 5: Commit**

```bash
git add src/chat-export-ux.ts tests/chat-export-ux.test.ts
git commit -m "feat: add disk discovery helpers for chat export picker"
```

---

### Task 4: `pickChatsForExport` QuickPick flow

**Files:**
- Modify: `src/chat-export-ux.ts`
- Modify: `tests/chat-export-ux.test.ts`

- [ ] **Step 1: Write the failing picker tests**

Append to `tests/chat-export-ux.test.ts`:

```typescript
import { vi, beforeEach } from "vitest";
import * as os from "node:os";

const showQuickPickMock = vi.fn();
const showErrorMessageMock = vi.fn();
const showInformationMessageMock = vi.fn();

vi.mock("vscode", () => ({
  window: {
    showQuickPick: showQuickPickMock,
    showErrorMessage: showErrorMessageMock,
    showInformationMessage: showInformationMessageMock,
  },
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return { ...actual, homedir: () => mockedHome };
});

let mockedHome = "";

describe("pickChatsForExport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when workspace picker dismissed", async () => {
    mockedHome = tmpRoot; // use outer beforeEach tmpRoot from disk describe — refactor: single describe with shared tmpRoot
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await expect(pickChatsForExport()).resolves.toBeNull();
  });
});
```

Refactor the test file into one `describe` with shared `tmpRoot` / `mockedHome` setup: create `~/.cursor/chats/wk1/conv1/store.db` under `mockedHome`.

Full picker success test:

```typescript
it("returns workspaceKey and conversationIds on success", async () => {
  const wk = "wk-md5";
  await fs.mkdir(path.join(mockedHome, ".cursor", "chats", wk, "conv-1"), { recursive: true });
  await fs.writeFile(path.join(mockedHome, ".cursor", "chats", wk, "conv-1", "store.db"), "x");
  await fs.mkdir(path.join(mockedHome, ".cursor", "chats", wk, "wk-b"), { recursive: true });
  showQuickPickMock
    .mockResolvedValueOnce({ description: wk })
    .mockResolvedValueOnce([{ description: "conv-1" }]);
  const { pickChatsForExport } = await import("../src/chat-export-ux.js");
  await expect(pickChatsForExport()).resolves.toEqual({
    workspaceKey: wk,
    conversationIds: ["conv-1"],
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-export-ux.test.ts`
Expected: FAIL — `pickChatsForExport` not exported

- [ ] **Step 3: Implement picker**

Add to `src/chat-export-ux.ts`:

```typescript
import * as vscode from "vscode";
import * as os from "node:os";
import { __chatPersistenceInternals } from "./transcripts.js";
import { humanWorkspaceLabel } from "./chat-workspace-label.js";

const { resolveChatsRoot } = __chatPersistenceInternals;

export interface ChatExportSelection {
  workspaceKey: string;
  conversationIds: string[];
}

function resolveProjectsRoot(): string {
  return path.join(os.homedir(), ".cursor", "projects");
}

export async function pickChatsForExport(): Promise<ChatExportSelection | null> {
  const chatsRoot = resolveChatsRoot();
  const workspaces = await listChatsWorkspaceDirs(chatsRoot);

  if (workspaces.length === 0) {
    vscode.window.showErrorMessage(
      "No local chat workspaces found. Open a workspace in Cursor first."
    );
    return null;
  }

  let workspaceKey: string;
  if (workspaces.length === 1) {
    workspaceKey = workspaces[0]!.name;
  } else {
    const pick = await vscode.window.showQuickPick(
      workspaces.map((w) => ({
        label: humanWorkspaceLabel(w.name),
        description: w.name,
        detail: w.fullPath,
      })),
      {
        title: "Select workspace for chat export",
        placeHolder: "Choose the workspace whose chats you want to export",
        ignoreFocusOut: true,
      }
    );
    if (!pick?.description) return null;
    workspaceKey = pick.description;
  }

  const projectsRoot = resolveProjectsRoot();
  const conversations = await listConversationsForWorkspace(
    workspaceKey,
    chatsRoot,
    projectsRoot
  );

  if (conversations.length === 0) {
    vscode.window.showInformationMessage("No conversations found in this workspace.");
    return null;
  }

  const convPicks = await vscode.window.showQuickPick(
    conversations.map((c) => ({
      label: c.label,
      description: c.conversationId,
      detail: c.detail,
      picked: true,
    })),
    {
      canPickMany: true,
      title: `Select conversations to export (${conversations.length} found)`,
      placeHolder:
        "Each selection exports store.db (scoped workspace), transcripts, and sidebar metadata when available",
      ignoreFocusOut: true,
    }
  );

  if (!convPicks || convPicks.length === 0) return null;

  return {
    workspaceKey,
    conversationIds: convPicks.map((p) => p.description!).filter(Boolean),
  };
}
```

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/chat-export-ux.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-export-ux.ts tests/chat-export-ux.test.ts
git commit -m "feat: add pickChatsForExport two-step QuickPick flow"
```

---

### Task 5: Refactor duplicate `humanWorkspaceLabel` and workspace listing

**Files:**
- Modify: `src/import-gist-transcripts.ts`
- Modify: `src/chat-persistence.ts`

- [ ] **Step 1: Update imports (no new tests — compile check)**

In `import-gist-transcripts.ts`:

- Remove local `humanWorkspaceLabel` and `listChatsWorkspaceDirs`.
- Add:

```typescript
import { humanWorkspaceLabel } from "./chat-workspace-label.js";
import { listChatsWorkspaceDirs } from "./chat-export-ux.js";
```

In `chat-persistence.ts`:

- Remove `humanWorkspaceLabel` function (lines ~938–944).
- Add `import { humanWorkspaceLabel } from "./chat-workspace-label.js";`

- [ ] **Step 2: Verify compile and tests**

Run: `npm run lint && npm test`
Expected: PASS (no behavior change)

- [ ] **Step 3: Commit**

```bash
git add src/import-gist-transcripts.ts src/chat-persistence.ts
git commit -m "refactor: share workspace label and chats dir listing"
```

---

### Task 6: Scoped `buildChatBundle` store lookup

**Files:**
- Modify: `src/chat-persistence.ts`
- Modify: `tests/chat-persistence.test.ts` (add test if file exists; else add minimal test file)

- [ ] **Step 1: Write failing test for scoped store**

Check for `tests/chat-persistence.test.ts`. If absent, create with one test using temp dirs under `vi.mock("node:os")` homedir:

```typescript
it("buildChatBundle uses workspaceKey store only without fallback", async () => {
  const conversationId = "conv-scoped";
  const wkA = "wk-a";
  const wkB = "wk-b";
  await fs.mkdir(path.join(home, ".cursor", "chats", wkA, conversationId), { recursive: true });
  await fs.mkdir(path.join(home, ".cursor", "chats", wkB, conversationId), { recursive: true });
  await fs.writeFile(path.join(home, ".cursor", "chats", wkB, conversationId, "store.db"), "from-b");
  const { buildChatBundle } = await import("../src/chat-persistence.js");
  const { bundle } = await buildChatBundle(context, conversationId, progress, { workspaceKey: wkA });
  expect(bundle.storeSnapshot).toBeNull();
});
```

- [ ] **Step 2: Run test — expect FAIL**

Run: `npm test -- tests/chat-persistence.test.ts -t "scoped store"`
Expected: FAIL — options not accepted or wrong store picked

- [ ] **Step 3: Implement scoped lookup**

Update `buildChatBundle` signature:

```typescript
export async function buildChatBundle(
  _context: vscode.ExtensionContext,
  conversationId: string,
  progress: vscode.Progress<{ message?: string; increment?: number }>,
  options?: { workspaceKey?: string }
): Promise<{ bundle: ChatBundle; title: string; warnings: string[] }> {
```

Replace store resolution block:

```typescript
  progress.report({ message: "Locating store.db..." });
  let storeSnapshot: ChatBundle["storeSnapshot"] = null;
  let storeInfo: { absolutePath: string; workspaceKey: string } | undefined;
  if (options?.workspaceKey) {
    const candidate = path.join(
      resolveChatsRoot(),
      options.workspaceKey,
      conversationId,
      "store.db"
    );
    try {
      const stat = await fs.stat(candidate);
      if (stat.isFile()) {
        storeInfo = { absolutePath: candidate, workspaceKey: options.workspaceKey };
      }
    } catch {}
  } else {
    storeInfo = await findStoreDbForConversation(conversationId);
  }
  if (storeInfo) {
    // existing read/encode block unchanged
  } else {
    warnings.push(
      options?.workspaceKey
        ? `store.db not found at ~/.cursor/chats/${options.workspaceKey}/${conversationId}/store.db; only transcripts will be saved.`
        : `store.db not found for conversation ${conversationId}; only transcripts will be saved.`
    );
  }
```

- [ ] **Step 4: Run test — expect PASS**

- [ ] **Step 5: Commit**

```bash
git add src/chat-persistence.ts tests/chat-persistence.test.ts
git commit -m "feat: scope buildChatBundle store.db to export workspace key"
```

---

### Task 7: Batch export orchestration helper

**Files:**
- Modify: `src/chat-persistence.ts`

- [ ] **Step 1: Add `buildExportPayload` helper (test via gist test in Task 9)**

Add private or exported helper in `chat-persistence.ts`:

```typescript
import {
  buildChatBundlesCollection,
  selectGistExportFile,
  defaultLocalExportFilename,
  type ChatBundlesCollection,
} from "./chat-bundle-format.js";

export async function buildChatExportPayload(
  context: vscode.ExtensionContext,
  selection: ChatExportSelection,
  progress: vscode.Progress<{ message?: string; increment?: number }>
): Promise<{
  bundles: ChatBundle[];
  warnings: string[];
  gistPayload: { fileName: string; content: string };
  jsonForFile: string;
  defaultSaveBasename: string;
  primaryTitle: string;
}> {
  const bundles: ChatBundle[] = [];
  const warnings: string[] = [];
  for (const conversationId of selection.conversationIds) {
    const { bundle, title, warnings: w } = await buildChatBundle(context, conversationId, progress, {
      workspaceKey: selection.workspaceKey,
    });
    bundles.push(bundle);
    warnings.push(...w);
  }
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  let jsonForFile: string;
  let gistPayload: { fileName: string; content: string };
  if (bundles.length === 1) {
    gistPayload = selectGistExportFile(1, bundles[0]!);
    jsonForFile = gistPayload.content;
  } else {
    const collection = buildChatBundlesCollection(selection.workspaceKey, bundles);
    gistPayload = selectGistExportFile(bundles.length, collection);
    jsonForFile = gistPayload.content;
  }
  return {
    bundles,
    warnings,
    gistPayload,
    jsonForFile,
    defaultSaveBasename: defaultLocalExportFilename(
      selection.conversationIds,
      timestamp
    ),
    primaryTitle: bundles.length === 1 ? bundles[0]!.title : `${bundles.length} chats`,
  };
}
```

Import `ChatExportSelection` from `./chat-export-ux.js`.

- [ ] **Step 2: `npm run lint`**

Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/chat-persistence.ts
git commit -m "feat: add buildChatExportPayload for single and batch exports"
```

---

### Task 8: Gist export command

**Files:**
- Modify: `src/export-gist-chat.ts`
- Modify: `tests/chat-gist-export-import.test.ts`
- Modify: `tests/export-visibility.test.ts`

- [ ] **Step 1: Update failing integration test mocks**

In `tests/chat-gist-export-import.test.ts`, add helper:

```typescript
function mockExportPicker(workspaceKey: string, conversationIds: string[]) {
  showQuickPickMock
    .mockResolvedValueOnce({ description: workspaceKey })
    .mockResolvedValueOnce(
      conversationIds.map((id) => ({ description: id, label: id }))
    );
}
```

Replace `showInputBoxMock.mockResolvedValue(conversationId)` in export tests with:

```typescript
const workspaceKey = "export-wk";
await fs.mkdir(
  path.join(tmpRoot, ".cursor", "chats", workspaceKey, conversationId),
  { recursive: true }
);
await fs.writeFile(
  path.join(tmpRoot, ".cursor", "chats", workspaceKey, conversationId, "store.db"),
  "sqlite",
  "utf-8"
);
mockExportPicker(workspaceKey, [conversationId]);
```

- [ ] **Step 2: Run export tests — expect FAIL**

Run: `npm test -- tests/chat-gist-export-import.test.ts -t "exports chat bundle"
Expected: FAIL — still uses showInputBox or picker not called

- [ ] **Step 3: Rewrite `executeExportChatToGist`**

```typescript
import { pickChatsForExport } from "./chat-export-ux.js";
import { buildChatExportPayload } from "./chat-persistence.js";
import { CHAT_BUNDLE_GIST_FILE_NAME } from "./chat-bundle-format.js";

export async function executeExportChatToGist(context: vscode.ExtensionContext): Promise<void> {
  const logger = getLogger();
  logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist started`);

  const selection = await pickChatsForExport();
  if (!selection) return;

  const token = await requireToken(context);
  if (!token) {
    logger.appendLine(`[${new Date().toISOString()}] Chat export to Gist failed: AUTH_FAILED`);
    return;
  }

  const client = new GistClient(token);

  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "Creating private Gist...",
      cancellable: false,
    },
    async (progress) => {
      try {
        const { gistPayload, warnings, primaryTitle, bundles } = await buildChatExportPayload(
          context,
          selection,
          progress
        );
        logger.appendLine(
          `[${new Date().toISOString()}] Chat gist export workspace=${selection.workspaceKey} count=${bundles.length}`
        );

        const gistFiles: Record<string, { content: string }> = {
          [gistPayload.fileName]: { content: gistPayload.content },
        };

        const result = await withRetry(() =>
          client.createGist(gistFiles, "Cursor Sync - Chat Export")
        );
        // ... existing error handling ...

        const gistUrl = result.data.html_url;
        for (const w of warnings) {
          logger.appendLine(`[${new Date().toISOString()}] [chat-export-gist] ${w}`);
        }

        const successMsg =
          bundles.length === 1
            ? `Export successful! Chat "${primaryTitle}" in private Gist at ${gistUrl}. Anyone with the link can open it.`
            : `Export successful! ${bundles.length} chats in private Gist at ${gistUrl}. Anyone with the link can open it.`;

        const action = await vscode.window.showInformationMessage(successMsg, "Copy URL");
        // ... Copy URL unchanged ...
      } catch (err) {
        // ... unchanged ...
      }
    }
  );
}
```

Remove duplicate `CHAT_BUNDLE_GIST_FILE_NAME` export from this file if moved to `chat-bundle-format.ts`; re-export from `chat-bundle-format` for backward compatibility OR keep constant in `export-gist-chat.ts` and import bundle format names only in import path.

**Decision for implementer:** Keep `export const CHAT_BUNDLE_GIST_FILE_NAME` in `export-gist-chat.ts` re-exporting from `chat-bundle-format.ts` to avoid breaking external imports:

```typescript
export { CHAT_BUNDLE_GIST_FILE_NAME, CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
```

- [ ] **Step 4: Add multi-chat test + visibility assertion**

New test in `chat-gist-export-import.test.ts`:

```typescript
it("exports multiple chats to chat-bundles.json", async () => {
  // setup two conv folders with store.db under same workspaceKey
  mockExportPicker(workspaceKey, [id1, id2]);
  // ...
  expect(Object.keys(gistFiles)).toEqual(["chat-bundles.json"]);
  expect(JSON.parse(gistFiles["chat-bundles.json"].content).type).toBe("chat-bundles-collection");
});
```

In `tests/export-visibility.test.ts`, add:

```typescript
it("multi-chat export success copy mentions private gist and link caveat", () => {
  expect(exportGistChatSrc).toContain("${bundles.length} chats in private Gist");
  expect(exportGistChatSrc).toContain("Anyone with the link can open it.");
});
```

- [ ] **Step 5: Run tests**

Run: `npm test -- tests/chat-gist-export-import.test.ts tests/export-visibility.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/export-gist-chat.ts tests/chat-gist-export-import.test.ts tests/export-visibility.test.ts
git commit -m "feat: export chat(s) to gist via QuickPick and batch collection"
```

---

### Task 9: Local file export and save-local commands

**Files:**
- Modify: `src/chat-persistence.ts` (`executeExportChatBundle`, `executeSaveChatLocal`, `saveChat`)

- [ ] **Step 1: Update `executeExportChatBundle`**

Replace `showInputBox` block with:

```typescript
  const selection = await pickChatsForExport();
  if (!selection) return;
```

Inside progress:

```typescript
        const { jsonForFile, warnings, primaryTitle, bundles, defaultSaveBasename } =
          await buildChatExportPayload(context, selection, progress);

        const defaultUri = vscode.Uri.file(
          path.join(os.homedir(), "Downloads", defaultSaveBasename)
        );
        // showSaveDialog, write jsonForFile

        const msg =
          bundles.length === 1
            ? `Chat "${primaryTitle}" exported to ${path.basename(saveUri.fsPath)}`
            : `${bundles.length} chats exported to ${path.basename(saveUri.fsPath)}`;
```

- [ ] **Step 2: Update `executeSaveChatLocal` and `saveChat`**

`executeSaveChatLocal`:

```typescript
  const selection = await pickChatsForExport();
  if (!selection) return;
```

Replace `saveChat(context, trimmedId, ...)` with batch-aware writer:

```typescript
        const { jsonForFile, warnings, primaryTitle, bundles } = await buildChatExportPayload(
          context,
          selection,
          progress
        );
        const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const multi = bundles.length > 1;
        const basename =
          multi
            ? `chat-bundles_${timestamp}.json`
            : `${selection.conversationIds[0]!.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 60)}_${timestamp}.json`;
        const bundlePath = path.join(context.globalStorageUri.fsPath, "chat-bundles", basename);
        await fs.writeFile(bundlePath, jsonForFile, "utf-8");
        const msg =
          bundles.length === 1
            ? `Chat "${primaryTitle}" saved to ${path.basename(bundlePath)}`
            : `${bundles.length} chats saved to ${path.basename(bundlePath)}`;
```

- [ ] **Step 3: Manual smoke (optional) + lint**

Run: `npm run lint`

- [ ] **Step 4: Commit**

```bash
git add src/chat-persistence.ts
git commit -m "feat: wire local chat export and save to QuickPick batch flow"
```

---

### Task 10: Import bundle picker and parse integration

**Files:**
- Modify: `src/chat-bundle-format.ts` (add `pickBundleFromCollection`)
- Modify: `src/chat-persistence.ts` (`loadChat`, `executeVerifyChatBundle` if it parses raw)
- Modify: `tests/chat-bundle-format.test.ts` (picker unit test with mock)

- [ ] **Step 1: Write failing test for `pickBundleFromCollection`**

```typescript
vi.mock("vscode", () => ({ window: { showQuickPick: showQuickPickMock } }));

it("pickBundleFromCollection returns chosen bundle", async () => {
  showQuickPickMock.mockResolvedValueOnce({ description: "conv-2" });
  const collection = buildChatBundlesCollection("wk", [
    { ...singleBundle, conversationId: "conv-1", title: "One" },
    { ...singleBundle, conversationId: "conv-2", title: "Two" },
  ]);
  const { pickBundleFromCollection } = await import("../src/chat-bundle-format.js");
  const picked = await pickBundleFromCollection(collection);
  expect(picked?.conversationId).toBe("conv-2");
});
```

- [ ] **Step 2: Implement `pickBundleFromCollection` in `chat-bundle-format.ts`**

```typescript
import * as vscode from "vscode";

export async function pickBundleFromCollection(
  collection: ChatBundlesCollection
): Promise<ChatBundle | null> {
  const pick = await vscode.window.showQuickPick(
    collection.bundles.map((b) => ({
      label: b.title,
      description: b.conversationId,
      detail: b.subtitle,
    })),
    {
      title: "Select chat to import",
      placeHolder: "This export contains multiple conversations",
      ignoreFocusOut: true,
    }
  );
  if (!pick?.description) return null;
  return collection.bundles.find((b) => b.conversationId === pick.description) ?? null;
}
```

- [ ] **Step 3: Update `loadChat` in `chat-persistence.ts`**

```typescript
import { parseChatBundleOrCollection, pickBundleFromCollection } from "./chat-bundle-format.js";

async function loadChat(...): Promise<LoadChatResult> {
  progress.report({ message: "Reading bundle..." });
  const raw = await fs.readFile(bundlePath, "utf-8");
  const parsed = parseChatBundleOrCollection(raw);
  let bundle: ChatBundle;
  if (parsed.kind === "single") {
    bundle = parsed.bundle;
  } else {
    const picked = await pickBundleFromCollection(parsed.collection);
    if (!picked) {
      throw new Error("Chat import cancelled.");
    }
    bundle = picked;
  }
  return restoreChatBundle(context, bundle, progress, restoreOptions);
}
```

Update `executeVerifyChatBundle` to use `parseChatBundleOrCollection` and reject collection with a clear message, or pick first bundle only — spec says verify is out of scope; use `parseChatBundleOrCollection` and if collection, `showErrorMessage("Select a single chat bundle for verify, or pick one conversation from a multi-chat export file.")` and return.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/chat-bundle-format.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-bundle-format.ts src/chat-persistence.ts tests/chat-bundle-format.test.ts
git commit -m "feat: parse batch chat bundles and pick one for import"
```

---

### Task 11: Gist import batch support

**Files:**
- Modify: `src/import-gist-chat.ts`
- Modify: `tests/chat-gist-export-import.test.ts`

- [ ] **Step 1: Write failing collection import test**

```typescript
it("imports one chat from chat-bundles.json collection gist", async () => {
  const collection = { /* two bundles */ };
  getGistMock.mockResolvedValue({
    ok: true,
    data: {
      files: { "chat-bundles.json": { content: JSON.stringify(collection) } },
      // ...
    },
  });
  showInputBoxMock.mockResolvedValue("gist-multi");
  showQuickPickMock.mockImplementation(async (items) => {
    if (items[0]?.description === "conv-2") return items.find((i) => i.description === "conv-2");
    // import UX picks ...
  });
  // expect restoreChatBundle with conv-2
});
```

- [ ] **Step 2: Update `fetchAndParseGistBundle`**

```typescript
import {
  CHAT_BUNDLE_GIST_FILE_NAME,
  CHAT_BUNDLES_GIST_FILE_NAME,
  parseChatBundleOrCollection,
  pickBundleFromCollection,
} from "./chat-bundle-format.js";

// After fetch gist:
const bundleRaw = gist.files?.[CHAT_BUNDLE_GIST_FILE_NAME]?.content;
const collectionRaw = gist.files?.[CHAT_BUNDLES_GIST_FILE_NAME]?.content;

if (bundleRaw) {
  const parsed = parseChatBundleOrCollection(bundleRaw);
  if (parsed.kind === "single") return parsed.bundle;
  const picked = await pickBundleFromCollection(parsed.collection);
  if (!picked) throw new Error("Chat import cancelled.");
  return picked;
}

if (collectionRaw) {
  const parsed = parseChatBundleOrCollection(collectionRaw);
  if (parsed.kind !== "collection") {
    throw new Error("Invalid chat-bundles.json: expected chat-bundles-collection.");
  }
  const picked = await pickBundleFromCollection(parsed.collection);
  if (!picked) throw new Error("Chat import cancelled.");
  return picked;
}

// existing transcript/settings/missing errors unchanged
```

Remove local `parseChatBundle` duplicate; use `parseChatBundleOrCollection` for single-file path.

Re-export gist constants from `import-gist-chat.ts` if tests import from there:

```typescript
export { CHAT_BUNDLE_GIST_FILE_NAME, CHAT_BUNDLES_GIST_FILE_NAME } from "./chat-bundle-format.js";
```

- [ ] **Step 3: Add collection round-trip test**

Extend round-trip test: export 2 chats → gist has `chat-bundles.json` → import picks one → restore.

- [ ] **Step 4: Run tests**

Run: `npm test -- tests/chat-gist-export-import.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/import-gist-chat.ts tests/chat-gist-export-import.test.ts
git commit -m "feat: import one chat from multi-chat gist collection"
```

---

### Task 12: Full suite and CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (Unreleased section only — no `package.json` version bump per spec)

- [ ] **Step 1: Run full verification**

Run: `npm run lint && npm test`
Expected: all tests PASS

- [ ] **Step 2: Add CHANGELOG entry**

Under `[Unreleased]`:

```markdown
### Added
- Chat export QuickPick: select workspace and multiple conversations from disk instead of typing IDs.
- Batch chat export/import via `chat-bundles.json` / `ChatBundlesCollection` wrapper.
```

- [ ] **Step 3: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs: changelog for chat export QuickPick and batch bundles"
```

---

## Spec coverage checklist (self-review)

| Spec requirement | Task |
|------------------|------|
| `pickChatsForExport` two-step QuickPick | 3, 4 |
| All three export commands use picker | 8, 9 |
| `ChatBundlesCollection` format | 2 |
| Gist 1 vs N file names | 2, 8 |
| `buildChatBundle` scoped `workspaceKey` | 6 |
| Import parse + `pickBundleFromCollection` | 10, 11 |
| Gist import `chat-bundles.json` | 11 |
| Local import via `loadChat` | 10 |
| Refactor `humanWorkspaceLabel` | 1, 5 |
| `listChatsWorkspaceDirs` shared | 3, 5 |
| Error handling table | 4, 8, 9, 10, 11 |
| Tests listed in spec | 1–4, 8, 11, 12 |
| No version bump unless requested | 12 (CHANGELOG only) |
| Private gist copy / two-arg `createGist` | 8, export-visibility |

## Open questions

None (per spec).
