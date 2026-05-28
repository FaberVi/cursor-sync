# Chat Export QuickPick Human Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show resolved workspace folder paths and meaningful conversation titles in all chat/transcript QuickPick flows (export, import, transcript export).

**Architecture:** Build a one-shot `workspaceStorage` → chats-key folder map and a one-shot composer name index per picker flow; add pure label/title helpers in `chat-workspace-label.ts`, `chat-workspace-context.ts`, `composer-merge.ts`, and `transcript-bundle.ts`; wire existing QuickPick call sites without changing picker return values (`description` still holds keys/ids).

**Tech Stack:** TypeScript, Node `fs`/`path`/`crypto`, VS Code Extension API (`showQuickPick`), Vitest, existing `__chatPersistenceInternals` (`resolveStateDbCandidates`, `querySqliteRows`), `md5FolderKey`, `parseComposerHeadersBlob`.

**Spec:** `docs/superpowers/specs/2026-05-21-chat-export-quickpick-labels-design.md`

---

## File map

| File | Action | Responsibility |
|------|--------|----------------|
| `src/chat-workspace-context.ts` | Modify | Export `folderFromWorkspaceJson`; add `buildChatsKeyToFolderMap` |
| `src/chat-workspace-label.ts` | Modify | `formatDisplayPath`, `workspaceQuickPickLabel`, `projectQuickPickLabel`, `resolveFolderForProjectDir` |
| `src/composer-merge.ts` | Modify | `loadComposerNameIndex`, `getComposerDisplayName` |
| `src/transcript-bundle.ts` | Modify | Picker-only title helpers (`isTranscriptBoilerplate`, `firstMeaningfulTranscriptTitle`, `resolveConversationDisplayTitle`) |
| `src/chat-export-ux.ts` | Modify | Folder map + composer index; workspace/conversation labels |
| `src/import-gist-transcripts.ts` | Modify | Workspace + project mapping labels |
| `src/chat-persistence.ts` | Modify | Project mapping labels in `promptForTargetProject` |
| `src/transcripts.ts` | Modify | `discoverExportConversationCandidates` labels |
| `tests/chat-workspace-label.test.ts` | Modify | Path format, QuickPick label, folder map tests |
| `tests/chat-workspace-context.test.ts` | Modify | `buildChatsKeyToFolderMap` fixture test |
| `tests/transcript-bundle.test.ts` | Modify | Boilerplate + title resolution tests |
| `tests/composer-merge-index.test.ts` | Create | Composer index from headers blob / mocked DB |
| `tests/chat-export-ux.test.ts` | Modify | Conversation label priority tests |

---

### Task 1: `formatDisplayPath`

**Files:**
- Modify: `src/chat-workspace-label.ts`
- Modify: `tests/chat-workspace-label.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/chat-workspace-label.test.ts`:

```typescript
import * as os from "node:os";
import * as path from "node:path";

describe("formatDisplayPath", () => {
  it("shortens paths under home with tilde", async () => {
    const { formatDisplayPath } = await import("../src/chat-workspace-label.js");
    const home = os.homedir();
    const folder = path.join(home, "dev", "private", "cursor-sync");
    expect(formatDisplayPath(folder, home)).toBe("~/dev/private/cursor-sync");
  });

  it("normalizes trailing slash before home prefix match", async () => {
    const { formatDisplayPath } = await import("../src/chat-workspace-label.js");
    const home = "/home/user";
    expect(formatDisplayPath("/home/user/proj/", home)).toBe("~/proj");
  });

  it("returns absolute path when outside home", async () => {
    const { formatDisplayPath } = await import("../src/chat-workspace-label.js");
    const abs = "/var/lib/cursor/proj";
    expect(formatDisplayPath(abs, "/home/user")).toBe(abs);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-workspace-label.test.ts -t formatDisplayPath`
Expected: FAIL — `formatDisplayPath` is not exported

- [ ] **Step 3: Write minimal implementation**

Add to `src/chat-workspace-label.ts`:

```typescript
import * as os from "node:os";
import * as path from "node:path";

export function formatDisplayPath(folderFsPath: string, homeDir: string = os.homedir()): string {
  const normalized = path.resolve(folderFsPath);
  const home = path.resolve(homeDir);
  const homeWithSep = home.endsWith(path.sep) ? home : home + path.sep;
  if (normalized === home) {
    return "~";
  }
  if (normalized.startsWith(homeWithSep)) {
    return "~" + path.sep + normalized.slice(homeWithSep.length);
  }
  return normalized;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-workspace-label.test.ts -t formatDisplayPath`
