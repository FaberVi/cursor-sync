import { describe, expect, it } from "vitest";
import { formatElapsedMs, formatElapsedPrecise } from "../src/elapsed.js";

describe("formatElapsedMs", () => {
  it("formats seconds under a minute", () => {
    expect(formatElapsedMs(0)).toBe("0s");
    expect(formatElapsedMs(999)).toBe("0s");
    expect(formatElapsedMs(12_000)).toBe("12s");
    expect(formatElapsedMs(59_999)).toBe("59s");
  });

  it("formats minutes with zero-padded seconds", () => {
    expect(formatElapsedMs(60_000)).toBe("1m 00s");
    expect(formatElapsedMs(68_000)).toBe("1m 08s");
    expect(formatElapsedMs(125_000)).toBe("2m 05s");
  });
});

describe("formatElapsedPrecise", () => {
  it("formats fractional seconds under a minute", () => {
    expect(formatElapsedPrecise(800)).toBe("0.8s");
    expect(formatElapsedPrecise(12_400)).toBe("12.4s");
  });

  it("formats minutes with fractional seconds", () => {
    expect(formatElapsedPrecise(68_000)).toBe("1m 8.0s");
  });
});
