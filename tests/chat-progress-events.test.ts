import { describe, expect, it } from "vitest";
import {
  emitChatImportProgress,
  onChatImportProgress,
  type ChatImportProgressEvent,
} from "../src/chat-progress-events.js";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

describe("chat-progress-events", () => {
  it("emits and subscribes", async () => {
    const received: ChatImportProgressEvent[] = [];
    const sub = onChatImportProgress((e) => received.push(e));
    try {
      emitChatImportProgress({ conversationId: "c1", phase: "A", step: "start" });
      emitChatImportProgress({ conversationId: "c1", phase: "B", step: "done", ok: true });
    } finally {
      sub.dispose();
    }
    expect(received).toHaveLength(2);
    expect(received[0]!.phase).toBe("A");
    expect(received[1]!.ok).toBe(true);
    expect(typeof received[0]!.timestamp).toBe("string");
  });
});