Expected: PASS (3 tests)

- [ ] **Step 5: Commit**

```bash
git add src/chat-workspace-label.ts tests/chat-workspace-label.test.ts
git commit -m "feat: add formatDisplayPath for workspace QuickPick labels"
```

---

### Task 2: `buildChatsKeyToFolderMap`

**Files:**
- Modify: `src/chat-workspace-context.ts`
- Modify: `tests/chat-workspace-context.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-workspace-context.test.ts` (reuse existing `beforeEach` that mocks `resolveSyncRoots` and `pathToFileUri` helper at file bottom):

```typescript
import { buildChatsKeyToFolderMap } from "../src/chat-workspace-context.js";

describe("buildChatsKeyToFolderMap", () => {
  it("maps md5(folder) to resolved folder path from workspace.json entries", async () => {
    const folder = path.join(tempRoot, "mapped-repo");
    await fs.mkdir(folder, { recursive: true });
    const resolved = path.resolve(folder);
    const storageId = "map-storage-1";
    const wsDir = path.join(cursorUser, "workspaceStorage", storageId);
    await fs.mkdir(wsDir, { recursive: true });
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: pathToFileUri(folder) }),
      "utf8"
    );
    await fs.writeFile(path.join(wsDir, "broken.json"), "not-json", "utf8");

    const map = await buildChatsKeyToFolderMap(cursorUser);
    expect(map.get(md5FolderKey(resolved))).toBe(resolved);
    expect(map.size).toBe(1);
  });
});
```

