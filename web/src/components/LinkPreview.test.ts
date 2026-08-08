// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LinkPreviewResult } from "../shared/api";
import {
  clearLinkPreviewRequestCache,
  requestPreview,
  RichLinkPreview,
  RichLinkPreviews,
} from "./LinkPreview";

function preview(provider: LinkPreviewResult["provider"], canonicalUrl: string): LinkPreviewResult {
  return {
    url: canonicalUrl,
    canonicalUrl,
    provider,
    siteName: null,
    title: null,
    description: null,
    imageDataUrl: null,
  };
}

describe("link preview requests", () => {
  beforeEach(() => {
    clearLinkPreviewRequestCache();
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: { linkPreview: vi.fn() },
    });
  });

  it("retries transient failures instead of caching them for the renderer lifetime", async () => {
    const result = preview("web", "https://example.com/story");
    const linkPreview = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(result);
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: { linkPreview },
    });

    await expect(requestPreview(result.url)).resolves.toBeNull();
    await expect(requestPreview(result.url)).resolves.toEqual(result);
    expect(linkPreview).toHaveBeenCalledTimes(2);
  });

  it("bounds successful preview results and evicts the oldest entry", async () => {
    const linkPreview = vi.fn(async (url: string) => preview("web", url));
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: { linkPreview },
    });
    for (let index = 0; index <= 100; index += 1) {
      await requestPreview(`https://example.com/${index}`);
    }
    await requestPreview("https://example.com/0");
    expect(linkPreview).toHaveBeenCalledTimes(102);
  });
});

describe("generic link preview cards", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    clearLinkPreviewRequestCache();
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders Discord-style copy above a full-width image and keeps the whole embed clickable", async () => {
    const result = {
      ...preview("web", "https://example.com/story"),
      siteName: "Example",
      title: "A useful story",
      description: "A compact description for the preview card.",
      imageDataUrl: "data:image/png;base64,cHJldmlldw==",
    } satisfies LinkPreviewResult;
    const openExternal = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        linkPreview: vi.fn().mockResolvedValue(result),
        openExternal,
      },
    });

    await act(async () => {
      root.render(React.createElement(RichLinkPreview, { url: result.url, detail: true }));
    });

    const card = host.querySelector<HTMLButtonElement>(".link-preview.detail");
    expect(card?.getAttribute("aria-label")).toBe("Open a useful story");
    expect(card?.querySelector(".link-preview-provider")?.textContent).toBe("example");
    expect(card?.querySelector(".link-preview-title")?.textContent).toBe("a useful story");
    expect(card?.querySelector(".link-preview-description")?.textContent).toContain("compact description");
    const content = card?.querySelector(".link-preview-content");
    expect(Array.from(content?.children ?? []).map((element) => element.className)).toEqual([
      "link-preview-copy",
      "link-preview-media",
    ]);
    expect(content?.querySelector<HTMLImageElement>(".link-preview-copy + .link-preview-media img")?.src).toBe(result.imageDataUrl);

    await act(async () => card?.click());
    expect(openExternal).toHaveBeenCalledWith(result.canonicalUrl);
  });

  it("renders YouTube as a generic card with a bare thumbnail and no iframe", async () => {
    const result = {
      ...preview("youtube", "https://youtu.be/M7lc1UVf-VE"),
      siteName: "YouTube",
      title: "YouTube Developers Live",
      description: "By Google for Developers",
      imageDataUrl: "data:image/jpeg;base64,cHJldmlldw==",
    } satisfies LinkPreviewResult;
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        linkPreview: vi.fn().mockResolvedValue(result),
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
    });

    await act(async () => {
      root.render(React.createElement(RichLinkPreview, { url: result.url }));
    });

    const card = host.querySelector<HTMLButtonElement>(".link-preview-youtube");
    expect(card?.querySelector(".link-preview-provider")?.textContent).toBe("youtube");
    expect(card?.querySelector(".link-preview-title")?.textContent).toBe("youtube developers live");
    expect(card?.querySelector(".link-preview-description")?.textContent).toBe("by google for developers");
    expect(card?.querySelector<HTMLImageElement>(".link-preview-media img")?.src).toBe(result.imageDataUrl);
    expect(card?.querySelector(".link-preview-play")).toBeNull();
    expect(card?.querySelector("iframe")).toBeNull();
  });

  it("renders every distinct link embed in source order", async () => {
    const urls = [
      "https://second.example/story",
      "https://first.example/watch",
      "https://third.example/post",
      "https://fourth.example/note",
    ];
    const linkPreview = vi.fn(async (url: string) => ({
      ...preview("web", url),
      title: new URL(url).hostname,
    }));
    Object.defineProperty(window, "graph", {
      configurable: true,
      value: {
        linkPreview,
        openExternal: vi.fn().mockResolvedValue(undefined),
      },
    });

    await act(async () => {
      root.render(React.createElement(RichLinkPreviews, {
        text: `${urls[0]} then ${urls[1]} and ${urls[2]}, ${urls[3]}; repeated ${urls[1]}`,
      }));
    });

    expect(linkPreview.mock.calls.map(([url]) => url)).toEqual(urls);
    expect(
      [...host.querySelectorAll<HTMLButtonElement>(".link-preview")]
        .map((card) => card.getAttribute("aria-label")),
    ).toEqual(urls.map((url) => `Open ${new URL(url).hostname}`));
  });
});
