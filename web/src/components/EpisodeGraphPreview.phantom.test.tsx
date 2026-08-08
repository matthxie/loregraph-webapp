/**
 * @vitest-environment jsdom
 *
 * Regression guard for the "phantom edge" bug: the episode graph must never leave an edge
 * whose arrowhead points into empty space because its target node has no rendered glyph.
 *
 * Bug mechanism (now fixed): EpisodeGraphPreview keyed each edge by `${source}:${target}`.
 * Parallel edges between the same pair collided on that key — the "me" neighborhood has
 * entity_self->entity_0008 twice (considering_for_dinner / might_have_for_dinner) and
 * entity_self->entity_0012 twice (saw / went_to_see). Because EpisodeOverlay renders
 * <EpisodeGraphPreview preview={hop.preview} /> with NO React key across hops, the same fiber
 * is reused; on the hop swap React's reconciliation of the duplicate-keyed <path> children
 * left ORPHANED <path> DOM from the previous hop, pointing at glyphs that no longer existed —
 * exactly the reported "2 weeks" screenshot. Fix: unique edge keys (source:target:kind:label:
 * index) + a per-hop React key at the EpisodeOverlay call site.
 *
 * No @testing-library is installed; we drive React 19 with createRoot + act. Swaps use
 * act(root.render(...)) so the [preview] effect flushes and the node set updates to the new
 * hop (matching the real app). requestAnimationFrame is stubbed to a no-op so the force sim
 * never advances — assertions read the deterministic first committed frame and do not depend
 * on animation timing.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EpisodeGraphPreview as EpisodeGraphPreviewData } from "../shared/protocol";
import { EpisodeGraphPreview } from "./EpisodeGraphPreview";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---- fixtures (verbatim shapes from scratchpad/previews.json) --------------------------

const me: EpisodeGraphPreviewData = {
  nodes: [
    { id: "entity_self", label: "me", kind: "entity", hop: 0, external_connections: 0, entity_category: "person" },
    { id: "ep_c0debcdcd97d90d1", label: "maybe do shrimp for dinner tn", kind: "episode", hop: 1, external_connections: 2, entity_category: null },
    { id: "entity_0008", label: "shrimp", kind: "concept", hop: 1, external_connections: 1, entity_category: "thing" },
    { id: "entity_0011", label: "chloe", kind: "entity", hop: 1, external_connections: 0, entity_category: "person" },
    { id: "entity_0012", label: "the odyssey", kind: "entity", hop: 1, external_connections: 0, entity_category: "thing" },
    { id: "ep_48fef13e674726d5", label: "went to see the odyssey with chloe", kind: "episode", hop: 1, external_connections: 0, entity_category: null },
    { id: "ep_f352ecbddab4cd5d", label: "i went to the cafe and sway zack", kind: "episode", hop: 1, external_connections: 0, entity_category: null },
    { id: "entity_0001", label: "cafe", kind: "entity", hop: 1, external_connections: 0, entity_category: "place" },
    { id: "entity_0005", label: "zack", kind: "entity", hop: 1, external_connections: 0, entity_category: "person" },
    { id: "entity_0007", label: "the park", kind: "entity", hop: 1, external_connections: 0, entity_category: "place" },
    { id: "entity_0018", label: "Florida", kind: "entity", hop: 1, external_connections: 0, entity_category: "place" },
    { id: "ep_096cbf8efbf7f0a5", label: "went to the park td", kind: "episode", hop: 1, external_connections: 0, entity_category: null },
    { id: "ep_a2346df739149c02", label: "going to florida in a couple fo weeks", kind: "episode", hop: 1, external_connections: 0, entity_category: null },
    { id: "qty_000000", label: "2 weeks", kind: "entity", hop: 1, external_connections: 0, entity_category: "thing" },
  ],
  edges: [
    { source: "entity_self", target: "entity_0001", kind: "RELATED_TO", label: "went_to" },
    { source: "entity_self", target: "entity_0005", kind: "RELATED_TO", label: "saw" },
    { source: "entity_self", target: "entity_0007", kind: "RELATED_TO", label: "went_to" },
    { source: "entity_self", target: "entity_0008", kind: "RELATED_TO", label: "considering_for_dinner" },
    { source: "entity_self", target: "entity_0008", kind: "RELATED_TO", label: "might_have_for_dinner" },
    { source: "entity_self", target: "entity_0011", kind: "RELATED_TO", label: "went_with" },
    { source: "entity_self", target: "entity_0012", kind: "RELATED_TO", label: "saw" },
    { source: "entity_self", target: "entity_0012", kind: "RELATED_TO", label: "went_to_see" },
    { source: "entity_self", target: "entity_0018", kind: "RELATED_TO", label: "going_to" },
    { source: "entity_self", target: "qty_000000", kind: "RELATED_TO", label: "going_in" },
    { source: "ep_c0debcdcd97d90d1", target: "entity_self", kind: "MENTIONS", label: "" },
    { source: "ep_c0debcdcd97d90d1", target: "entity_0008", kind: "MENTIONS", label: "" },
    { source: "entity_0011", target: "entity_0012", kind: "RELATED_TO", label: "saw" },
    { source: "ep_48fef13e674726d5", target: "entity_self", kind: "MENTIONS", label: "" },
    { source: "ep_48fef13e674726d5", target: "entity_0011", kind: "MENTIONS", label: "" },
    { source: "ep_48fef13e674726d5", target: "entity_0012", kind: "MENTIONS", label: "" },
    { source: "ep_f352ecbddab4cd5d", target: "entity_self", kind: "MENTIONS", label: "" },
    { source: "ep_f352ecbddab4cd5d", target: "entity_0001", kind: "MENTIONS", label: "" },
    { source: "ep_f352ecbddab4cd5d", target: "entity_0005", kind: "MENTIONS", label: "" },
    { source: "ep_096cbf8efbf7f0a5", target: "entity_self", kind: "MENTIONS", label: "" },
    { source: "ep_096cbf8efbf7f0a5", target: "entity_0007", kind: "MENTIONS", label: "" },
    { source: "ep_a2346df739149c02", target: "entity_self", kind: "MENTIONS", label: "" },
    { source: "ep_a2346df739149c02", target: "entity_0018", kind: "MENTIONS", label: "" },
  ],
};

const twoWeeks: EpisodeGraphPreviewData = {
  nodes: [
    { id: "qty_000000", label: "2 weeks", kind: "entity", hop: 0, external_connections: 0, entity_category: "thing" },
    { id: "entity_self", label: "me", kind: "entity", hop: 1, external_connections: 12, entity_category: "person" },
  ],
  edges: [{ source: "entity_self", target: "qty_000000", kind: "RELATED_TO", label: "going_in" }],
};

// ---- DOM probes ------------------------------------------------------------------------

interface Phantom {
  edgeLabel: string;
  tipX: number;
  tipY: number;
  nearestGlyph: string;
  distPx: number;
}
interface Snapshot {
  edgeCount: number;
  nodeCount: number;
  nodeLabels: string[];
  edgeLabels: string[];
  /** Edge arrow-tips that land in empty space (no node glyph within NEAR_GLYPH_PX). */
  phantomTips: Phantom[];
}