Place the `describe` inside the existing `resolveWorkspaceContext` `beforeEach` scope **or** duplicate a minimal `beforeEach` with `tempRoot` / `cursorUser` like sibling tests.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-workspace-context.test.ts -t buildChatsKeyToFolderMap`
Expected: FAIL — `buildChatsKeyToFolderMap` not exported

- [ ] **Step 3: Write minimal implementation**

In `src/chat-workspace-context.ts`:

1. Rename `folderFromWorkspaceJson` to exported `folderFromWorkspaceJson` (export the existing function).
2. Add:

```typescript
export async function buildChatsKeyToFolderMap(
  cursorUser: string
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const wsRoot = path.join(cursorUser, "workspaceStorage");
  let entries: string[];
  try {
    entries = await fs.readdir(wsRoot);
  } catch {
    return map;
  }
  for (const ent of entries) {
    const wj = path.join(wsRoot, ent, "workspace.json");
    const folder = await folderFromWorkspaceJson(wj);
    if (!folder) {
      continue;
    }
    const folderFsPath = path.resolve(folder);
    map.set(md5FolderKey(folderFsPath), folderFsPath);
  }
  return map;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-workspace-context.test.ts -t buildChatsKeyToFolderMap`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-workspace-context.ts tests/chat-workspace-context.test.ts
git commit -m "feat: build chats workspace key to folder path map"
```

---

### Task 3: Workspace and project QuickPick label helpers

**Files:**
- Modify: `src/chat-workspace-label.ts`
- Modify: `tests/chat-workspace-label.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/chat-workspace-label.test.ts`:

```typescript
import { md5FolderKey } from "../src/chat-workspace-context.js";

describe("workspaceQuickPickLabel", () => {
  it("uses tilde path when key resolves in map", async () => {
    const { workspaceQuickPickLabel } = await import("../src/chat-workspace-label.js");
    const home = os.homedir();
    const folder = path.join(home, "dev", "app");
    const key = md5FolderKey(folder);
    const map = new Map([[key, folder]]);
    const row = workspaceQuickPickLabel(key, map, home);
    expect(row.label).toBe("~/dev/app");
    expect(row.description).toBe(key);
  });

  it("falls back to humanWorkspaceLabel for unknown key", async () => {
    const { workspaceQuickPickLabel, humanWorkspaceLabel } = await import(
      "../src/chat-workspace-label.js"
    );
    const key = "573b4babd5b2f206e06d748cd840b177";
    const row = workspaceQuickPickLabel(key, new Map(), os.homedir());
    expect(row.label).toBe(humanWorkspaceLabel(key));
    expect(row.description).toBe(key);
  });
});

describe("projectQuickPickLabel", () => {
  it("uses tilde path when project dir matches map folder basename", async () => {
    const { projectQuickPickLabel } = await import("../src/chat-workspace-label.js");
    const home = os.homedir();
    const folder = path.join(home, "dev", "cursor-sync");
    const map = new Map([[md5FolderKey(folder), folder]]);
    const projectDir = "home-user-dev-cursor-sync-abcdef12";
    expect(projectQuickPickLabel(projectDir, map, home)).toBe("~/dev/cursor-sync");
  });

  it("falls back to humanWorkspaceLabel when no match", async () => {
    const { projectQuickPickLabel, humanWorkspaceLabel } = await import(
      "../src/chat-workspace-label.js"
    );
    const name = "orphan-project-abcdef12";
    expect(projectQuickPickLabel(name, new Map(), os.homedir())).toBe(
      humanWorkspaceLabel(name)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-workspace-label.test.ts -t "workspaceQuickPickLabel|projectQuickPickLabel"`
Expected: FAIL — helpers not exported

- [ ] **Step 3: Write minimal implementation**

Add to `src/chat-workspace-label.ts`:

```typescript
import { md5FolderKey } from "./chat-workspace-context.js";

function resolveFolderForProjectDir(
  projectFolderName: string,
  map: Map<string, string>
): string | undefined {
  const label = humanWorkspaceLabel(projectFolderName).toLowerCase();
  for (const folderFsPath of map.values()) {
    const base = path.basename(folderFsPath).toLowerCase();
    if (base === label) {
      return folderFsPath;
    }
    const folderLabel = humanWorkspaceLabel(path.basename(folderFsPath)).toLowerCase();
    if (folderLabel === label) {
      return folderFsPath;
    }
    const loosePath = folderFsPath.toLowerCase();
    const looseLabel = label.replace(/-/g, path.sep);
    if (
      projectFolderName.toLowerCase().includes(base) ||
      loosePath.includes(looseLabel)
    ) {
      return folderFsPath;
    }
  }
  return undefined;
}

export function workspaceQuickPickLabel(
  chatsKey: string,
  map: Map<string, string>,
  homeDir?: string
): { label: string; description: string } {
  const folderFsPath = map.get(chatsKey);
  if (folderFsPath) {
    return {
      label: formatDisplayPath(folderFsPath, homeDir),
      description: chatsKey,
    };
  }
  return {
    label: humanWorkspaceLabel(chatsKey),
    description: chatsKey,
  };
}

export function projectQuickPickLabel(
  projectFolderName: string,
  map: Map<string, string>,
  homeDir?: string
): string {
  const folderFsPath = resolveFolderForProjectDir(projectFolderName, map);
  if (folderFsPath) {
    return formatDisplayPath(folderFsPath, homeDir);
  }
  return humanWorkspaceLabel(projectFolderName);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-workspace-label.test.ts`
Expected: PASS (all tests in file)

- [ ] **Step 5: Commit**

```bash
git add src/chat-workspace-label.ts tests/chat-workspace-label.test.ts
git commit -m "feat: add workspace and project QuickPick label helpers"
```

---

### Task 4: Picker-only transcript title helpers

**Files:**
- Modify: `src/transcript-bundle.ts`
- Modify: `tests/transcript-bundle.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/transcript-bundle.test.ts`:

```typescript
import {
  firstMeaningfulTranscriptTitle,
  isTranscriptBoilerplate,
  resolveConversationDisplayTitle,
} from "../src/transcript-bundle.js";

describe("picker conversation title helpers", () => {
  it("detects known skills/system preamble as boilerplate", () => {
    expect(
      isTranscriptBoilerplate("The user has manually attached the following skills to their message.")
    ).toBe(true);
    expect(isTranscriptBoilerplate("<manually_attached_skills>")).toBe(true);
    expect(isTranscriptBoilerplate("You have superpowers.")).toBe(true);
    expect(isTranscriptBoilerplate("What is the best way to export chats?")).toBe(false);
  });

  it("prefers first meaningful user line over preamble", () => {
    const transcript = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "The user has manually attached the following skills to their message.",
            },
          ],
        },
      }),
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "Export chats with readable titles" }],
        },
      }),
    ].join("\n");
    expect(firstMeaningfulTranscriptTitle(transcript, "conv-1")).toContain(
      "Export chats with readable titles"
    );
  });

  it("resolveConversationDisplayTitle applies composer > transcript > id", () => {
    expect(
      resolveConversationDisplayTitle({
        conversationId: "id-1",
        composerName: "  My Chat  ",
        transcriptContent: "",
      })
    ).toBe("My Chat");
    const transcript = JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "Hello from user" }] },
    });
    expect(
      resolveConversationDisplayTitle({
        conversationId: "id-2",
        transcriptContent: transcript,
      })
    ).toContain("Hello from user");
    expect(
      resolveConversationDisplayTitle({
        conversationId: "id-3",
        transcriptContent: "",
      })
    ).toBe("id-3");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/transcript-bundle.test.ts -t "picker conversation title"`
Expected: FAIL — symbols not exported

- [ ] **Step 3: Write minimal implementation**

Add to `src/transcript-bundle.ts` (after `summarizeTranscriptForSidebar`, reusing private `collectTranscriptSnippets`, `normalizePreviewLine`, `truncateText`):

```typescript
const BOILERPLATE_PREFIXES = [
  "The user has manually attached the following skills",
  "<manually_attached_skills>",
  "<EXTREMELY_IMPORTANT>",
  "You have superpowers",
  "Below is the full content of your",
];

export function isTranscriptBoilerplate(text: string): boolean {
  const line = normalizePreviewLine(text);
  if (!line) {
    return true;
  }
  for (const prefix of BOILERPLATE_PREFIXES) {
    if (line.startsWith(prefix)) {
      return true;
    }
  }
  const nonSpace = line.replace(/\s/g, "");
  if (!nonSpace) {
    return true;
  }
  const tagMatches = line.match(/<[^>]+>/g) ?? [];
  const tagChars = tagMatches.join("").replace(/\s/g, "").length;
  if (tagChars / nonSpace.length > 0.5) {
    return true;
  }
  return false;
}

export function firstMeaningfulTranscriptTitle(
  transcriptContent: string,
  conversationId: string
): string | null {
  const userSnippets: string[] = [];
  const anySnippets: string[] = [];

  for (const rawLine of transcriptContent.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      continue;
    }
    let parsedLine: Record<string, unknown>;
    try {
      parsedLine = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const role =
      typeof parsedLine.role === "string" ? parsedLine.role.trim().toLowerCase() : "";
    for (const snippet of collectTranscriptSnippets(parsedLine)) {
      const normalized = normalizePreviewLine(snippet);
      if (!normalized || isTranscriptBoilerplate(normalized)) {
        continue;
      }
      anySnippets.push(normalized);
      if (role === "user") {
        userSnippets.push(normalized);
      }
    }
  }

  const first = userSnippets[0] ?? anySnippets[0];
  return first ? truncateText(first, 96) : null;
}

export function resolveConversationDisplayTitle(options: {
  conversationId: string;
  composerName?: string | null;
  transcriptContent?: string | null;
}): string {
  const trimmed = options.composerName?.trim();
  if (trimmed) {
    return trimmed;
  }
  if (options.transcriptContent) {
    const fromTranscript = firstMeaningfulTranscriptTitle(
      options.transcriptContent,
      options.conversationId
    );
    if (fromTranscript) {
      return fromTranscript;
    }
  }
  return options.conversationId;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/transcript-bundle.test.ts -t "picker conversation title"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transcript-bundle.ts tests/transcript-bundle.test.ts
git commit -m "feat: add picker-only conversation title resolution helpers"
```

---

### Task 5: Composer name index

**Files:**
- Modify: `src/composer-merge.ts`
- Create: `tests/composer-merge-index.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/composer-merge-index.test.ts`:

```typescript
import { describe, expect, it, vi, beforeEach } from "vitest";
import { parseComposerHeadersBlob } from "../src/composer-merge.js";

const querySqliteRowsMock = vi.fn();
const resolveStateDbCandidatesMock = vi.fn();

vi.mock("../src/transcripts.js", () => ({
  __chatPersistenceInternals: {
    querySqliteRows: (...args: unknown[]) => querySqliteRowsMock(...args),
    resolveStateDbCandidates: () => resolveStateDbCandidatesMock(),
  },
}));

describe("composer name index", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it("getComposerDisplayName returns trimmed name from index", async () => {
    const { getComposerDisplayName } = await import("../src/composer-merge.js");
    const index = new Map([["conv-a", "  Sidebar Title  "]]);
    expect(getComposerDisplayName(index, "conv-a")).toBe("Sidebar Title");
    expect(getComposerDisplayName(index, "missing")).toBeUndefined();
  });

  it("loadComposerNameIndex parses composer.composerHeaders from first readable db", async () => {
    const headers = {
      allComposers: [
        { composerId: "c1", name: "First", type: "head" },
        { composerId: "c2", name: "" },
        { composerId: "c3", name: "Third" },
      ],
    };
    resolveStateDbCandidatesMock.mockResolvedValue(["/tmp/state.vscdb"]);
    querySqliteRowsMock.mockResolvedValue([{ value: JSON.stringify(headers) }]);

    const { loadComposerNameIndex } = await import("../src/composer-merge.js");
    const index = await loadComposerNameIndex();
    expect(index.get("c1")).toBe("First");
    expect(index.has("c2")).toBe(false);
    expect(index.get("c3")).toBe("Third");
    expect(querySqliteRowsMock).toHaveBeenCalledWith(
      "/tmp/state.vscdb",
      "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1"
    );
  });

  it("loadComposerNameIndex returns empty map when no db candidates", async () => {
    resolveStateDbCandidatesMock.mockResolvedValue([]);
    const { loadComposerNameIndex } = await import("../src/composer-merge.js");
    const index = await loadComposerNameIndex();
    expect(index.size).toBe(0);
    expect(querySqliteRowsMock).not.toHaveBeenCalled();
  });

  it("parseComposerHeadersBlob still used for empty blob", () => {
    expect(parseComposerHeadersBlob(undefined).allComposers).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/composer-merge-index.test.ts`
Expected: FAIL — `loadComposerNameIndex` / `getComposerDisplayName` not exported

- [ ] **Step 3: Write minimal implementation**

Add to `src/composer-merge.ts`:

```typescript
import { __chatPersistenceInternals } from "./transcripts.js";

const { querySqliteRows, resolveStateDbCandidates } = __chatPersistenceInternals;

export function buildComposerNameIndexFromHeadersRaw(
  raw: string | undefined
): Map<string, string> {
  const map = new Map<string, string>();
  const { allComposers } = parseComposerHeadersBlob(raw);
  for (const record of allComposers) {
    const id = getComposerId(record);
    const name = record.name;
    if (id && typeof name === "string") {
      const trimmed = name.trim();
      if (trimmed) {
        map.set(id, trimmed);
      }
    }
  }
  return map;
}

export function getComposerDisplayName(
  index: Map<string, string>,
  conversationId: string
): string | undefined {
  const name = index.get(conversationId);
  return name?.trim() ? name.trim() : undefined;
}

export async function loadComposerNameIndex(): Promise<Map<string, string>> {
  const candidates = await resolveStateDbCandidates();
  for (const dbPath of candidates) {
    try {
      const rows = await querySqliteRows(
        dbPath,
        "SELECT value FROM ItemTable WHERE key = 'composer.composerHeaders' LIMIT 1"
      );
      const raw = rows[0]?.value;
      if (typeof raw === "string" && raw.length > 0) {
        return buildComposerNameIndexFromHeadersRaw(raw);
      }
    } catch {
      continue;
    }
  }
  return new Map();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/composer-merge-index.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/composer-merge.ts tests/composer-merge-index.test.ts
git commit -m "feat: load composer display names for QuickPick labels"
```

---

### Task 6: Wire `chat-export-ux.ts`

**Files:**
- Modify: `src/chat-export-ux.ts`
- Modify: `tests/chat-export-ux.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `tests/chat-export-ux.test.ts`:

```typescript
import { md5FolderKey } from "../src/chat-workspace-context.js";

describe("listConversationsForWorkspace labels", () => {
  it("uses composer name when provided in index", async () => {
    const wk = "wk-1";
    const convId = "conv-composer";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const index = new Map([[convId, "Composer Sidebar Name"]]);
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      composerIndex: index,
    });
    expect(rows[0]!.label).toBe("Composer Sidebar Name");
  });

  it("skips skills preamble and uses first user message", async () => {
    const wk = "wk-2";
    const convId = "conv-transcript";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const projectDir = path.join(projectsRoot, "proj-a");
    const transcriptDir = path.join(projectDir, "agent-transcripts", convId);
    await fs.mkdir(transcriptDir, { recursive: true });
    const transcript = [
      JSON.stringify({
        role: "user",
        message: {
          content: [
            {
              type: "text",
              text: "The user has manually attached the following skills to their message.",
            },
          ],
        },
      }),
      JSON.stringify({
        role: "user",
        message: {
          content: [{ type: "text", text: "Real user question here" }],
        },
      }),
    ].join("\n");
    await fs.writeFile(path.join(transcriptDir, `${convId}.jsonl`), transcript, "utf8");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      composerIndex: new Map(),
    });
    expect(rows[0]!.label).toContain("Real user question here");
  });

  it("falls back to conversationId when no title sources", async () => {
    const wk = "wk-3";
    const convId = "only-id";
    await fs.mkdir(path.join(chatsRoot, wk, convId), { recursive: true });
    await fs.writeFile(path.join(chatsRoot, wk, convId, "store.db"), "x");
    const projectsRoot = path.join(tmpRoot, ".cursor", "projects");
    const { listConversationsForWorkspace } = await import("../src/chat-export-ux.js");
    const rows = await listConversationsForWorkspace(wk, chatsRoot, projectsRoot, {
      composerIndex: new Map(),
    });
    expect(rows[0]!.label).toBe("only-id");
  });
});

