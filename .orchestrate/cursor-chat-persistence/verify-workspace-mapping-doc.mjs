import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { validateWorkspaceKeysForImport, listWorkspaceKeysUnderChatsRoot } from "../../src/chat-id-sync.ts";

async function main() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ws-verify-"));
  const chatsRoot = path.join(tmp, ".cursor", "chats");

  const origHome = process.env.HOME;
  process.env.HOME = tmp;
  try {
    const emptyList = await listWorkspaceKeysUnderChatsRoot();
    const warnOnly = await validateWorkspaceKeysForImport(["any-key"]);
    console.log("empty chats root:", { emptyList, warnOnly });

    await fs.mkdir(path.join(chatsRoot, "existing-key"), { recursive: true });
    const listed = await listWorkspaceKeysUnderChatsRoot();
    console.log("listWorkspaceKeysUnderChatsRoot:", listed);

    const fail = await validateWorkspaceKeysForImport(["missing"]);
    console.log("validate (missing key):", fail);

    const ok = await validateWorkspaceKeysForImport(["existing-key"]);
    console.log("validate (existing key):", ok);

    if (emptyList.length !== 0) process.exitCode = 1;
    if (!warnOnly.ok || !warnOnly.message?.includes("No workspace folders")) process.exitCode = 1;
    if (listed.length !== 1 || listed[0] !== "existing-key") process.exitCode = 1;
    if (fail.ok) process.exitCode = 1;
    if (!ok.ok) process.exitCode = 1;
  } finally {
    process.env.HOME = origHome;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
