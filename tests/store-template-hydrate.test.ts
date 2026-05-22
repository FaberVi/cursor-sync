import { describe, it, expect, beforeAll } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, "..");
const templatePath = path.join(repoRoot, "resources", "golden-chat-store.template.db");

describe("store-template-hydrate", () => {
  let canRun: boolean;

  beforeAll(async () => {
    try {
      await fs.access(templatePath);
      canRun = true;
    } catch {
      canRun = false;
    }
  });

  it("hydrates template with content-addressed message blobs and a tree root", async () => {
    if (!canRun) {
      return;
    }
    const { hydrateGoldenStoreTemplate, readTemplateUserVersion, GOLDEN_STORE_TEMPLATE_VERSION } =
      await import("../src/store-template-hydrate.js");
    const { __chatPersistenceInternals } = await import("../src/transcripts.js");
    const { querySqliteRows } = __chatPersistenceInternals;

    const outDir = path.join(os.tmpdir(), `cursor-sync-hydrate-${Date.now()}`);
    const outPath = path.join(outDir, "store.db");
    await fs.mkdir(outDir, { recursive: true });

    const chatId = "b9283093-88f1-47e6-b140-3aad0db9138d";
    await hydrateGoldenStoreTemplate({
      templatePath,
      outputPath: outPath,
      chat: {
        chat_id: chatId,
        title: "Test title",
        content: [
          { role: "user", content: "one" },
          { role: "assistant", content: "two" },
        ],
        timestamp: 1712345678000,
      },
    });

    const ver = await readTemplateUserVersion(outPath);
    expect(ver).toBe(GOLDEN_STORE_TEMPLATE_VERSION);

    const metaRows = await querySqliteRows(
      outPath,
      "SELECT value AS v FROM meta WHERE key = '0' LIMIT 1;"
    );
    const metaText = String(metaRows[0]?.v ?? "");
    const meta = JSON.parse(metaText) as {
      agentId: string;
      latestRootBlobId: string;
      name: string;
      mode: string;
      isRunEverything: boolean;
      createdAt: number;
    };
    expect(meta.agentId).toBe(chatId);
    expect(meta.name).toBe("Test title");
    expect(meta.mode).toBe("default");
    expect(meta.isRunEverything).toBe(true);
    expect(meta.createdAt).toBe(1712345678000);
    expect(meta.latestRootBlobId).toMatch(/^[0-9a-f]{64}$/);

    const blobsCount = await querySqliteRows(outPath, "SELECT COUNT(*) AS n FROM blobs;");
    expect(Number(blobsCount[0]?.n ?? 0)).toBe(3);

    const userPayload = Buffer.from(
      JSON.stringify({ role: "user", content: [{ type: "text", text: "one" }] }),
      "utf-8"
    );
    const assistantPayload = Buffer.from(
      JSON.stringify({ role: "assistant", content: [{ type: "text", text: "two" }] }),
      "utf-8"
    );
    const userHash = crypto.createHash("sha256").update(userPayload).digest("hex");
    const assistantHash = crypto.createHash("sha256").update(assistantPayload).digest("hex");
    const treeBytes = Buffer.concat([
      Buffer.from([0x0a, 0x20]),
      Buffer.from(userHash, "hex"),
      Buffer.from([0x0a, 0x20]),
      Buffer.from(assistantHash, "hex"),
      Buffer.from([0x2a, 0x00]),
    ]);
    const treeHash = crypto.createHash("sha256").update(treeBytes).digest("hex");
    expect(meta.latestRootBlobId).toBe(treeHash);

    const userBlob = await querySqliteRows(
      outPath,
      `SELECT CAST(data AS TEXT) AS v FROM blobs WHERE id = '${userHash}' LIMIT 1;`
    );
    expect(String(userBlob[0]?.v ?? "")).toBe(userPayload.toString("utf-8"));

    const assistantBlob = await querySqliteRows(
      outPath,
      `SELECT CAST(data AS TEXT) AS v FROM blobs WHERE id = '${assistantHash}' LIMIT 1;`
    );
    expect(String(assistantBlob[0]?.v ?? "")).toBe(assistantPayload.toString("utf-8"));

    const treeBlob = await querySqliteRows(
      outPath,
      `SELECT hex(data) AS h FROM blobs WHERE id = '${treeHash}' LIMIT 1;`
    );
    expect(String(treeBlob[0]?.h ?? "").toLowerCase()).toBe(treeBytes.toString("hex"));

    await fs.rm(outDir, { recursive: true, force: true });
  });
});
