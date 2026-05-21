import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatBundle } from "../src/chat-persistence.js";
import { mergeComposerDataAdditive } from "../src/composer-merge.js";
import {
  composerDataForFocus,
  filterComposerDataForConversation,
  filterComposerHeadersForConversation,
  headersPayloadForImport,
  pinComposerAsMostRecent,
  prepareComposerDataForImport,
  prepareHeadersForImport,
  stampWorkspaceIdentifierOnHeaders,
  type WorkspaceIdentifier,
} from "../src/chat-import-merge.js";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const testsDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureDir = path.join(testsDir, "fixtures", "chat-import-merge");

const FIXED_NOW_MS = 1774872000100;
const EXPECTED_PIN_MS = FIXED_NOW_MS + 1;

function loadJson<T>(name: string): T {
  return JSON.parse(readFileSync(path.join(fixtureDir, name), "utf-8")) as T;
}

function normalizePinTimestamps(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizePinTimestamps);
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === "lastUpdatedAt" || k === "lastOpenedAt") {
        const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
        out[k] = n >= EXPECTED_PIN_MS - 2 && n <= EXPECTED_PIN_MS + 2 ? EXPECTED_PIN_MS : v;
      } else {
        out[k] = normalizePinTimestamps(v);
      }
    }
    return out;
  }
  return value;
}

describe("chat-import-merge", () => {
  const bundle = loadJson<ChatBundle>("bundle.json");
  const workspaceIdentifier = loadJson<WorkspaceIdentifier>("workspace-identifier.json");
  const existingHeaders = loadJson<{ allComposers: Array<Record<string, unknown>> }>("existing-headers.json");
  const existingData = loadJson<Record<string, unknown>>("existing-data.json");
  const golden = loadJson<Record<string, unknown>>("golden-python.json");
  const cid = bundle.conversationId;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW_MS);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("filterComposerHeadersForConversation matches Python golden", () => {
    const snap = bundle.sidebarSnapshot as Record<string, unknown>;
    const headers = snap.composerHeaders as Record<string, unknown>;
    const result = filterComposerHeadersForConversation(headers, cid);
    expect(result).toEqual(golden.filterComposerHeadersForConversation);
  });

  it("filterComposerDataForConversation matches Python golden", () => {
    const snap = bundle.sidebarSnapshot as Record<string, unknown>;
    const data = snap.composerData as Record<string, unknown>;
    const result = filterComposerDataForConversation(data, cid);
    expect(result).toEqual(golden.filterComposerDataForConversation);
  });

  it("headersPayloadForImport matches Python golden", () => {
    const result = headersPayloadForImport(bundle);
    expect(result).toEqual(golden.headersPayloadForImport);
  });

  it("pinComposerAsMostRecent bumps target row timestamps", () => {
    const payload = headersPayloadForImport(bundle);
    const result = pinComposerAsMostRecent(payload, cid);
    const row = result.allComposers.find((c) => c.composerId === cid);
    expect(row?.lastUpdatedAt).toBe(EXPECTED_PIN_MS);
    expect(row?.lastOpenedAt).toBe(EXPECTED_PIN_MS);
    expect(normalizePinTimestamps(result)).toEqual(normalizePinTimestamps(golden.pinComposerAsMostRecent));
  });

  it("stampWorkspaceIdentifierOnHeaders stamps only target composerId", () => {
    const payload = headersPayloadForImport(bundle);
    const pinned = pinComposerAsMostRecent(payload, cid);
    const result = stampWorkspaceIdentifierOnHeaders(pinned, cid, workspaceIdentifier);
    const target = result.allComposers.find((c) => c.composerId === cid);
    expect(target?.workspaceIdentifier).toEqual(workspaceIdentifier);
    expect(normalizePinTimestamps(result)).toEqual(
      normalizePinTimestamps(golden.stampWorkspaceIdentifierOnHeaders)
    );
  });

  it("composerDataForFocus then snapshot merge matches Python golden", () => {
    const snap = bundle.sidebarSnapshot as Record<string, unknown>;
    const data = snap.composerData as Record<string, unknown>;
    let merged = composerDataForFocus(cid, JSON.stringify(existingData));
    const extra = filterComposerDataForConversation(data, cid);
    if (Object.keys(extra).length > 0) {
      merged = mergeComposerDataAdditive(JSON.stringify(merged), [extra]);
    }
    expect(merged).toEqual(golden.composerDataForFocus);
  });

  it("prepareComposerDataForImport matches Python golden", () => {
    const result = prepareComposerDataForImport(JSON.stringify(existingData), bundle, cid);
    expect(result).toEqual(golden.composerDataForFocus);
  });

  it("prepareHeadersForImport matches Python golden (pin + stamp)", () => {
    const result = prepareHeadersForImport(
      JSON.stringify(existingHeaders),
      bundle,
      cid,
      workspaceIdentifier,
      { pinRecent: true }
    );
    expect(normalizePinTimestamps(result)).toEqual(
      normalizePinTimestamps(golden.prepareHeadersForImport)
    );
  });

  it("stamp leaves non-target rows workspaceIdentifier unchanged", () => {
    const headers = {
      allComposers: [
        { composerId: cid, name: "A" },
        { composerId: "other", name: "B", workspaceIdentifier: { id: "keep" } },
      ],
    };
    const result = stampWorkspaceIdentifierOnHeaders(headers, cid, workspaceIdentifier);
    expect(result.allComposers[1]?.workspaceIdentifier).toEqual({ id: "keep" });
    expect(result.allComposers[0]?.workspaceIdentifier).toEqual(workspaceIdentifier);
  });
});
