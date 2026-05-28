import { describe, expect, it } from "vitest";
import {
  bundleHasNativeDiskKv,
  mergeFidelitySummaries,
  parsePythonInspectStdout,
  summarizeBundleFidelity,
} from "../src/chat-bundle-fidelity.js";
import type { ChatBundle } from "../src/chat-persistence.js";

function minimalBundle(overrides: Partial<ChatBundle> = {}): ChatBundle {
  return {
    schemaVersion: 1,
    type: "chat-persistence",
    createdAt: "2026-01-01T00:00:00Z",
    conversationId: "00000000-0000-4000-8000-000000000001",
    title: "t",
    subtitle: "s",
    previewText: "p",
    sidebarSnapshot: null,
    storeSnapshot: null,
    transcriptFiles: [],
    ...overrides,
  };
}

describe("summarizeBundleFidelity", () => {
  it("flags text-only Layer 4 for v1 bundles", () => {
    const summary = summarizeBundleFidelity(minimalBundle({ schemaVersion: 1 }));
    expect(summary.textOnlyLayer4).toBe(true);
    expect(summary.schemaVersion).toBe(1);
    expect(summary.warnings.some((w) => /text-only layer 4/i.test(w))).toBe(true);
  });

  it("flags text-only Layer 4 for v2 without diskKvSnapshot", () => {
    const summary = summarizeBundleFidelity(minimalBundle({ schemaVersion: 2 }));
    expect(summary.textOnlyLayer4).toBe(true);
    expect(summary.warnings[0]).toContain("diskKvSnapshot");
  });

  it("native diskKv when rows present", () => {
    const bundle = minimalBundle({
      schemaVersion: 2,
      diskKvSnapshot: {
        sourceStateDbPath: "/tmp/state.vscdb",
        rows: [{ key: "composerData:x", value: "{}", checksum: "abc" }],
        rowCount: 1,
        toolBubbleCount: 2,
      },
    });
    expect(bundleHasNativeDiskKv(bundle)).toBe(true);
    const summary = summarizeBundleFidelity(bundle);
    expect(summary.textOnlyLayer4).toBe(false);
    expect(summary.toolBubbleCount).toBe(2);
    expect(summary.warnings).toHaveLength(0);
  });
});

describe("parsePythonInspectStdout", () => {
  it("parses schema and diskKvSnapshot line", () => {
    const stdout = [
      '{',
      '  "schemaVersion": 2,',
      '  "conversationId": "abc"',
      "}",
      "transcriptFiles: 1",
      "diskKvSnapshot: 5 rows, 3 tool bubbles (source: /tmp/state.vscdb)",
    ].join("\n");
    const parsed = parsePythonInspectStdout(stdout);
    expect(parsed?.schemaVersion).toBe(2);
    expect(parsed?.diskKvRowCount).toBe(5);
    expect(parsed?.toolBubbleCount).toBe(3);
    expect(parsed?.textOnlyLayer4).toBe(false);
  });

  it("detects text-only from inspect when no diskKv line", () => {
    const stdout = '{\n  "schemaVersion": 1\n}\ntranscriptFiles: 0\n';
    const parsed = parsePythonInspectStdout(stdout);
    expect(parsed?.schemaVersion).toBe(1);
    expect(parsed?.textOnlyLayer4).toBe(true);
  });
});

describe("mergeFidelitySummaries", () => {
  it("prefers inspect counts when provided", () => {
    const fromBundle = summarizeBundleFidelity(minimalBundle({ schemaVersion: 2 }));
    const merged = mergeFidelitySummaries(fromBundle, {
      diskKvRowCount: 10,
      toolBubbleCount: 4,
      textOnlyLayer4: false,
    });
    expect(merged.diskKvRowCount).toBe(10);
    expect(merged.toolBubbleCount).toBe(4);
    expect(merged.textOnlyLayer4).toBe(false);
  });
});
