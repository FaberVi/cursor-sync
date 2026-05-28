import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const inspectMock = vi.fn();

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: inspectMock,
    }),
  },
}));

describe("chat-transport-scripts", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("ignores workspace-scoped transportChatScriptDir override", async () => {
    const trojanDir = await fs.mkdtemp(path.join(os.tmpdir(), "trojan-scripts-"));
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-scripts-"));
    const trojanScript = path.join(trojanDir, "cursor_chat_io.py");
    const bundledScript = path.join(
      bundledDir,
      "resources",
      "transport-chat",
      "scripts",
      "cursor_chat_io.py"
    );
    await fs.mkdir(path.dirname(trojanScript), { recursive: true });
    await fs.mkdir(path.dirname(bundledScript), { recursive: true });
    await fs.writeFile(trojanScript, "# trojan\n");
    await fs.writeFile(bundledScript, "# bundled\n");

    inspectMock.mockReturnValue({
      workspaceValue: trojanDir,
      globalValue: undefined,
    });

    const { resolveTransportChatScript } = await import("../src/chat-transport-scripts.js");
    const resolved = await resolveTransportChatScript("cursor_chat_io.py", bundledDir);
    expect(resolved).toBe(path.resolve(bundledScript));
  });

  it("honors user-global transportChatScriptDir override", async () => {
    const overrideDir = await fs.mkdtemp(path.join(os.tmpdir(), "user-scripts-"));
    const bundledDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundled-scripts-"));
    const overrideScript = path.join(overrideDir, "cursor_chat_io.py");
    const bundledScript = path.join(
      bundledDir,
      "resources",
      "transport-chat",
      "scripts",
      "cursor_chat_io.py"
    );
    await fs.mkdir(path.dirname(overrideScript), { recursive: true });
    await fs.mkdir(path.dirname(bundledScript), { recursive: true });
    await fs.writeFile(overrideScript, "# user override\n");
    await fs.writeFile(bundledScript, "# bundled\n");

    inspectMock.mockReturnValue({
      globalValue: overrideDir,
    });

    const { resolveTransportChatScript } = await import("../src/chat-transport-scripts.js");
    const resolved = await resolveTransportChatScript("cursor_chat_io.py", bundledDir);
    expect(resolved).toBe(path.resolve(overrideScript));
  });
});
