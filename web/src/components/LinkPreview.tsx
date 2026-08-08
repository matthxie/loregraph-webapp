import React, { useEffect, useRef, useState } from "react";
import type { LinkPreviewProvider, LinkPreviewResult } from "../shared/api";
import { linkifySegments, previewText } from "../lib/format";

const REQUEST_CACHE_LIMIT = 100;
const REQUEST_CACHE_TTL_MS = 15 * 60_000;
const requests = new Map<string, { expiresAt: number; value: Promise<LinkPreviewResult | null> }>();

export function requestPreview(url: string): Promise<LinkPreviewResult | null> {
  const existing = requests.get(url);
  if (existing && existing.expiresAt > Date.now()) return existing.value;
  if (existing) requests.delete(url);
  while (requests.size >= REQUEST_CACHE_LIMIT) {
    const oldest = requests.keys().next().value as string | undefined;
    if (!oldest) break;
    requests.delete(oldest);
  }
  const request = window.graph.linkPreview(url).then((result) => {
    // Network and metadata failures are retryable. Do not strand this URL until app restart.
    if (!result) requests.delete(url);
    return result;
  }).catch(() => {
    requests.delete(url);
    return null;
  });
  requests.set(url, { expiresAt: Date.now() + REQUEST_CACHE_TTL_MS, value: request });
  return request;
}

export function clearLinkPreviewRequestCache(): void {
  requests.clear();
}

function providerName(provider: LinkPreviewProvider, siteName: string | null): string {
  if (provider === "youtube") return "YouTube";
  if (provider === "x") return "X";
  if (provider === "instagram") return "Instagram";
  if (provider === "pinterest") return "Pinterest";
  return siteName || "Link";
}

function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function RichLinkPreview({ url, detail = false }: { url: string; detail?: boolean }) {
  const rootRef = useRef<HTMLButtonElement | null>(null);
  const [shouldLoad, setShouldLoad] = useState(() => typeof IntersectionObserver === "undefined");
  const [preview, setPreview] = useState<LinkPreviewResult | null | undefined>(undefined);

  useEffect(() => {
    if (shouldLoad) return;
    const element = rootRef.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: "320px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [shouldLoad]);

  useEffect(() => {
    if (!shouldLoad) return;
    let alive = true;
    setPreview(undefined);
    requestPreview(url).then((result) => {
      if (alive) setPreview(result);
    });
    return () => {
      alive = false;
    };
  }, [shouldLoad, url]);

  // The zero-height sentinel makes board previews lazy without showing a loading skeleton for
  // links whose metadata is unavailable.
  if (preview === undefined) {
    return <button ref={rootRef} type="button" className="link-preview-sentinel" tabIndex={-1} aria-hidden />;
  }
  if (!preview) return null;

  const host = displayHost(preview.canonicalUrl);
  // Site metadata arrives in the publisher's voice; the card speaks the app's (see previewText).
  const provider = previewText(providerName(preview.provider, preview.siteName || host));
  const title = previewText(preview.title || host);
  const description = preview.description ? previewText(preview.description) : "";
  return (
    <button
      ref={rootRef}
      type="button"
      className={`link-preview link-preview-${preview.provider}${detail ? " detail" : ""}`}
      aria-label={`Open ${title}`}
      onClick={(event) => {
        event.stopPropagation();
        void window.graph.openExternal(preview.canonicalUrl);
      }}
    >
      <span className="link-preview-content">
        <span className="link-preview-copy">
          <span className="link-preview-provider">{provider}</span>
          <span className="link-preview-title">{title}</span>
          {description && <span className="link-preview-description">{description}</span>}
        </span>
        {preview.imageDataUrl && (
          <span className="link-preview-media">
            <img src={preview.imageDataUrl} alt="" />
          </span>
        )}
      </span>
    </button>
  );
}

export function RichLinkPreviews({ text }: { text: string }) {
  const urls = [...new Set(
    linkifySegments(text).flatMap((segment) => segment.kind === "link" ? [segment.url] : []),
  )];
  if (urls.length === 0) return null;
  return <div className="link-preview-list">{urls.map((url) => <RichLinkPreview key={url} url={url} detail />)}</div>;
}
