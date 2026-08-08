// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKnownTagsForTests, setKnownTags } from "../lib/tags";
import { InputPage } from "./InputPage";

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

async function pressKey(key: string) {
  await act(async () => {
    composer().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function persistedDocText(): string {
  const raw = JSON.parse(localStorage.getItem("graph.write.document.v2") ?? "null") as { text?: string } | null;
  return raw?.text ?? "";
}

describe("InputPage `/tag` autocomplete", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
    resetKnownTagsForTests();
    setKnownTags(["homework", "home", "math"]);
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
      root.render(<InputPage focusToken={0} composerOnly />);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    resetKnownTagsForTests();
    vi.restoreAllMocks();
  });

  const options = () => [...document.querySelectorAll(".tag-command-option")].map((node) => node.textContent);

  it("suggests known tags (plain names, no /) while typing a trailing /token", async () => {
    await typeComposer("essay /ho");
    expect(options()).toEqual(["homework", "home"]);

    await typeComposer("essay /zzz");
    expect(document.querySelector(".tag-command-menu")).toBeNull(); // unknown → nothing to suggest

    await typeComposer("essay /homework done");
    expect(document.querySelector(".tag-command-menu")).toBeNull(); // token finished by whitespace
  });

  it("Enter with the menu open completes the tag instead of submitting; next Enter submits", async () => {
    await typeComposer("essay /ho");
    await pressKey("Enter");
    expect(composer().value).toBe("essay /homework "); // completed, NOT submitted
    expect(persistedDocText()).not.toContain("\n\n");

    await pressKey("Enter"); // menu closed (token finished) → normal submit
    expect(composer().value).toBe("");
    expect(persistedDocText()).toBe("essay /homework \n\n");
  });

  it("Tab completes the highlighted tag; click completes too", async () => {
    await typeComposer("essay /ho");
    await pressKey("Tab");
    expect(composer().value).toBe("essay /homework ");

    await typeComposer("essay /ma");
    const option = document.querySelector(".tag-command-option") as HTMLButtonElement;
    await act(async () => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    });
    expect(composer().value).toBe("essay /math ");
  });

  it("Escape dismisses until the text changes", async () => {
    await typeComposer("essay /ho");
    await pressKey("Escape");
    expect(document.querySelector(".tag-command-menu")).toBeNull();
    await typeComposer("essay /hom");
    expect(document.querySelector(".tag-command-menu")).not.toBeNull();
  });

  it("tags are ordinary text: submit keeps them in the note", async () => {
    await typeComposer("finish essay /homework /math");
    await pressKey("Enter");
    expect(composer().value).toBe("");
    expect(persistedDocText()).toBe("finish essay /homework /math\n\n");
  });

  it("typing / in the search field pops the same list and Tab completes the term", async () => {
    const searchButton = document.querySelector('button[aria-label="Search"]') as HTMLButtonElement;
    await act(async () => {
      searchButton.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });
    const search = document.querySelector('[aria-label="Search your history"]') as HTMLElement;
    await act(async () => {
      search.textContent = "/ho";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options()).toEqual(["homework", "home"]);

    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
    });
    expect(search.textContent).toBe("/homework ");
    // Enter with the menu open completes the term too — it must NOT commit a filter pill.
    await act(async () => {
      search.textContent = "/ma";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options()).toEqual(["math"]);
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    expect(search.textContent).toBe("/math ");
    expect(document.querySelector(".omnibar-filter-pill")).toBeNull();
    // Esc with the menu open only dismisses the menu — search mode stays active.
    await act(async () => {
      search.textContent = "/ma";
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(options()).toEqual(["math"]);
    await act(async () => {
      search.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });
    expect(document.querySelector(".tag-command-menu")).toBeNull();
    expect(document.querySelector('[aria-label="Search your history"]')).not.toBeNull();
  });
});
