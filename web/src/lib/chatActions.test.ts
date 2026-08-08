// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyAskAppAction, recordAskMemoryFiling, resetChatActionUndoForTests } from "./chatActions";
import { getPins, resetPinsForTests, setPins } from "./pins";
import {
  getCreatedFolders,
  getHiddenFolders,
  getUserTags,
  resetCreatedFoldersForTests,
  resetHiddenFoldersForTests,
  resetUserTagsForTests,
  setCreatedFolders,
  setFolderHidden,
  setUserTags,
} from "./tags";

describe("popup chat app actions", () => {
  const applyFilter = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    resetHiddenFoldersForTests();
    resetPinsForTests();
    resetChatActionUndoForTests();
    applyFilter.mockReset();
  });

  it("files, moves, unfiles, and undoes entry folder changes", () => {
    expect(applyAskAppAction(
      { kind: "entry-file", id: "ep_1", folder: "Projects" },
      { applyFilter },
    )).toMatchObject({ ok: true, changed: true });
    expect(getUserTags()).toEqual({ ep_1: ["projects"] });

    expect(applyAskAppAction(
      { kind: "entry-move", id: "ep_1", fromFolder: "projects", toFolder: "Archive" },
      { applyFilter },
    )).toMatchObject({ ok: true, changed: true });
    expect(getUserTags()).toEqual({ ep_1: ["archive"] });

    expect(applyAskAppAction({ kind: "undo" }, { applyFilter })).toMatchObject({ ok: true });
    expect(getUserTags()).toEqual({ ep_1: ["projects"] });

    expect(applyAskAppAction(
      { kind: "entry-unfile", id: "ep_1", folder: "projects" },
      { applyFilter },
    )).toMatchObject({ ok: true, changed: true });
    expect(getUserTags()).toEqual({});
  });

  it("pins and unpins entries with one-step undo", () => {
    setPins([]);
    expect(applyAskAppAction({ kind: "pin", id: "ep_1" }, { applyFilter }))
      .toMatchObject({ ok: true, changed: true });
    expect(getPins()).toEqual(["ep_1"]);
    expect(applyAskAppAction({ kind: "pin", id: "ep_1" }, { applyFilter }))
      .toMatchObject({ ok: true, changed: false });

    expect(applyAskAppAction({ kind: "unpin", id: "ep_1" }, { applyFilter }))
      .toMatchObject({ ok: true, changed: true });
    expect(getPins()).toEqual([]);
    applyAskAppAction({ kind: "undo" }, { applyFilter });
    expect(getPins()).toEqual(["ep_1"]);
  });

  it("opens folders and applies search filters without consuming undo", () => {
    setCreatedFolders(["project-ideas"]);
    setUserTags({});
    expect(applyAskAppAction({ kind: "open-folder", name: "project ideas" }, { applyFilter }))
      .toMatchObject({ ok: true, changed: false });
    expect(applyFilter).toHaveBeenLastCalledWith("/project-ideas");

    expect(applyAskAppAction({ kind: "apply-filter", query: "meeting /work" }, { applyFilter }))
      .toMatchObject({ ok: true, changed: false });
    expect(applyFilter).toHaveBeenLastCalledWith("meeting /work");
    expect(applyAskAppAction({ kind: "open-folder", name: "missing" }, { applyFilter }).ok).toBe(false);
  });

  it("undoes the local filing created with a popup memory", () => {
    recordAskMemoryFiling("ask:spool-1", "chat-summary");
    expect(getCreatedFolders()).toEqual(["chat-summary"]);
    expect(getUserTags()).toEqual({ "ask:spool-1": ["chat-summary"] });

    expect(applyAskAppAction({ kind: "undo" }, { applyFilter })).toMatchObject({ ok: true });
    expect(getCreatedFolders()).toEqual([]);
    expect(getUserTags()).toEqual({});
  });

  it("hides the chat-summary folder on its first filing, and only then", () => {
    recordAskMemoryFiling("ask:spool-1", "chat-summary");
    expect(getHiddenFolders()).toEqual(["chat-summary"]);

    // The user unhid it: a later summary must not re-hide the folder they opened up.
    setFolderHidden("chat-summary", false);
    recordAskMemoryFiling("ask:spool-2", "chat-summary");
    expect(getHiddenFolders()).toEqual([]);
  });

  it("never hides an ordinary popup filing's folder", () => {
    recordAskMemoryFiling("ask:spool-1", "groceries");
    expect(getHiddenFolders()).toEqual([]);
  });
});
