import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));
import { isPathLockError } from "../src/path-lock-recovery.js";

describe("path-lock-recovery", () => {
  it("detects EBUSY and locked message", () => {
    expect(isPathLockError(Object.assign(new Error("x"), { code: "EBUSY" }))).toBe(true);
    expect(isPathLockError(new Error("resource busy or locked, rmdir"))).toBe(true);
    expect(isPathLockError(new Error("ENOENT"))).toBe(false);
  });
});
