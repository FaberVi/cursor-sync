import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  cursorDiskKvValueAsText,
  exportDiskKvSnapshot,
  isDiskKvKeyInConversationScope,
} from "../src/chat-disk-kv-export.js";

const execFileAsync = promisify(execFile);
const CID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const FIXTURE = path.join(
  process.cwd(),
  "resources/transport-chat/tests/fixtures/disk-kv-tool-bubbles"
);

describe("isDiskKvKeyInConversationScope", () => {
  it("accepts composerData and bubbleId keys for conversation", () => {
    expect(isDiskKvKeyInConversationScope(`composerData:${CID}`, CID)).toBe(true);
    expect(isDiskKvKeyInConversationScope(`bubbleId:${CID}:x`, CID)).toBe(true);
    expect(isDiskKvKeyInConversationScope(`bubbleId:other:x`, CID)).toBe(false);
  });
});

describe("cursorDiskKvValueAsText", () => {
  it("decodes hex-encoded BLOB values", () => {
    const json = '{"bubbleId":"b1","text":"hi"}';
    const hex = Buffer.from(json, "utf-8").toString("hex");
    expect(cursorDiskKvValueAsText(hex)).toBe(json);
  });

  it("passes through JSON strings", () => {
    const json = '{"toolFormerData":{"name":"grep"}}';
    expect(cursorDiskKvValueAsText(json)).toBe(json);
  });
});

describe("exportDiskKvSnapshot", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "disk-kv-export-"));
    dbPath = path.join(tmpDir, "state.vscdb");
    const composerPath = path.join(FIXTURE, "composerData.json");
    const bubbleToolPath = path.join(FIXTURE, "bubble-tool.json");
    const bubbleTextPath = path.join(FIXTURE, "bubble-text.json");
    const py = `
import json, sqlite3, sys
from pathlib import Path
cid = sys.argv[1]
db = sys.argv[2]
composer = json.loads(Path(sys.argv[3]).read_text())
bubble_tool = Path(sys.argv[4]).read_text()
bubble_text = Path(sys.argv[5]).read_text()
headers = composer["fullConversationHeadersOnly"]
bid_text = headers[0]["bubbleId"]
bid_tool = headers[1]["bubbleId"] if len(headers) > 1 else bid_text
conn = sqlite3.connect(db)
conn.execute("CREATE TABLE cursorDiskKV (key TEXT PRIMARY KEY, value BLOB);")
conn.execute("INSERT INTO cursorDiskKV VALUES (?, ?);", (f"composerData:{cid}", json.dumps(composer, separators=(",", ":")).encode()))
conn.execute("INSERT INTO cursorDiskKV VALUES (?, ?);", (f"bubbleId:{cid}:{bid_text}", bubble_text.encode()))
conn.execute("INSERT INTO cursorDiskKV VALUES (?, ?);", (f"bubbleId:{cid}:{bid_tool}", bubble_tool.encode()))
conn.commit()
conn.close()
`;
    await execFileAsync("python3", ["-c", py, CID, dbPath, composerPath, bubbleToolPath, bubbleTextPath]);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("exports composerData and bubble rows with tool bubble count", async () => {
    const snap = await exportDiskKvSnapshot(dbPath, CID);
    expect(snap).not.toBeNull();
    expect(snap!.rowCount).toBe(3);
    expect(snap!.toolBubbleCount).toBeGreaterThanOrEqual(1);
    const keys = new Set(snap!.rows.map((r) => r.key));
    expect(keys.has(`composerData:${CID}`)).toBe(true);
    expect([...keys].some((k) => k.startsWith(`bubbleId:${CID}:`))).toBe(true);
  });

  it("returns null when conversation has no rows", async () => {
    const snap = await exportDiskKvSnapshot(dbPath, "00000000-0000-0000-0000-000000000000");
    expect(snap).toBeNull();
  });
});