describe("pickChatsForExport workspace labels", () => {
  it("shows resolved tilde path in workspace QuickPick label", async () => {
    const folder = path.join(tmpRoot, "dev", "my-app");
    await fs.mkdir(folder, { recursive: true });
    const chatsKey = md5FolderKey(path.resolve(folder));
    await fs.mkdir(path.join(chatsRoot, chatsKey), { recursive: true });
    const cursorUser = path.join(tmpRoot, "Cursor", "User");
    const wsDir = path.join(cursorUser, "workspaceStorage", "ws-1");
    await fs.mkdir(wsDir, { recursive: true });
    const { pathToFileURL } = await import("node:url");
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(path.resolve(folder)).href }),
      "utf8"
    );
    vi.doMock("../src/paths.js", () => ({
      resolveSyncRoots: () => ({
        cursorUser,
        dotCursor: path.join(tmpRoot, ".cursor"),
      }),
    }));
    vi.resetModules();
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { pickChatsForExport } = await import("../src/chat-export-ux.js");
    await pickChatsForExport();
    const firstPickArg = showQuickPickMock.mock.calls[0]![0] as Array<{
      label: string;
      description: string;
    }>;
    expect(firstPickArg[0]!.label).toBe("~/dev/my-app");
    expect(firstPickArg[0]!.description).toBe(chatsKey);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-export-ux.test.ts -t "labels"`
Expected: FAIL — `listConversationsForWorkspace` has no `composerIndex` option / workspace label unchanged

- [ ] **Step 3: Write minimal implementation**

In `src/chat-export-ux.ts`:

1. Replace imports:

```typescript
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import { workspaceQuickPickLabel } from "./chat-workspace-label.js";
import { loadComposerNameIndex } from "./composer-merge.js";
import { resolveConversationDisplayTitle } from "./transcript-bundle.js";
import { resolveSyncRoots } from "./paths.js";
```

Remove `humanWorkspaceLabel` and `summarizeTranscriptForSidebar` imports.

2. Add options type and transcript reader:

```typescript
export interface ListConversationsOptions {
  composerIndex?: Map<string, string>;
}

async function readTranscriptContentForConversation(
  projectsRoot: string,
  conversationId: string
): Promise<string | null> {
  // move body from transcriptTitleForConversation but return content string, not title
}
```

3. Change `listConversationsForWorkspace`:

```typescript
export async function listConversationsForWorkspace(
  workspaceKey: string,
  chatsRoot: string,
  projectsRoot: string,
  options: ListConversationsOptions = {}
): Promise<ConversationExportRow[]> {
  const composerIndex =
    options.composerIndex ?? (await loadComposerNameIndex());
  // ... existing loop ...
  const transcriptContent =
    (await readTranscriptContentForConversation(projectsRoot, conversationId)) ?? null;
  const title = resolveConversationDisplayTitle({
    conversationId,
    composerName: composerIndex.get(conversationId),
    transcriptContent,
  });
```

4. Change `pickChatsForExport`:

```typescript
const { cursorUser } = resolveSyncRoots();
const folderMap = await buildChatsKeyToFolderMap(cursorUser);
// workspace QuickPick:
workspaces.map((w) => {
  const row = workspaceQuickPickLabel(w.name, folderMap);
  return { label: row.label, description: row.description, detail: w.fullPath };
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-export-ux.test.ts`
Expected: PASS (all tests in file)

- [ ] **Step 5: Commit**

```bash
git add src/chat-export-ux.ts tests/chat-export-ux.test.ts
git commit -m "feat: human labels in chat export QuickPick flows"
```

---

### Task 7: Wire import workspace and project mapping pickers

**Files:**
- Modify: `src/import-gist-transcripts.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/chat-import-ux.test.ts` or create focused test in `tests/import-gist-labels.test.ts` if import tests are heavy — **prefer** extend `tests/chat-gist-export-import.test.ts` only if gist import already mocks workspace pickers. Minimal approach: add to `tests/chat-workspace-label.test.ts` an integration-style test is already covered in Task 3/6. For import wiring, add one test file:

Create `tests/import-gist-labels.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { md5FolderKey } from "../src/chat-workspace-context.js";

const showQuickPickMock = vi.fn();

vi.mock("vscode", () => ({
  window: { showQuickPick: showQuickPickMock, showErrorMessage: vi.fn() },
}));

describe("import gist workspace picker labels", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "import-gist-labels-"));
    vi.resetModules();
  });

  it("promptForTargetWorkspace uses workspaceQuickPickLabel", async () => {
    const folder = path.join(tmpRoot, "repo");
    await fs.mkdir(folder, { recursive: true });
    const key = md5FolderKey(path.resolve(folder));
    const cursorUser = path.join(tmpRoot, "Cursor", "User");
    const wsDir = path.join(cursorUser, "workspaceStorage", "id1");
    await fs.mkdir(wsDir, { recursive: true });
    const { pathToFileURL } = await import("node:url");
    await fs.writeFile(
      path.join(wsDir, "workspace.json"),
      JSON.stringify({ folder: pathToFileURL(path.resolve(folder)).href }),
      "utf8"
    );
    vi.doMock("../src/paths.js", () => ({
      resolveSyncRoots: () => ({ cursorUser, dotCursor: path.join(tmpRoot, ".cursor") }),
    }));
    vi.mock("node:os", async () => {
      const actual = await vi.importActual<typeof import("node:os")>("node:os");
      return { ...actual, homedir: () => tmpRoot };
    });
    showQuickPickMock.mockResolvedValueOnce(undefined);
    const { __importGistTranscriptsTestUtils } = await import("../src/import-gist-transcripts.js");
    await __importGistTranscriptsTestUtils.promptForTargetWorkspace([
      { name: key, fullPath: path.join(tmpRoot, ".cursor", "chats", key) },
    ]);
    const firstPickArg = showQuickPickMock.mock.calls[0]![0] as Array<{
      label: string;
      description: string;
    }>;
    expect(firstPickArg[0]!.label).toBe(path.join("~", "repo"));
    expect(firstPickArg[0]!.description).toBe(key);
  });
});
```

Export test utils at bottom of `import-gist-transcripts.ts` (Step 3 below).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/import-gist-labels.test.ts`
Expected: FAIL until wiring + test utils export

