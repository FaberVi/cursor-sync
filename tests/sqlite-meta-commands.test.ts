import { describe, it, expect } from "vitest";
import { assertNoSqliteMetaCommands } from "../src/transcripts-sqlite.js";

describe("assertNoSqliteMetaCommands", () => {
  it("allows normal SQL", () => {
    expect(() =>
      assertNoSqliteMetaCommands("INSERT INTO t(a) VALUES (1);\nSELECT 1;")
    ).not.toThrow();
  });

  it("rejects sqlite3 CLI meta-commands including .shell", () => {
    expect(() => assertNoSqliteMetaCommands(".shell whoami\n")).toThrow(
      /meta-command/i
    );
    expect(() => assertNoSqliteMetaCommands("SELECT 1;\n.system id\n")).toThrow(
      /meta-command/i
    );
  });
});
