// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputPage } from "./InputPage";

function editableCaretOffset(element: HTMLElement): number {
  const selection = window.getSelection();
  const focusNode = selection?.focusNode;
  if (!selection || !focusNode || !element.contains(focusNode)) return -1;
  const range = document.createRange();
  range.selectNodeContents(element);
  range.setEnd(focusNode, selection.focusOffset);
  return range.toString().length;
}

function setEditableCaret(element: HTMLElement, offset: number): void {
  const text = element.firstChild;
  if (!text) throw new Error("editable has no text node");
  const range = document.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

describe("InputPage search handoff", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear();
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
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("carries composer text into Search and preserves the caret in both directions", async () => {
    const onSearchChange = vi.fn();
    await act(async () => {
      root.render(<InputPage focusToken={0} composerOnly onSearchChange={onSearchChange} />);
    });

    const composer = document.querySelector('textarea[aria-label="Add anything"]') as HTMLTextAreaElement;
    expect(composer.placeholder).toBe("add anything...");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      setter?.call(composer, "  native   embeds  ");
      composer.dispatchEvent(new Event("input", { bubbles: true }));
    });
    composer.focus();
    composer.setSelectionRange(5, 5);

    const searchButton = document.querySelector('button[aria-label="Search"]') as HTMLButtonElement;
    await act(async () => {
      searchButton.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    const search = document.querySelector('[aria-label="Search your history"]') as HTMLSpanElement;
    expect(search.textContent).toBe("native embeds");
    expect(document.activeElement).toBe(search);
    // Original offset 5 is after "  nat"; Search collapses leading whitespace,
    // so the equivalent logical insertion point is after "nat" at offset 3.
    expect(editableCaretOffset(search)).toBe(3);
    expect(onSearchChange).toHaveBeenLastCalledWith("native embeds");

    setEditableCaret(search, 8);
    await act(async () => {
      searchButton.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    const restoredComposer = document.querySelector('textarea[aria-label="Add anything"]') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(restoredComposer);
    // Search offset 8 maps back through the collapsed middle whitespace to the
    // corresponding position after the "e" in the original composer text.
    expect(restoredComposer.selectionStart).toBe(12);
    expect(restoredComposer.selectionEnd).toBe(12);
  });

  it("keeps an empty Search field focused on a non-collapsed caret target", async () => {
    await act(async () => {
      root.render(<InputPage focusToken={0} composerOnly />);
    });

    const searchButton = document.querySelector('button[aria-label="Search"]') as HTMLButtonElement;
    await act(async () => {
      searchButton.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    });

    const search = document.querySelector('[aria-label="Search your history"]') as HTMLSpanElement;
    expect(search.dataset.empty).toBe("true");
    expect(document.activeElement).toBe(search);
    expect(window.getSelection()?.rangeCount).toBe(1);
  });
});
