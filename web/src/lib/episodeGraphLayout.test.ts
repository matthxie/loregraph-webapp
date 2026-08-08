import { describe, expect, it } from "vitest";
import type { EpisodeGraphPreview } from "../shared/protocol";
import { layoutEpisodeGraph, tickEpisodeGraph } from "./episodeGraphLayout";

const preview: EpisodeGraphPreview = {
  nodes: [
    { id: "episode", label: "Memory", kind: "episode", hop: 0, external_connections: 0 },
    { id: "entity", label: "Toronto", kind: "entity", hop: 1, external_connections: 2 },
    { id: "concept", label: "Street photography", kind: "concept", hop: 2, external_connections: 0 },
  ],
  edges: [
    { source: "episode", target: "entity", kind: "MENTIONS", label: "mentions" },
    { source: "entity", target: "concept", kind: "RELATED_TO", label: "likes" },
  ],
};

describe("layoutEpisodeGraph", () => {
  it("keeps the selected memory near the center while force-separating its neighbors", () => {
    const nodes = layoutEpisodeGraph(preview);
    const center = nodes.find((node) => node.id === "episode")!;
    const first = nodes.find((node) => node.id === "entity")!;
    const second = nodes.find((node) => node.id === "concept")!;

    expect(Math.hypot(center.x - 380, center.y - 190)).toBeLessThan(60);
    expect(Math.hypot(first.x - center.x, first.y - center.y)).toBeGreaterThan(50);
    expect(Math.hypot(second.x - first.x, second.y - first.y)).toBeGreaterThan(50);
  });

  it("holds a dragged node fixed while gravity and springs move the rest", () => {
    const nodes = layoutEpisodeGraph(preview);
    const dragged = nodes.find((node) => node.id === "entity")!;
    const center = nodes.find((node) => node.id === "episode")!;
    dragged.x = 42;
    dragged.y = 52;
    const centerBefore = { x: center.x, y: center.y };

    tickEpisodeGraph(nodes, preview.edges, 760, 380, 1, new Set([dragged.id]));

    expect([dragged.x, dragged.y]).toEqual([42, 52]);
    expect([center.x, center.y]).not.toEqual([centerBefore.x, centerBefore.y]);
  });
});
