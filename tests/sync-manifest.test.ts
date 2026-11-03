import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import { parseSyncManifestJson, SYNC_MANIFEST_SCHEMA_VERSION } from "../src/sync-manifest.js";

const CONV_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("sync-manifest", () => {
  const lz = path.join(os.tmpdir(), "lz-test");

  it("parses a minimal valid manifest", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "templates/store.db" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: CONV_ID,
          store_db_file: "payloads/conv1/store.db",
        },
      ],
      metadata_overrides: {
        composer_header_payloads: [{ allComposers: [] }],
      },
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(true);
    if (!r.ok) {
      return;
    }
    expect(r.manifest.chat_history).toHaveLength(1);
    expect(r.manifest.db_template.sqlite_file).toBe("templates/store.db");
  });

  it("rejects path traversal in sqlite_file", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "../../etc/passwd" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: CONV_ID,
          inline: { title: "t", content: [{ role: "user", content: "x" }], timestamp: 1 },
        },
      ],
      metadata_overrides: {},
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(false);
  });

  it("rejects conversation_id path traversal / non-UUID", () => {
    const raw = JSON.stringify({
      schema_version: SYNC_MANIFEST_SCHEMA_VERSION,
      state_target: "global",
      workspace_key: "wk1",
      db_template: { sqlite_file: "templates/store.db" },
      chat_history: [
        {
          workspace_key: "wk1",
          conversation_id: "../../../tmp/pwn",
          store_db_file: "payloads/x/store.db",
        },
      ],
      metadata_overrides: {},
    });
    const r = parseSyncManifestJson(raw, lz);
    expect(r.ok).toBe(false);
    if (r.ok) {
      return;
    }
    expect(r.errors.some((e) => e.includes("conversation_id"))).toBe(true);
  });
});
