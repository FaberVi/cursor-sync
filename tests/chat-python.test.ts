import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const inspectMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());
const resolveSqlitePythonMock = vi.hoisted(() =>
  vi.fn(async () => ({ command: "py", argvPrefix: ["-3"] as const }))
);
const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("vscode", () => ({
  workspace: {
    getConfiguration: () => ({
      inspect: inspectMock,
    }),
  },
}));

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
  execFile: (
    command: string,
    args: string[],
    _opts: unknown,
    cb?: (err: Error | null, stdout: string, stderr: string) => void
  ) => {
    const result = execFileMock(command, args);
    const done = (err: Error | null, stdout = "", stderr = "") => {
      if (typeof cb === "function") {
        cb(err, stdout, stderr);
      }
    };
    Promise.resolve(result)
      .then(() => done(null, "", ""))
      .catch((err: Error) => done(err));
    return {};
  },
}));

vi.mock("../src/transcripts-sqlite.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/transcripts-sqlite.js")>();
  return {
    ...actual,
    resolvePythonInterpreterForSqlite: resolveSqlitePythonMock,
  };
});

function mockSpawnExit(code: number): void {
  spawnMock.mockImplementation((_cmd: string, _args: string[]) => {
    const proc = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    queueMicrotask(() => proc.emit("close", code));
    return proc;
  });
}

describe("chat-python", () => {
  afterEach(() => {
    vi.clearAllMocks();
    inspectMock.mockReset();
    execFileMock.mockReset();
    resolveSqlitePythonMock.mockResolvedValue({ command: "py", argvPrefix: ["-3"] });
  });

  it("ignores workspace-scoped pythonPath and uses auto-detect", async () => {
    inspectMock.mockReturnValue({
      workspaceValue: "/evil/python",
      globalValue: undefined,
    });
    mockSpawnExit(0);

    const { runPythonProcess } = await import("../src/chat-python.js");
    await runPythonProcess(["script.py"]);

    expect(resolveSqlitePythonMock).toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith("py", ["-3", "script.py"], expect.any(Object));
  });

  it("honors user-global pythonPath when the interpreter probes ok", async () => {
    inspectMock.mockReturnValue({
      globalValue: "C:\\Python\\python.exe",
    });
    execFileMock.mockResolvedValue(undefined);
    mockSpawnExit(0);

    const { runPythonProcess } = await import("../src/chat-python.js");
    await runPythonProcess(["script.py"]);

    expect(resolveSqlitePythonMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledWith(
      "C:\\Python\\python.exe",
      ["script.py"],
      expect.any(Object)
    );
  });

  it("adds -3 when global pythonPath is the py launcher", async () => {
    inspectMock.mockReturnValue({ globalValue: "py" });
    execFileMock.mockResolvedValue(undefined);
    mockSpawnExit(0);

    const { runPythonProcess } = await import("../src/chat-python.js");
    await runPythonProcess(["-c", "print(1)"]);

    expect(spawnMock).toHaveBeenCalledWith("py", ["-3", "-c", "print(1)"], expect.any(Object));
  });
});
