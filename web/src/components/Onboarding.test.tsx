// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Onboarding } from "./Onboarding";

describe("Onboarding", () => {
  let host: HTMLDivElement;
  let root: Root;
  const onDone = vi.fn();

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    onDone.mockClear();
    (window as unknown as { graph: unknown }).graph = {};
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const render = async () => {
    await act(async () => {
      root.render(<Onboarding onDone={onDone} />);
    });
  };

  const title = () => host.querySelector(".onb-title")?.textContent ?? "";
  const next = () => host.querySelector<HTMLButtonElement>(".onb-next");
  const dots = () => Array.from(host.querySelectorAll<HTMLButtonElement>(".onb-dot"));
  const click = async (element: HTMLElement | null | undefined) => {
    await act(async () => {
      element?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  };
  const press = async (key: string) => {
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    });
  };

  it("opens on the first slide and walks forward and back", async () => {
    await render();
    expect(title()).toBe("This is Ceb.");
    expect(host.querySelector<HTMLButtonElement>(".onb-back")?.disabled).toBe(true);

    await click(next());
    expect(title()).toBe("Add anything you want Ceb to know.");

    await click(host.querySelector<HTMLButtonElement>(".onb-back"));
    expect(title()).toBe("This is Ceb.");
    expect(onDone).not.toHaveBeenCalled();
  });

  it("finishes only on the last slide, where the button becomes the primary action", async () => {
    await render();
    const total = dots().length;
    for (let i = 0; i < total - 1; i += 1) {
      expect(next()?.textContent).toBe("Next");
      await click(next());
    }
    expect(next()?.textContent).toBe("Start using Ceb");
    expect(onDone).not.toHaveBeenCalled();

    await click(next());
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("skips straight out, and cannot report done twice", async () => {
    await render();
    const skip = host.querySelector<HTMLButtonElement>(".onb-skip");
    await click(skip);
    await click(skip);
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("drives the deck from the keyboard", async () => {
    await render();
    await press("ArrowRight");
    expect(title()).toBe("Add anything you want Ceb to know.");
    await press("ArrowLeft");
    expect(title()).toBe("This is Ceb.");
    // Left at the start must not walk off the deck.
    await press("ArrowLeft");
    expect(title()).toBe("This is Ceb.");
  });

  it("jumps to a slide from its dot", async () => {
    await render();
    const target = dots()[4];
    await click(target);
    expect(title()).toBe("Keep things in folders.");
    expect(dots()[4]?.getAttribute("aria-selected")).toBe("true");
  });


});
