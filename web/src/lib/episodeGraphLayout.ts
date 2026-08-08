import type {
  EpisodeGraphPreview,
  EpisodeGraphPreviewEdge,
  EpisodeGraphPreviewNode,
} from "../shared/protocol";

export interface PositionedEpisodeGraphNode extends EpisodeGraphPreviewNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function hashString(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededUnit(seed: string): number {
  const value = Math.sin(hashString(seed)) * 10000;
  return value - Math.floor(value);
}

export function episodeGraphNodeRadius(node: EpisodeGraphPreviewNode): number {
  if (node.kind === "episode") return 8;
  return Math.min(16, 10 + Math.sqrt(node.external_connections + 1) * 1.1);
}

function episodeGraphCollisionRadius(node: EpisodeGraphPreviewNode): number {
  const labelLimit = node.kind === "episode" ? 220 : 116;
  const labelHalfWidth = Math.min(labelLimit, Math.max(24, node.label.trim().length * 3.4));
  return Math.max(episodeGraphNodeRadius(node) + 18, labelHalfWidth + 8);
}

/** One force-simulation step. The selected memory has a stronger center gravity, while every
 * other node remains free to settle, spring, repel, and be dragged like the main graph. */
export function tickEpisodeGraph(
  nodes: PositionedEpisodeGraphNode[],
  edges: EpisodeGraphPreviewEdge[],
  width: number,
  height: number,
  alpha = 1,
  fixedIds: ReadonlySet<string> = new Set(),
): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const centerX = width / 2;
  const centerY = height / 2;
  const densityScale = Math.min(1.6, 1 + Math.max(0, nodes.length - 16) * 0.015);
  const repulsion = Math.min(21000, 11000 + nodes.length * 240) * Math.max(0.06, alpha);

  for (let leftIndex = 0; leftIndex < nodes.length; leftIndex += 1) {
    const left = nodes[leftIndex];
    if (!left) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < nodes.length; rightIndex += 1) {
      const right = nodes[rightIndex];
      if (!right) continue;
      let dx = right.x - left.x;
      let dy = right.y - left.y;
      let distanceSquared = dx * dx + dy * dy;
      if (distanceSquared < 1) {
        const angle = seededUnit(`${left.id}:${right.id}:repel`) * Math.PI * 2;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        distanceSquared = 1;
      }
      const distance = Math.sqrt(distanceSquared);
      const minimum = episodeGraphCollisionRadius(left) + episodeGraphCollisionRadius(right);
      const overlap = Math.max(0, minimum - distance) * 0.065;
      const force = Math.min(16, repulsion / Math.max(distanceSquared, 180) + overlap);
      const ux = dx / distance;
      const uy = dy / distance;
      if (!fixedIds.has(left.id)) {
        left.vx -= ux * force;
        left.vy -= uy * force;
      }
      if (!fixedIds.has(right.id)) {
        right.vx += ux * force;
        right.vy += uy * force;
      }
    }
  }

  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target) continue;
    let dx = target.x - source.x;
    let dy = target.y - source.y;
    let distance = Math.hypot(dx, dy);
    if (distance < 1) {
      const angle = seededUnit(`${source.id}:${target.id}:spring`) * Math.PI * 2;
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      distance = 1;
    }
    const desired = (source.hop === 0 || target.hop === 0 ? 225 : 300) * densityScale;
    const force = (distance - desired) * (0.006 * Math.max(0.15, alpha));
    const ux = dx / distance;
    const uy = dy / distance;
    if (!fixedIds.has(source.id)) {
      source.vx += ux * force;
      source.vy += uy * force;
    }
    if (!fixedIds.has(target.id)) {
      target.vx -= ux * force;
      target.vy -= uy * force;
    }
  }

  const margin = 38;
  for (const node of nodes) {
    if (fixedIds.has(node.id)) continue;
    const gravity = node.hop === 0 ? 0.002 : 0.00014;
    node.vx += (centerX - node.x) * gravity;
    node.vy += (centerY - node.y) * gravity;
    node.vx *= 0.66;
    node.vy *= 0.66;
    node.x += Math.max(-16, Math.min(16, node.vx));
    node.y += Math.max(-16, Math.min(16, node.vy));
    const radius = episodeGraphNodeRadius(node) + 18;
    node.x = Math.min(width - margin - radius, Math.max(margin + radius, node.x));
    node.y = Math.min(height - margin - radius, Math.max(margin + radius, node.y));
  }
}

/** Deterministic warm start for the animated force graph. */
export function layoutEpisodeGraph(
  preview: EpisodeGraphPreview,
  width = 760,
  height = 380,
): PositionedEpisodeGraphNode[] {
  const centerX = width / 2;
  const centerY = height / 2;
  const satellites = preview.nodes.filter((node) => node.hop !== 0);
  const nodes = preview.nodes.map((node) => {
    if (node.hop === 0) return { ...node, x: centerX, y: centerY, vx: 0, vy: 0 };
    const index = satellites.findIndex((candidate) => candidate.id === node.id);
    const radius = (node.hop === 1 ? 132 : 230) * (0.82 + seededUnit(`${node.id}:radius`) * 0.34);
    const angle = index * GOLDEN_ANGLE + seededUnit(`${node.id}:angle`) * 0.7;
    return {
      ...node,
      x: centerX + Math.cos(angle) * radius,
      y: centerY + Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
    };
  });

  for (let tick = 0; tick < 90; tick += 1) {
    tickEpisodeGraph(nodes, preview.edges, width, height, 1 - tick / 120);
  }
  return nodes;
}
