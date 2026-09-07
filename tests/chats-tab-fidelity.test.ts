import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  fidelityFieldsForImportHistory,
  publishImportFidelitySummary,
} from "../src/sidebar/chats-tab-fidelity.js";
import { onChatImportProgress } from "../src/chat-progress-events.js";
import type { ChatBundleFidelitySummary } from "../src/chat-bundle-fidelity.js";

const textOnlySummary: ChatBundleFidelitySummary = {
  schemaVersion: 2,
  diskKvRowCount: 0,
  toolBubbleCount: 0,
  textOnlyLayer4: true,
  warnings: ["Text-only Layer 4 (cursorDiskKV): bundle has no diskKvSnapshot."],
};

describe("publishImportFidelitySummary", () => {
  it("emits fidelity-summary progress with text-only warning", () => {
    const received: unknown[] = [];
    const sub = onChatImportProgress((e) => received.push(e));
    try {
      publishImportFidelitySummary("conv-1", textOnlySummary);
    } finally {
      sub.dispose();
    }
    expect(received).toHaveLength(1);
    const event = received[0] as {
      step: string;
      ok?: boolean;
      fidelity?: ChatBundleFidelitySummary;
      detail?: string;
    };
    expect(event.step).toBe("fidelity-summary");
    expect(event.ok).toBe(false);
    expect(event.fidelity?.textOnlyLayer4).toBe(true);
    expect(event.detail).toContain("text-only Layer 4");
  });
});

describe("fidelityFieldsForImportHistory", () => {
  it("maps summary fields for import history rows", () => {
    const fields = fidelityFieldsForImportHistory(textOnlySummary);
    expect(fields.schemaVersion).toBe(2);
    expect(fields.textOnlyLayer4).toBe(true);
    expect(fields.toolBubbleCount).toBe(0);
    expect(fields.fidelityWarnings?.[0]).toContain("diskKvSnapshot");
  });
});
