import { describe, expect, it } from "vitest";
import {
  bundleArtifactSyncKey,
  decodeTranscriptArtifact,
  encodeTranscriptArtifact,
  firstMeaningfulTranscriptTitle,
  getConversationIdFromRelativePath,
  getConversationScopedRelativePath,
  gistFileNameToSyncKey,
  isTranscriptBoilerplate,
  isTranscriptManifestV2,
  parseTranscriptBundleManifest,
  resolveConversationDisplayTitle,
  summarizeTranscriptForSidebar,
  syncKeyToGistFileName,
} from "../src/transcript-bundle.js";

describe("transcript bundle helpers", () => {
  it("round-trips artifact sync keys through gist file names", () => {
    const syncKey = bundleArtifactSyncKey(
      "home-marcelo-dev-private-cursor-sync",
      "1234-5678",
      "transcript",
      "subagents/child.jsonl"
    );

    expect(gistFileNameToSyncKey(syncKeyToGistFileName(syncKey))).toBe(syncKey);
  });

  it("encodes and decodes base64 artifacts", () => {
    const buffer = Buffer.from([0, 159, 255, 12, 200]);
    const encoded = encodeTranscriptArtifact(buffer, true);

    expect(encoded.encoding).toBe("base64");
    expect(decodeTranscriptArtifact(encoded.content, encoded.encoding).equals(buffer)).toBe(true);
  });

  it("parses schemaVersion 1 manifests for backward compatibility", () => {
    const manifest = parseTranscriptBundleManifest(
      JSON.stringify({
        schemaVersion: 1,
        type: "agent-transcripts",
        createdAt: "2026-03-30T00:00:00.000Z",
        sourceMachineId: "machine",
        sourceOS: "linux",
        sourceProjects: {
          source: {
            folderName: "source",
            fileCount: 1,
          },
        },
        files: {
          "transcripts/source/chat/chat.jsonl": {
            projectKey: "source",
            checksum: "abc",
            sizeBytes: 12,
          },
        },
      })
    );

    expect(isTranscriptManifestV2(manifest)).toBe(false);
    expect(manifest.schemaVersion).toBe(1);
  });

  it("parses schemaVersion 2 manifests", () => {
    const manifest = parseTranscriptBundleManifest(
      JSON.stringify({
        schemaVersion: 2,
        type: "agent-transcripts",
        createdAt: "2026-03-30T00:00:00.000Z",
        sourceMachineId: "machine",
        sourceOS: "linux",
        sourceProjects: {
          source: {
            folderName: "source",
            fileCount: 1,
            conversationCount: 1,
            artifactCount: 3,
          },
        },
        artifacts: {
          "artifacts/source/chat/transcript/chat.jsonl": {
            projectKey: "source",
            conversationId: "chat",
            kind: "transcript",
            checksum: "abc",
            sizeBytes: 12,
            contentType: "application/x-jsonlines",
            sourceRelativePath: "chat/chat.jsonl",
          },
        },
        conversations: {
          "source:chat": {
            projectKey: "source",
            conversationId: "chat",
            title: "Hello",
            subtitle: "1 message",
            previewText: "Hello",
            lastUpdatedAt: "2026-03-30T00:00:00.000Z",
            transcriptArtifacts: ["artifacts/source/chat/transcript/chat.jsonl"],
            sidebarArtifact: "artifacts/source/chat/sidebar/sidebar-metadata.json",
            warnings: [],
          },
        },
        warnings: [],
      })
    );

    expect(isTranscriptManifestV2(manifest)).toBe(true);
    if (isTranscriptManifestV2(manifest)) {
      expect(manifest.conversations["source:chat"]?.title).toBe("Hello");
    }
  });

  it("summarizes transcript content for sidebar metadata", () => {
    const transcript = [
      JSON.stringify({
        role: "user",
        timestamp: "2026-03-30T10:00:00.000Z",
        message: {
          content: [
            {
              type: "text",
              text: "<user_query>\nShip bundle v2 import/export fidelity.\n</user_query>",
            },
          ],
        },
      }),
      JSON.stringify({
        role: "assistant",
        timestamp: "2026-03-30T10:01:00.000Z",
        message: {
          content: [
            {
              type: "reasoning",
              text: "Inspecting transcript bundle plan.",
            },
            {
              type: "tool-result",
              output: "Validated current manifest format.",
            },
          ],
        },
      }),
    ].join("\n");

    const summary = summarizeTranscriptForSidebar(transcript, "chat-id");

    expect(summary.title).toContain("Ship bundle v2 import/export fidelity.");
    expect(summary.previewText).toContain("Validated current manifest format.");
    expect(summary.messageCount).toBe(2);
    expect(summary.participants).toEqual(["user", "assistant"]);
    expect(summary.lastUpdatedAt).toBe("2026-03-30T10:01:00.000Z");
  });

  it("extracts conversation-relative transcript paths", () => {
    expect(getConversationIdFromRelativePath("chat-id/subagents/child.jsonl")).toBe("chat-id");
    expect(getConversationScopedRelativePath("chat-id/subagents/child.jsonl")).toBe(
      "subagents/child.jsonl"
    );
  });

  it("maps subagent bundle paths to conversation-scoped sync keys", () => {
    const projectKey = "home-user-dev-cursor-sync";
    const conversationId = "conv-uuid";
    const scoped = getConversationScopedRelativePath(
      `${conversationId}/subagents/sub-111.jsonl`
    );
    expect(scoped).toBe("subagents/sub-111.jsonl");
    expect(
      bundleArtifactSyncKey(projectKey, conversationId, "transcript", scoped)
    ).toBe(`artifacts/${projectKey}/${conversationId}/transcript/subagents/sub-111.jsonl`);
  });

  it("uses deterministic artifact sync key paths for transcript store and sidebar kinds", () => {
    const projectKey = "home-user-dev-app";
    const conversationId = "conv-aaa";
    expect(bundleArtifactSyncKey(projectKey, conversationId, "transcript", "conv-aaa.jsonl")).toBe(
      `artifacts/${projectKey}/${conversationId}/transcript/conv-aaa.jsonl`
    );
    expect(bundleArtifactSyncKey(projectKey, conversationId, "store", "store.db")).toBe(
      `artifacts/${projectKey}/${conversationId}/store/store.db`
    );
    expect(
      bundleArtifactSyncKey(projectKey, conversationId, "sidebar", "sidebar-metadata.json")
    ).toBe(`artifacts/${projectKey}/${conversationId}/sidebar/sidebar-metadata.json`);
  });

  it("sorts canonical v2 artifact sync keys lexicographically by kind segment", () => {
    const projectKey = "p";
    const conversationId = "c";
    const keys = [
      bundleArtifactSyncKey(projectKey, conversationId, "transcript", "c.jsonl"),
      bundleArtifactSyncKey(projectKey, conversationId, "store", "store.db"),
      bundleArtifactSyncKey(projectKey, conversationId, "sidebar", "sidebar-metadata.json"),
    ].sort((a, b) => a.localeCompare(b));
    expect(keys).toEqual([
      `artifacts/${projectKey}/${conversationId}/sidebar/sidebar-metadata.json`,
      `artifacts/${projectKey}/${conversationId}/store/store.db`,
      `artifacts/${projectKey}/${conversationId}/transcript/c.jsonl`,
    ]);
  });
});

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
