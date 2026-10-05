import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
import * as os from "node:os";
import * as path from "node:path";
import {
  isHostIdeProcess,
  isPathLockError,
  isSafeLockReleaseTarget,
  RESTART_MANAGER_CRITICAL_APP,
  selectStoppableLockers,
} from "../src/path-lock-recovery.js";

describe("path-lock-recovery", () => {
  it("detects EBUSY and locked message", () => {
    expect(isPathLockError(Object.assign(new Error("x"), { code: "EBUSY" }))).toBe(true);
    expect(isPathLockError(new Error("resource busy or locked, rmdir"))).toBe(true);
    expect(isPathLockError(new Error("ENOENT"))).toBe(false);
  });

  it("closes external lockers and keeps Cursor, VS Code, session processes, and this process", () => {
    const selected = selectStoppableLockers(
      [
        { pid: 10, name: "Cursor", path: "C:\\Program Files\\Cursor\\Cursor.exe" },
        { pid: 11, name: "Code", path: "C:\\Program Files\\Microsoft VS Code\\Code.exe" },
        { pid: 12, name: "SearchIndexer", path: "C:\\Windows\\System32\\SearchIndexer.exe" },
        { pid: 13, name: "notepad", path: "C:\\Windows\\System32\\notepad.exe" },
        { pid: 13, name: "notepad", path: "C:\\Windows\\System32\\notepad.exe" },
        { pid: 15, name: "cursor-agent", path: "C:\\Tools\\cursor-agent.exe" },
        { pid: 16, name: "Service Host", path: "C:\\Windows\\System32\\svchost.exe" },
        { pid: 14, name: "helper", path: "C:\\Tools\\helper.exe", appType: RESTART_MANAGER_CRITICAL_APP },
        { pid: 4, name: "System", path: "" },
      ],
      [11]
    );
    expect(selected.map((proc) => proc.pid)).toEqual([12, 13, 15]);
  });

  it("matches only the Cursor and VS Code executables", () => {
    expect(isHostIdeProcess("Cursor", "C:\\Program Files\\Cursor\\Cursor.exe")).toBe(true);
    expect(isHostIdeProcess("cursor-agent", "C:\\Tools\\cursor-agent.exe")).toBe(false);
    expect(isHostIdeProcess("powershell", "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(
      false
    );
  });

  it("rejects a drive root and the user profile as lock-release targets", () => {
    expect(isSafeLockReleaseTarget("C:\\")).toBe(false);
    expect(isSafeLockReleaseTarget(os.homedir())).toBe(false);
    expect(isSafeLockReleaseTarget(path.join(os.tmpdir(), "cursor-sync-lock", "skill"))).toBe(true);
  });
});
