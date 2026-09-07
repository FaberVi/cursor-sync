import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  DEFAULT_EXCLUDE_JSON_KEYS,
  readExcludeJsonKeys,
  restoreExcludedJsonKeys,
  stripExcludedJsonKeys,
} from "../src/json-key-filter.js";

const KEY = "python.defaultInterpreterPath";

function pretty(obj: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify(obj, null, 4), "utf8");
}

describe("json-key-filter", () => {
  it("defaults excludeJsonKeys to python.defaultInterpreterPath", () => {
    expect(DEFAULT_EXCLUDE_JSON_KEYS).toEqual([KEY]);
    expect(readExcludeJsonKeys()).toEqual([KEY]);
  });

  it("strips only listed own keys and keeps remaining order", () => {
    const input = pretty({
      "git.autofetch": true,
      [KEY]: "c:\\\\Users\\\\Vincenzo\\\\python.exe",
      "cursorSync.ui.language": "it",
    });
    const stripped = JSON.parse(stripExcludedJsonKeys(input, [KEY]).toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(stripped).toEqual({
      "git.autofetch": true,
      "cursorSync.ui.language": "it",
    });
    expect(Object.keys(stripped)).toEqual(["git.autofetch", "cursorSync.ui.language"]);
  });

  it("returns the original buffer when listed keys are absent, JSON is invalid, or the value is an array", () => {
    const noKey = pretty({ "git.autofetch": true });
    const jsonc = Buffer.from('{"a": 1, // comment\n"b": 2}', "utf8");
    const arrayBuf = Buffer.from('["python.defaultInterpreterPath"]', "utf8");
    expect(stripExcludedJsonKeys(noKey, [KEY])).toBe(noKey);
    expect(stripExcludedJsonKeys(jsonc, [KEY])).toBe(jsonc);
    expect(stripExcludedJsonKeys(arrayBuf, [KEY])).toBe(arrayBuf);
    expect(stripExcludedJsonKeys(noKey, [])).toBe(noKey);
  });

  it("restore copies listed keys from local onto stripped remote", () => {
    const remote = pretty({
      "git.autofetch": true,
      [KEY]: "c:\\\\Users\\\\Vincenzo\\\\python.exe",
      theme: "dark",
    });
    const local = pretty({
      "git.autofetch": false,
      [KEY]: "c:\\\\Users\\\\Utente\\\\python.exe",
    });
    const restored = JSON.parse(
      restoreExcludedJsonKeys(remote, local, [KEY]).toString("utf8")
    ) as Record<string, unknown>;
    expect(restored[KEY]).toBe("c:\\\\Users\\\\Utente\\\\python.exe");
    expect(restored.theme).toBe("dark");
    expect(restored["git.autofetch"]).toBe(true);
  });

  it("restore omits excluded keys when local is empty or not a JSON object", () => {
    const remote = pretty({
      theme: "dark",
      [KEY]: "c:\\\\Users\\\\Vincenzo\\\\python.exe",
    });
    const stripped = JSON.parse(
      restoreExcludedJsonKeys(remote, Buffer.alloc(0), [KEY]).toString("utf8")
    ) as Record<string, unknown>;
    expect(stripped).toEqual({ theme: "dark" });

    const invalidLocal = restoreExcludedJsonKeys(
      remote,
      Buffer.from("{not json", "utf8"),
      [KEY]
    );
    expect(JSON.parse(invalidLocal.toString("utf8"))).toEqual({ theme: "dark" });
  });
});