const NEAR_GLYPH_PX = 34; // a real arrow tip sits ~(targetOutline+5.5)≈18-24px off its glyph center

function parseTranslate(g: Element): { x: number; y: number } | null {
  const t = g.getAttribute("transform");
  const m = t ? /translate\(\s*(-?[\d.]+)[ ,]+(-?[\d.]+)\s*\)/.exec(t) : null;
  if (!m || m[1] === undefined || m[2] === undefined) return null;
  return { x: parseFloat(m[1]), y: parseFloat(m[2]) };
}

/** The arrow apex in arrowPath() is the 4th coordinate pair (the sharp point at x2,y2). */
function parseArrowTip(d: string): { x: number; y: number } | null {
  const nums = d.match(/-?[\d.]+/g);
  if (!nums || nums.length < 8) return null;
  const tipX = nums[6];
  const tipY = nums[7];
  if (tipX === undefined || tipY === undefined) return null;
  return { x: parseFloat(tipX), y: parseFloat(tipY) };
}

function snapshot(container: HTMLElement): Snapshot {
  const nodeGroups = Array.from(container.querySelectorAll("g.history-graph-node"));
  const nodeCenters = nodeGroups
    .map((g) => {
      const c = parseTranslate(g);
      const label = g.querySelector(":scope > text")?.textContent ?? "";
      return c ? { label, x: c.x, y: c.y } : null;
    })
    .filter((v): v is { label: string; x: number; y: number } => v !== null);

  const edgePaths = Array.from(container.querySelectorAll("path.history-graph-edge"));
  const phantomTips: Phantom[] = [];
  for (const p of edgePaths) {
    const tip = parseArrowTip(p.getAttribute("d") ?? "");
    if (!tip) continue;
    let nearest = { label: "<none>", dist: Infinity };
    for (const n of nodeCenters) {
      const dist = Math.hypot(n.x - tip.x, n.y - tip.y);
      if (dist < nearest.dist) nearest = { label: n.label, dist };
    }
    if (nearest.dist > NEAR_GLYPH_PX) {
      phantomTips.push({
        edgeLabel: p.getAttribute("data-edge-label") ?? "",
        tipX: Math.round(tip.x),
        tipY: Math.round(tip.y),
        nearestGlyph: nearest.label,
        distPx: Math.round(nearest.dist),
      });
    }
  }
  return {
    edgeCount: edgePaths.length,
    nodeCount: nodeGroups.length,
    nodeLabels: nodeCenters.map((n) => n.label),
    edgeLabels: edgePaths.map((p) => p.getAttribute("data-edge-label") ?? ""),
    phantomTips,
  };
}

