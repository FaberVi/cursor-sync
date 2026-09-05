import { describe, expect, it } from "vitest";
import { decideSyncAction } from "../src/sync-action.js";

describe("decideSyncAction", () => {
  it("errors when clone and origin have diverged", () => {
    expect(
      decideSyncAction({
        relation: "diverged",
        cursorDiffers: false,
        completedFileSync: true,
        hasNestedRemoteFiles: true,
      })
    ).toEqual({ action: "error", reason: "diverged" });
  });

  it("pulls when origin is ahead", () => {
    expect(
      decideSyncAction({
        relation: "behind",
        cursorDiffers: false,
        completedFileSync: true,
        hasNestedRemoteFiles: true,
      })
    ).toEqual({ action: "pull" });
  });

  it("pushes when the clone is ahead or the remote is empty", () => {
    expect(
      decideSyncAction({
        relation: "ahead",
        cursorDiffers: false,
        completedFileSync: true,
        hasNestedRemoteFiles: false,
      })
    ).toEqual({ action: "push" });
    expect(
      decideSyncAction({
        relation: "empty",
        cursorDiffers: true,
        completedFileSync: false,
        hasNestedRemoteFiles: false,
      })
    ).toEqual({ action: "push" });
  });

  it("does nothing when equal and Cursor matches the clone", () => {
    expect(
      decideSyncAction({
        relation: "equal",
        cursorDiffers: false,
        completedFileSync: true,
        hasNestedRemoteFiles: true,
      })
    ).toEqual({ action: "none" });
  });

  it("pulls when never synced and nested clone files already exist", () => {
    expect(
      decideSyncAction({
        relation: "equal",
        cursorDiffers: true,
        completedFileSync: false,
        hasNestedRemoteFiles: true,
      })
    ).toEqual({ action: "pull" });
  });

  it("pushes when never synced and the clone has no nested files", () => {
    expect(
      decideSyncAction({
        relation: "equal",
        cursorDiffers: true,
        completedFileSync: false,
        hasNestedRemoteFiles: false,
      })
    ).toEqual({ action: "push" });
  });

  it("pushes when already synced and Cursor differs from the clone", () => {
    expect(
      decideSyncAction({
        relation: "equal",
        cursorDiffers: true,
        completedFileSync: true,
        hasNestedRemoteFiles: true,
      })
    ).toEqual({ action: "push" });
  });
});