- [ ] **Step 3: Write minimal implementation**

In `src/import-gist-transcripts.ts`:

```typescript
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import { projectQuickPickLabel, workspaceQuickPickLabel } from "./chat-workspace-label.js";
import { resolveSyncRoots } from "./paths.js";
```

At start of `promptForTargetWorkspace`:

```typescript
const { cursorUser } = resolveSyncRoots();
const folderMap = await buildChatsKeyToFolderMap(cursorUser);
const picks = localWorkspaces.map((w) => {
  const row = workspaceQuickPickLabel(w.name, folderMap);
  return { label: row.label, description: row.description, detail: w.fullPath };
});
```

At start of `promptForProjectMapping`:

```typescript
const { cursorUser } = resolveSyncRoots();
const folderMap = await buildChatsKeyToFolderMap(cursorUser);
// local project rows:
label: projectQuickPickLabel(p.name, folderMap),
```

Export test utils at file end:

```typescript
export const __importGistTranscriptsTestUtils = {
  promptForTargetWorkspace,
  promptForProjectMapping,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/import-gist-labels.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/import-gist-transcripts.ts tests/import-gist-labels.test.ts
git commit -m "feat: human labels in gist transcript import QuickPicks"
```

---

### Task 8: Wire `chat-persistence.ts` project mapping

