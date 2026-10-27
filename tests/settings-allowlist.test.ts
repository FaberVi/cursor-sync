import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("vscode", () => import("./__mocks__/vscode.js"));

import {
  updateSettingValue,
  SIDEBAR_SETTING_KEYS,
} from "../src/sidebar/settings-tab.js";

describe("updateSettingValue allowlist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects keys outside the sidebar allowlist", async () => {
    await expect(
      updateSettingValue("chatGist.encrypt", true)
    ).rejects.toThrow(/not allowed/i);
    await expect(
      updateSettingValue("syncExtensions.autoInstall", false)
    ).rejects.toThrow(/not allowed/i);
  });

  it("rejects wrong value types for allowlisted keys", async () => {
    await expect(updateSettingValue("schedule.enabled", "yes")).rejects.toThrow(
      /boolean/i
    );
    await expect(updateSettingValue("ui.language", "de")).rejects.toThrow(/en or it/i);
  });

  it("accepts allowlisted keys with valid values", async () => {
    await expect(updateSettingValue("schedule.enabled", true)).resolves.toBeUndefined();
    await expect(updateSettingValue("ui.language", "it")).resolves.toBeUndefined();
    expect(SIDEBAR_SETTING_KEYS).toContain("chatImport.pythonPath");
    expect(SIDEBAR_SETTING_KEYS).toContain("mcp.syncEnabled");
    await expect(updateSettingValue("mcp.syncEnabled", true)).resolves.toBeUndefined();
    await expect(
      updateSettingValue("chatImport.pythonPath", "/evil/python")
    ).resolves.toBeUndefined();
  });
});
