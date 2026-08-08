// @vitest-environment jsdom
/**
 * Omnibar filing indicator: when the composer draft (not search) contains `/tags`, a small
 * non-interactive note above the bar confirms which spot(s) the note will file to. The note is
 * the only filing signal — the send button is unchanged. The note yields to the `/` suggestion menu
 * (same anchor position) and never appears in search mode, where /tokens are filters.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getUserTags,
  resetKnownTagsForTests,
  resetPendingFilingsForTests,
  resetUserTagsForTests,
  setKnownTags,
} from "../lib/tags";
import { InputPage } from "./InputPage";

const EPISODE_STATUS_KEY = "graph.write.episode-status.v1";

function composer(): HTMLTextAreaElement {
  return document.querySelector('textarea[aria-label="Add anything"]') as HTMLTextAreaElement;
}

async function typeComposer(value: string) {
  await act(async () => {
    const element = composer();
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** Paste into the composer: fire the paste event (which records the pasted tags), then apply
 *  the resulting value like the browser would. */
async function pasteComposer(pasted: string, nextValue: string) {
  await act(async () => {
    const element = composer();
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", {
      value: { getData: () => pasted, files: { length: 0 } },
    });
    element.dispatchEvent(event);
  });
  await typeComposer(nextValue);
}

const fileNote = () => document.querySelector(".omnibar-file-note");
const sendButton = () => document.querySelector(".write-send.omnibar-send") as HTMLButtonElement;

async function submitComposer() {
  await act(async () => {
    sendButton().click();
  });
}

function persistEpisodeRecords(entries: Array<{ id: string; text: string }>) {
  localStorage.setItem(
    EPISODE_STATUS_KEY,
    JSON.stringify(entries.map(({ id, text }) => ({ id, text }))),
  );
}