**Files:**
- Modify: `src/chat-persistence.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/chat-persistence.test.ts` (or create `tests/chat-persistence-labels.test.ts` if persistence tests are large) a test that calls exported `__chatPersistenceTestUtils.promptForTargetProject` with mocked `showQuickPick` and asserts first local project row `label` uses tilde path when folder map matches. Mirror Task 7 pattern.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/chat-persistence.test.ts -t project`
Expected: FAIL until wired

- [ ] **Step 3: Write minimal implementation**

In `promptForTargetProject` inside `src/chat-persistence.ts`:

```typescript
import { buildChatsKeyToFolderMap } from "./chat-workspace-context.js";
import { projectQuickPickLabel } from "./chat-workspace-label.js";
import { resolveSyncRoots } from "./paths.js";

// at function start:
const { cursorUser } = resolveSyncRoots();
const folderMap = await buildChatsKeyToFolderMap(cursorUser);

const picks: vscode.QuickPickItem[] = localProjects.map((p) => ({
  label: projectQuickPickLabel(p.name, folderMap),
  description: p.name,
  detail: path.join(projectsRoot, p.name),
}));
```

Expose `promptForTargetProject` on existing test utils export if present.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/chat-persistence.test.ts -t project`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/chat-persistence.ts tests/chat-persistence.test.ts
git commit -m "feat: resolved paths in chat restore project mapping picker"
```

---

### Task 9: Wire transcript export candidate labels

**Files:**
- Modify: `src/transcripts.ts`
- Modify: `tests/transcripts.test.ts` (optional label assertion)

- [ ] **Step 1: Write the failing test**

Add to `tests/transcripts.test.ts`:

```typescript
it("discoverExportConversationCandidates uses composer name for label", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "tx-labels-"));
  const projectsRoot = path.join(tmp, ".cursor", "projects");
  const projectDir = path.join(projectsRoot, "proj-one");
  const convId = "conv-xyz";
  const transcriptDir = path.join(projectDir, "agent-transcripts", convId);
  await fs.mkdir(transcriptDir, { recursive: true });
  await fs.writeFile(
    path.join(transcriptDir, `${convId}.jsonl`),
    JSON.stringify({
      role: "user",
      message: { content: [{ type: "text", text: "ignored when composer set" }] },
    }),
    "utf8"
  );
  const projects = [
    { folderName: "proj-one", fullPath: projectDir, label: "proj-one" },
  ];
  const { discoverExportConversationCandidates } = await import("../src/transcripts.js");
  vi.spyOn(
    (await import("../src/composer-merge.js")),
    "loadComposerNameIndex"
  ).mockResolvedValue(new Map([[convId, "Export Picker Title"]]));
  const candidates = await discoverExportConversationCandidates(projects, 5_000_000);
  expect(candidates[0]!.label).toBe("Export Picker Title");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- tests/transcripts.test.ts -t discoverExportConversationCandidates`
Expected: FAIL — label still from `summarizeTranscriptForSidebar`

- [ ] **Step 3: Write minimal implementation**

In `discoverExportConversationCandidates` (`src/transcripts.ts`):

```typescript
import { loadComposerNameIndex } from "./composer-merge.js";
import { resolveConversationDisplayTitle } from "./transcript-bundle.js";

