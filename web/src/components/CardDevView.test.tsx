/**
 * @vitest-environment jsdom
 *
 * The per-card dev view renders straight off the `episodes.list` row: entities and concepts are
 * their own fields, and tags exist ONLY as `tag` nodes inside graph_preview — the wire carries
 * no tag list, so a regression there would silently empty that section.
 *
 * No @testing-library here (matching EpisodeGraphPreview.phantom.test.tsx): React 19 via
 * createRoot + act, with requestAnimationFrame stubbed to a no-op so the graph's force sim
 * never advances and assertions read the deterministic first frame.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodeListRow } from "../shared/protocol";
import { CardDevView, graphTags } from "./CardDevView";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row: EpisodeListRow = {
  id: "ep_1",
  title: "",
  created_at: "2026-08-04T10:00:00Z",
  snippet: "tomato soup with grilled cheese",
  raw_text: "tomato soup with grilled cheese",
  media_paths: [],
  modality: "text",
  source: "capture",
  concepts: ["leftovers"],
  entities: ["tomato soup"],
  entity_categories: { "tomato soup": "thing" },
  graph_preview: {
    nodes: [
      { id: "ep_1", label: "tomato soup with grilled cheese", kind: "episode", hop: 0, external_connections: 0 },
      { id: "entity_1", label: "tomato soup", kind: "entity", hop: 1, external_connections: 2 },
      { id: "tag_1", label: "dinner", kind: "tag", hop: 1, external_connections: 0 },
      { id: "tag_2", label: "Dinner", kind: "tag", hop: 1, external_connections: 0 },
      { id: "tag_3", label: "soup", kind: "tag", hop: 1, external_connections: 0 },
    ],
    edges: [{ source: "ep_1", target: "entity_1", kind: "MENTIONS", label: "" }],
  },
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe("graphTags", () => {
  it("takes tag nodes only, de-duplicated case-insensitively", () => {
    expect(graphTags(row.graph_preview)).toEqual(["dinner", "soup"]);
  });

  it("is empty rather than throwing when the engine sent no graph", () => {
    expect(graphTags(undefined)).toEqual([]);
  });
});

describe("CardDevView", () => {
  it("shows the entities, concepts and tags the extraction pulled, plus the graph", () => {
    act(() => root.render(<CardDevView row={row} />));
    const text = host.textContent ?? "";
    expect(text).toContain("tomato soup");
    expect(text).toContain("leftovers");
    expect(text).toContain("dinner");
    expect(host.querySelector("[aria-label='dev-view-ep_1']")).not.toBeNull();
    expect(host.querySelector(".card-dev-graph svg")).not.toBeNull();
  });

  it("shows the extraction's summary — an image's or a link's account — when the row has one", () => {
    const described: EpisodeListRow = {
      ...row,
      media_paths: ["media/20260804T101500.png"],
      modality: "image",
      description: "A whiteboard photo of a mitochondrion, labelled cristae and matrix.",
    };
    act(() => root.render(<CardDevView row={described} />));
    const summary = host.querySelector("[aria-label='summary']")?.textContent ?? "";
    expect(summary).toContain("Summary");
    expect(summary).toContain("labelled cristae and matrix");
  });

  it("has no summary block when the engine sent none", () => {
    act(() => root.render(<CardDevView row={row} />));
    expect(host.querySelector("[aria-label='summary']")).toBeNull();
  });

  it("says so plainly when the extraction came back empty, and draws no graph", () => {
    const bare: EpisodeListRow = {
      ...row,
      description: null,
      concepts: [],
      entities: [],
      entity_categories: {},
      graph_preview: { nodes: [], edges: [] },
    };
    act(() => root.render(<CardDevView row={bare} />));
    expect(host.textContent).toContain("Nothing extracted");
    expect(host.querySelector(".card-dev-graph")).toBeNull();
  });

  it("caps a long tag list and reveals the rest on demand", () => {
    const many: EpisodeListRow = {
      ...row,
      graph_preview: {
        nodes: Array.from({ length: 20 }, (_, index) => ({
          id: `tag_${index}`,
          label: `tag-${index}`,
          kind: "tag" as const,
          hop: 1 as const,
          external_connections: 0,
        })),
        edges: [],
      },
    };
    act(() => root.render(<CardDevView row={many} />));
    // Scoped to the chip list: the graph draws every tag node's label too.
    const list = () => host.querySelector("[aria-label='tags-list']")?.textContent ?? "";
    expect(list()).not.toContain("tag-19");
    const more = host.querySelector<HTMLButtonElement>(".card-dev-more");
    expect(more?.textContent).toBe("+8 more");
    act(() => more?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    expect(list()).toContain("tag-19");
  });
});