describe("InputPage omnibar filing indicator", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    sessionStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetPendingFilingsForTests();
    setKnownTags(["bio", "biology", "trip"]);
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        writeAttachmentsGet: vi.fn().mockResolvedValue({ attachments: [] }),
        writeAttachmentsSync: vi.fn().mockResolvedValue({ attachments: [] }),
      },
    });
    await act(async () => {
      root.render(
        <InputPage
          focusToken={0}
          composerOnly
          onPendingEntriesChange={persistEpisodeRecords}
        />,
      );
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    sessionStorage.clear();
    resetKnownTagsForTests();
    resetUserTagsForTests();
    resetPendingFilingsForTests();
    vi.restoreAllMocks();
  });

  it("a hashtagged draft shows the note; the send button is left unchanged", async () => {
    await typeComposer("/bio problem set");
    expect(fileNote()?.textContent).toBe("files to bio");
    expect(fileNote()?.getAttribute("aria-live")).toBe("polite");
    // The note is the only filing signal — the send button keeps its normal look and labels.
    expect(sendButton().classList.contains("filing")).toBe(false);
    expect(sendButton().getAttribute("aria-label")).toBe("Add entry");
    expect(sendButton().hasAttribute("title")).toBe(false);
  });

  it("pre-fills a normalized active folder and leaves a trailing space for note text", async () => {
    await act(async () => {
      root.render(
        <InputPage
          focusToken={0}
          composerOnly
          activeFolder="reading-list"
          onPendingEntriesChange={persistEpisodeRecords}
        />,
      );
    });

    expect(composer().value).toBe("/reading-list ");
    await typeComposer("/reading-list project update");
    expect(fileNote()?.textContent).toBe("files to reading-list");
  });

  it("several tags join with a comma in first-mention order", async () => {
    await typeComposer("/bio notes from the /trip today");
    expect(fileNote()?.textContent).toBe("files to bio, trip");
  });

  it("plain text shows no note and keeps the normal send labels", async () => {
    await typeComposer("problem set due friday");
    expect(fileNote()).toBeNull();
    expect(sendButton().classList.contains("filing")).toBe(false);
    expect(sendButton().getAttribute("aria-label")).toBe("Add entry");
  });

  it("hides while the / suggestion menu is open; returns when the token finishes", async () => {
    await typeComposer("/bi"); // trailing partial → the suggestion menu owns the anchor
    expect(document.querySelector(".tag-command-menu")).not.toBeNull();
    expect(fileNote()).toBeNull();

    await typeComposer("/bio problem set"); // token finished → menu closed, note back
    expect(document.querySelector(".tag-command-menu")).toBeNull();
    expect(fileNote()?.textContent).toBe("files to bio");
  });

  it("a tags-only draft can't send — spots are commands, not content", async () => {
    await typeComposer("/bio "); // trailing space ends the token (else the / menu owns the anchor)
    expect(fileNote()?.textContent).toBe("files to bio"); // intent shows, but…
    expect(sendButton().disabled).toBe(true); // …an empty card would be pure noise
    await typeComposer("/bio /trip  ");
    expect(sendButton().disabled).toBe(true);
    await typeComposer("/bio problem set");
    expect(sendButton().disabled).toBe(false);
  });

  it("a pasted / is text, not a filing command — no note; typed tags still file", async () => {
    // Paste a snippet containing "/bio": the tag is recorded as pasted, so no filing note.
    await pasteComposer("check out /bio notes", "check out /bio notes");
    expect(fileNote()).toBeNull();
    // TYPING another tag alongside it files only the typed one.
    await typeComposer("check out /bio notes /trip");
    expect(fileNote()?.textContent).toBe("files to trip");
  });

  it("a multi-paragraph draft submits as ONE card, and that card gets the filing", async () => {
    // One submit is one thought: blank lines inside a draft never split it into several
    // records (line breaks stay draft-encoded through the submit boundary).
    await typeComposer("para one\n\npara two /bio");
    await submitComposer();

    const records = JSON.parse(localStorage.getItem(EPISODE_STATUS_KEY) ?? "[]") as Array<{
      id: string;
      text: string;
    }>;
    const noteRecords = records.filter((record) => record.text.includes("para"));
    expect(noteRecords).toHaveLength(1);
    expect(noteRecords[0]?.text).toBe("para one\n\npara two /bio"); // raw keeps real newlines + the command
    expect(getUserTags()[noteRecords[0]?.id as string]).toContain("bio");
  });

  it("a filing never lands on the wrong submit — records file from their OWN text", async () => {
    // An untagged submit followed quickly by a tagged one: the first record must not consume
    // the second's filing (the old FIFO pairing could misalign these).
    await typeComposer("plain untagged note");
    await submitComposer();
    await typeComposer("tagged note /bio");
    await submitComposer();

    const records = JSON.parse(localStorage.getItem(EPISODE_STATUS_KEY) ?? "[]") as Array<{
      id: string;
      text: string;
    }>;
    const plainId = records.find((record) => record.text === "plain untagged note")?.id;
    const taggedId = records.find((record) => record.text === "tagged note /bio")?.id;
    expect(plainId).toBeDefined();
    expect(taggedId).toBeDefined();
    expect(getUserTags()[taggedId as string]).toContain("bio");
    expect(getUserTags()[plainId as string] ?? []).not.toContain("bio");
  });

  it("forgets pasted tags when an abandoned draft is cleared", async () => {
    await pasteComposer("/bio", "/bio");
    expect(fileNote()).toBeNull();

    await typeComposer("");
    await typeComposer("/bio x");

    expect(fileNote()?.textContent).toBe("files to bio");
  });

  it("search mode never shows the note — its /tokens are filters, not filing", async () => {
    const searchToggle = document.querySelector('button[aria-label="Search"]') as HTMLButtonElement;
    await act(async () => {
      searchToggle.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    const search = document.querySelector('[aria-label="Search your history"]') as HTMLElement;
    await act(async () => {
      search.textContent = "/bio problem";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(fileNote()).toBeNull();
    expect(sendButton().classList.contains("filing")).toBe(false);
  });
});