// ---- harness ---------------------------------------------------------------------------

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  // Freeze the force sim: only the deterministic 90-tick warm start from layoutEpisodeGraph
  // ever commits, so positions (and thus the phantom) are timing-independent.
  vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 0 as unknown as number);
  vi.spyOn(globalThis, "cancelAnimationFrame").mockImplementation(() => {});
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe("EpisodeGraphPreview — phantom-edge regression", () => {
  it("renders parallel edges as distinct paths (unique keys do not collapse them)", () => {
    act(() => root.render(<EpisodeGraphPreview preview={me} />));
    const snap = snapshot(container);
    // Every one of the 23 edges has both endpoints in the node set, so all render — and the
    // two parallel pairs must survive as separate <path>s rather than colliding on one key.
    expect(snap.phantomTips).toEqual([]);
    expect(snap.edgeCount).toBe(23);
    expect(snap.edgeLabels.filter((t) => t === "considering_for_dinner")).toHaveLength(1);
    expect(snap.edgeLabels.filter((t) => t === "might_have_for_dinner")).toHaveLength(1);
    expect(snap.edgeLabels.filter((t) => t === "went_to_see")).toHaveLength(1);
  });

  it("un-keyed hop swap me -> 2 weeks no longer orphans stale edges", () => {
    act(() => root.render(<EpisodeGraphPreview preview={me} />));
    expect(snapshot(container).phantomTips).toEqual([]);

    // Reuse the SAME instance with the next hop's preview (no key), like EpisodeOverlay's
    // graph-only panel. Before the fix, duplicate edge keys orphaned stale <path> DOM here.
    act(() => root.render(<EpisodeGraphPreview preview={twoWeeks} />));
    const swapped = snapshot(container);

    // The 2 weeks hop has exactly ONE edge (going_in) and TWO nodes — nothing leaks past the swap.
    expect(swapped.nodeCount).toBe(2);
    expect(swapped.nodeLabels.sort()).toEqual(["2 weeks", "me"]);
    expect(swapped.edgeCount).toBe(1);
    expect(swapped.edgeLabels).toEqual(["going_in"]);
    expect(swapped.phantomTips).toEqual([]);
    expect(container.querySelector("path.history-graph-edge")?.getAttribute("d")).not.toContain(" Q ");
  });

  it("un-keyed hop swap 2 weeks -> me stays clean", () => {
    act(() => root.render(<EpisodeGraphPreview preview={twoWeeks} />));
    expect(snapshot(container).phantomTips).toEqual([]);

    act(() => root.render(<EpisodeGraphPreview preview={me} />));
    const swapped = snapshot(container);
    expect(swapped.nodeCount).toBe(14);
    expect(swapped.phantomTips).toEqual([]);
  });

  it("a dangling edge (endpoint absent from the node set) never renders", () => {
    // A(hop0)->B(hop1) is real; A->C is dangling (C absent). All nodes are hop<=1, the case
    // where clampToOneHop used to early-return unchanged. Now clampToOneHop strips the edge
    // (its endpoint is not in the node set) and the render guard is a second line of defense.
    const crafted: EpisodeGraphPreviewData = {
      nodes: [
        { id: "A", label: "alpha", kind: "entity", hop: 0, external_connections: 0, entity_category: "thing" },
        { id: "B", label: "bravo", kind: "entity", hop: 1, external_connections: 0, entity_category: "thing" },
      ],
      edges: [
        { source: "A", target: "B", kind: "RELATED_TO", label: "real" },
        { source: "A", target: "C", kind: "RELATED_TO", label: "dangling" },
      ],
    };
    act(() => root.render(<EpisodeGraphPreview preview={crafted} />));
    const snap = snapshot(container);
    expect(snap.edgeLabels).not.toContain("dangling");
    expect(snap.phantomTips).toEqual([]);
  });

  it("curves reciprocal edges and places their labels on opposite sides", () => {
    const reciprocal: EpisodeGraphPreviewData = {
      nodes: [
        { id: "A", label: "alpha", kind: "entity", hop: 0, external_connections: 0, entity_category: "thing" },
        { id: "B", label: "bravo", kind: "entity", hop: 1, external_connections: 0, entity_category: "thing" },
      ],
      edges: [
        { source: "A", target: "B", kind: "RELATED_TO", label: "outgoing" },
        { source: "B", target: "A", kind: "RELATED_TO", label: "returning" },
      ],
    };

    act(() => root.render(<EpisodeGraphPreview preview={reciprocal} />));

    const paths = Array.from(container.querySelectorAll("path.history-graph-edge"));
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => path.getAttribute("d")?.includes(" Q "))).toBe(true);
    expect(paths[0]?.getAttribute("d")).not.toBe(paths[1]?.getAttribute("d"));

    const labels = Array.from(container.querySelectorAll("g.history-graph-edge-labels text"));
    const outgoing = labels.find((label) => label.textContent === "outgoing");
    const returning = labels.find((label) => label.textContent === "returning");
    expect(outgoing).toBeDefined();
    expect(returning).toBeDefined();
    expect({ x: outgoing?.getAttribute("x"), y: outgoing?.getAttribute("y") }).not.toEqual({
      x: returning?.getAttribute("x"),
      y: returning?.getAttribute("y"),
    });
  });

  it("stacks parallel labels with clearance between reciprocal lanes", () => {
    const reciprocal: EpisodeGraphPreviewData = {
      nodes: [
        { id: "A", label: "alpha", kind: "entity", hop: 0, external_connections: 0, entity_category: "thing" },
        { id: "B", label: "bravo", kind: "entity", hop: 1, external_connections: 0, entity_category: "thing" },
      ],
      edges: [
        { source: "A", target: "B", kind: "RELATED_TO", label: "outgoing-1" },
        { source: "A", target: "B", kind: "RELATED_TO", label: "outgoing-2" },
        { source: "A", target: "B", kind: "RELATED_TO", label: "outgoing-3" },
        { source: "B", target: "A", kind: "RELATED_TO", label: "returning-1" },
        { source: "B", target: "A", kind: "RELATED_TO", label: "returning-2" },
        { source: "B", target: "A", kind: "RELATED_TO", label: "returning-3" },
      ],
    };

    act(() => root.render(<EpisodeGraphPreview preview={reciprocal} />));

    const positions = Array.from(container.querySelectorAll("g.history-graph-edge-labels text")).map((label) => ({
      label: label.textContent,
      x: Number(label.getAttribute("x")),
      y: Number(label.getAttribute("y")),
    }));
    expect(positions).toHaveLength(6);
    for (let left = 0; left < positions.length; left += 1) {
      for (let right = left + 1; right < positions.length; right += 1) {
        expect(Math.hypot(
          (positions[left]?.x ?? 0) - (positions[right]?.x ?? 0),
          (positions[left]?.y ?? 0) - (positions[right]?.y ?? 0),
        )).toBeGreaterThan(14);
      }
    }
  });

  it("shows hidden relationships in a callout without moving the edge", () => {
    const reciprocal: EpisodeGraphPreviewData = {
      nodes: [
        { id: "A", label: "alpha", kind: "entity", hop: 0, external_connections: 0, entity_category: "thing" },
        { id: "B", label: "bravo", kind: "entity", hop: 1, external_connections: 0, entity_category: "thing" },
      ],
      edges: [
        ...Array.from({ length: 6 }, (_, index) => ({
          source: "A",
          target: "B",
          kind: "RELATED_TO" as const,
          label: `outgoing-${index + 1}`,
        })),
        ...Array.from({ length: 6 }, (_, index) => ({
          source: "B",
          target: "A",
          kind: "RELATED_TO" as const,
          label: `returning-${index + 1}`,
        })),
      ],
    };

    act(() => root.render(<EpisodeGraphPreview preview={reciprocal} />));

    const labelText = () => Array.from(container.querySelectorAll("g.history-graph-edge-labels text"))
      .map((label) => label.textContent);
    expect(labelText()).toEqual([
      "outgoing-1",
      "outgoing-2",
      "outgoing-3",
      "+ 3 more",
      "returning-1",
      "returning-2",
      "returning-3",
      "+ 3 more",
    ]);

    const compactPath = container.querySelector("path.history-graph-edge")?.getAttribute("d");
    const hitTargets = container.querySelectorAll("path.history-graph-edge-hit-target");
    expect(hitTargets).toHaveLength(2);
    expect(Array.from(hitTargets).every((target) => target.querySelector("title") === null)).toBe(true);
    act(() => hitTargets[0]?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));

    expect(labelText()).toEqual([
      "outgoing-1",
      "outgoing-2",
      "outgoing-3",
      "+ 3 more",
      "returning-1",
      "returning-2",
      "returning-3",
      "+ 3 more",
    ]);
    expect(Array.from(container.querySelectorAll(".history-graph-edge-details-row")).map((row) => row.textContent))
      .toEqual(["outgoing-4", "outgoing-5", "outgoing-6"]);
    expect(container.querySelector(".history-graph-edge-details-window strong")?.textContent)
      .toBe("3 more relationships");
    expect(container.querySelector("path.history-graph-edge")?.getAttribute("d")).toBe(compactPath);
    const nodeLayer = container.querySelector("g.history-graph-nodes");
    const detailLayer = container.querySelector("g.history-graph-edge-details");
    expect(nodeLayer && detailLayer && (nodeLayer.compareDocumentPosition(detailLayer) & Node.DOCUMENT_POSITION_FOLLOWING))
      .toBeTruthy();
  });
});