// at function start:
const composerIndex = await loadComposerNameIndex();

// replace summary.title assignment:
label: resolveConversationDisplayTitle({
  conversationId,
  composerName: composerIndex.get(conversationId),
  transcriptContent: primaryContent || null,
}),
```

Keep `summarizeTranscriptForSidebar` import if used elsewhere in file; remove only from this label path.

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- tests/transcripts.test.ts -t discoverExportConversationCandidates`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/transcripts.ts tests/transcripts.test.ts
git commit -m "feat: human conversation labels in transcript export picker"
```

---

### Task 10: Full verification

**Files:** (none)

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: all tests PASS

- [ ] **Step 2: Run TypeScript compile if project uses separate check**

Run: `npm run compile` (if defined in `package.json`; otherwise `npm run build`)
Expected: success with no errors

- [ ] **Step 3: Manual smoke checklist**

1. Command **Cursor Sync: Export Chat to Private Gist** with 2+ workspaces — workspace picker primary label shows `~/…` path; description remains md5 key.
2. Conversation picker — row with composer sidebar name shows that name; row with only skills preamble shows first real user line or conversation id.
3. **Import Agent Transcripts from Private Gist** — target workspace picker shows resolved path labels.
4. Project mapping picker — local project rows show `~/…` when mappable.
5. Transcript export flow — conversation list labels match composer/title rules.

- [ ] **Step 4: Commit only if fixes were required**

```bash
git add -A
git commit -m "fix: address label helper edge cases from full test run"
```

---

## Spec coverage checklist (self-review)

| Spec requirement | Task |
|------------------|------|
| `buildChatsKeyToFolderMap` scans `workspaceStorage` | Task 2 |
| `formatDisplayPath` tilde under `$HOME` | Task 1 |
| `workspaceQuickPickLabel` resolved + fallback | Task 3 |
| `projectQuickPickLabel` for import project rows | Task 3, 7, 8 |
| `loadComposerNameIndex` / `getComposerDisplayName` | Task 5 |
| `isTranscriptBoilerplate`, `firstMeaningfulTranscriptTitle`, `resolveConversationDisplayTitle` | Task 4 |
| `chat-export-ux.ts` wiring | Task 6 |
| `import-gist-transcripts.ts` wiring | Task 7 |
| `chat-persistence.ts` project mapping | Task 8 |
| `transcripts.ts` `discoverExportConversationCandidates` | Task 9 |
| Do not change `summarizeTranscriptForSidebar` globally | No task modifies its behavior |
| Error handling: empty maps on failure | Tasks 2, 5 return empty `Map`; label helpers fall back |
| Tests in listed test files | Tasks 1–9 |

## Open questions

None (per spec).
