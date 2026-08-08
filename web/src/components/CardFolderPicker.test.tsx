// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addCreatedFolder,
  getCreatedFolders,
  getUserTags,
  resetCreatedFoldersForTests,
  resetKnownTagsForTests,
  resetUserTagsForTests,
  setKnownTags,
  setUserTags,
} from "../lib/tags";
import { CardFolderPicker } from "./CardFolderPicker";

function setInputValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("CardFolderPicker", () => {
  let host: HTMLDivElement;
  let root: Root;

  const render = async () => {
    await act(async () => root.render(<CardFolderPicker episodeId="ep_1" />));
  };

  const folderOptions = () =>
    [...document.querySelectorAll<HTMLButtonElement>('[role="menuitemcheckbox"]')].map((button) => ({
      name: button.querySelector("span")?.textContent,
      selected: button.getAttribute("aria-checked") === "true",
    }));

  const option = (name: string) =>
    document.querySelector(`[aria-label="folder-${name}"]`) as HTMLButtonElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetCreatedFoldersForTests();
    vi.restoreAllMocks();
  });

  it("lists every existing folder straight away, checking the ones this memory is in", async () => {
    setKnownTags(["archive", "work"]);
    addCreatedFolder("someday");
    setUserTags({ ep_1: ["work"], ep_2: ["travel"] });
    await render();

    // No hover, no chip row — the list IS the picker.
    expect(folderOptions()).toEqual([
      { name: "archive", selected: false },
      { name: "someday", selected: false },
      { name: "travel", selected: false },
      { name: "work", selected: true },
    ]);
    expect(document.querySelector(".card-folder-create")?.textContent).toContain("New folder");
  });

  it("files and unfiles the memory as rows are checked and unchecked", async () => {
    setKnownTags(["archive", "work"]);
    setUserTags({ ep_1: ["work"] });
    await render();

    await act(async () => option("archive").click());
    expect(getUserTags()).toEqual({ ep_1: ["work", "archive"] });

    await act(async () => option("work").click());
    expect(getUserTags()).toEqual({ ep_1: ["archive"] });
    expect(folderOptions().find((folder) => folder.name === "archive")?.selected).toBe(true);
    expect(folderOptions().find((folder) => folder.name === "work")?.selected).toBe(false);
  });

  it("creates, sanitizes, persists, and files a new folder in one step", async () => {
    await render();
    expect(document.querySelector(".card-folder-empty")?.textContent).toBe("No folders yet");
    await act(async () => (document.querySelector(".card-folder-create") as HTMLButtonElement).click());
    const input = document.querySelector('[aria-label="new-folder-input-ep_1"]') as HTMLInputElement;
    await act(async () => setInputValue(input, "New/List"));
    expect(input.value).toBe("NewList");
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(getCreatedFolders()).toEqual(["newlist"]);
    expect(getUserTags()).toEqual({ ep_1: ["NewList"] });
    expect(folderOptions()).toContainEqual({ name: "newlist", selected: true });

    // Unchecking it again leaves the folder listed and empty — creating a folder is not undone
    // by unfiling the card that happened to be in it.
    await act(async () => option("newlist").click());
    expect(getUserTags()).toEqual({});
    expect(getCreatedFolders()).toEqual(["newlist"]);
    expect(folderOptions()).toEqual([{ name: "newlist", selected: false }]);
  });

  it("reacts to folders created elsewhere while the picker is open", async () => {
    setKnownTags(["alpha"]);
    await render();
    expect(folderOptions().map((folder) => folder.name)).toEqual(["alpha"]);

    await act(async () => addCreatedFolder("later"));
    expect(folderOptions().map((folder) => folder.name)).toEqual(["alpha", "later"]);

    await act(async () => setKnownTags(["alpha", "shared"]));
    expect(folderOptions().map((folder) => folder.name)).toEqual(["alpha", "later", "shared"]);
  });
});
