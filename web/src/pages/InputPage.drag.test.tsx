// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InputPage } from "./InputPage";

function fileDragEvent(type: string, files: File[]): DragEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as DragEvent;
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, dropEffect: "none" },
  });
  return event;
}

describe("InputPage window-wide file drop", () => {
  let host: HTMLDivElement;
  let root: Root;
  const attachment = {
    id: "attachment-1",
    name: "notes.txt",
    size: 5,
    contentType: "text/plain",
    isImage: false,
    url: null,
  };

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
        writeAttachmentsSync: vi.fn().mockImplementation(async (attachments = []) => ({ text: "", attachments })),
        writeAttachmentsAdd: vi.fn().mockResolvedValue({
          draft: { text: "", attachments: [attachment] },
          skipped: 0,
        }),
        writeAttachmentRemove: vi.fn().mockResolvedValue({ attachments: [] }),
      },
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("accepts a file dropped on board space and stages it in the composer", async () => {
    await act(async () => {
      root.render(<InputPage focusToken={0} composerOnly />);
    });
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });

    await act(async () => {
      document.body.dispatchEvent(fileDragEvent("dragenter", [file]));
      document.body.dispatchEvent(fileDragEvent("dragover", [file]));
    });
    expect(document.querySelector(".memory-write-composer-host")?.classList.contains("dropping")).toBe(true);
    expect(document.querySelector(".drop-pill")?.textContent).toBe("Drop to attach");

    await act(async () => {
      document.body.dispatchEvent(fileDragEvent("drop", [file]));
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(window.graph.writeAttachmentsAdd).toHaveBeenCalledOnce();
    expect(document.querySelector(".write-composer-attachment")?.textContent).toContain("notes.txt");
    expect(document.querySelector(".memory-write-composer-host")?.classList.contains("dropping")).toBe(false);
  });
});
