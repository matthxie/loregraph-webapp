import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  EpisodeGraphPreview as EpisodeGraphPreviewData,
  EpisodeGraphPreviewNode,
} from "../shared/protocol";
import {
  episodeGraphNodeRadius,
  layoutEpisodeGraph,
  tickEpisodeGraph,
  type PositionedEpisodeGraphNode,
} from "../lib/episodeGraphLayout";
import { zoomGraphViewBox, type GraphViewBox as ViewBox } from "../lib/graphViewport";
import { GraphNodeGlyph, graphNodeOutlineRadius } from "./GraphNodeGlyph";

/** Layout box, in viewBox units. Callers that render into something much smaller than an
 *  overlay (the per-card dev view) pass a tighter box so the SVG isn't scaled to illegibility. */
const WIDTH = 1000;
const HEIGHT = 600;
const EDGE_LABEL_STACK_SPACING = 17;
const EDGE_DETAILS_WIDTH = 224;
/** Frames of near-zero movement after which the force sim parks itself (see the animate loop). */
const SETTLED_FRAMES = 14;
const SETTLED_MOVEMENT = 0.06;

interface PanDrag {
  pointerId: number;
  clientX: number;
  clientY: number;
  viewBox: ViewBox;
}

interface NodeDrag {
  pointerId: number;
  nodeId: string;
}

function edgeEndpoints(source: PositionedEpisodeGraphNode, target: PositionedEpisodeGraphNode) {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) return null;
  const ux = dx / distance;
  const uy = dy / distance;
  const sourceOutline = graphNodeOutlineRadius(source.kind, episodeGraphNodeRadius(source));
  const targetOutline = graphNodeOutlineRadius(target.kind, episodeGraphNodeRadius(target));
  return {
    x1: source.x + ux * (sourceOutline + 2),
    y1: source.y + uy * (sourceOutline + 2),
    x2: target.x - ux * (targetOutline + 5.5),
    y2: target.y - uy * (targetOutline + 5.5),
  };
}

function edgeDirectionKey(source: string, target: string): string {
  return JSON.stringify([source, target]);
}

function summarizedLabelCount(edgeCount: number): number {
  return Math.min(edgeCount, 3) + (edgeCount > 3 ? 1 : 0);
}

function reciprocalCurveOffset(
  source: PositionedEpisodeGraphNode,
  target: PositionedEpisodeGraphNode,
  reciprocal: boolean,
  largestLabelStack: number,
): number {
  if (!reciprocal) return 0;
  const lengthBasedOffset = Math.min(72, Math.max(28, Math.hypot(target.x - source.x, target.y - source.y) * 0.12));
  // curveOffset is also the distance between the two reciprocal label-stack centers.
  // Reserve both stacks' half-heights plus a clear lane between their innermost labels.
  const labelClearanceOffset = (largestLabelStack - 1) * EDGE_LABEL_STACK_SPACING + 30;
  return Math.max(lengthBasedOffset, labelClearanceOffset);
}

function edgeLabelPosition(
  source: PositionedEpisodeGraphNode,
  target: PositionedEpisodeGraphNode,
  curveOffset: number,
  stackOffset: number,
): { x: number; y: number } {
  const dx = target.x - source.x;
  const dy = target.y - source.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 2) {
    return { x: (source.x + target.x) / 2, y: (source.y + target.y) / 2 };
  }
  // At t=.5, a quadratic Bezier is halfway between the chord midpoint and its control
  // point. Reversing an edge reverses this local normal, putting reciprocal labels on
  // opposite sides without relying on node ordering or mutable layout state.
  return {
    x: (source.x + target.x) / 2 + (-dy / distance) * (curveOffset * 0.5 + stackOffset),
    y: (source.y + target.y) / 2 + (dx / distance) * (curveOffset * 0.5 + stackOffset),
  };
}

function edgeDetailsPosition(
  source: PositionedEpisodeGraphNode,
  target: PositionedEpisodeGraphNode,
  rowCount: number,
  boxWidth: number,
  boxHeight: number,
): { x: number; y: number; width: number; height: number } {
  const height = 44 + rowCount * 20;
  const midpointX = (source.x + target.x) / 2;
  const midpointY = (source.y + target.y) / 2;
  const opensTowardTarget = target.x >= source.x;
  const desiredX = opensTowardTarget
    ? midpointX + 10
    : midpointX - EDGE_DETAILS_WIDTH - 10;
  const desiredY = midpointY - height / 2;
  return {
    x: Math.min(boxWidth - EDGE_DETAILS_WIDTH - 12, Math.max(12, desiredX)),
    y: Math.min(boxHeight - height - 12, Math.max(12, desiredY)),
    width: EDGE_DETAILS_WIDTH,
    height,
  };
}

function arrowPath(
  endpoints: NonNullable<ReturnType<typeof edgeEndpoints>>,
  curveOffset = 0,
): string | null {
  const dx = endpoints.x2 - endpoints.x1;
  const dy = endpoints.y2 - endpoints.y1;
  const length = Math.hypot(dx, dy);
  if (length < 8) return null;
  const ux = dx / length;
  const uy = dy / length;
  const px = -uy;
  const py = ux;
  const shaftWidth = 0.9;
  const headWidth = 7;
  const headLength = Math.min(14, Math.max(9, length * 0.35));
  const baseX = endpoints.x2 - ux * headLength;
  const baseY = endpoints.y2 - uy * headLength;
  if (curveOffset !== 0) {
    const controlX = (endpoints.x1 + endpoints.x2) / 2 + px * curveOffset;
    const controlY = (endpoints.y1 + endpoints.y2) / 2 + py * curveOffset;
    const startTangentLength = Math.hypot(controlX - endpoints.x1, controlY - endpoints.y1);
    const startUx = (controlX - endpoints.x1) / startTangentLength;
    const startUy = (controlY - endpoints.y1) / startTangentLength;
    const endTangentLength = Math.hypot(endpoints.x2 - controlX, endpoints.y2 - controlY);
    const endUx = (endpoints.x2 - controlX) / endTangentLength;
    const endUy = (endpoints.y2 - controlY) / endTangentLength;
    const startPx = -startUy;
    const startPy = startUx;
    const endPx = -endUy;
    const endPy = endUx;
    const curvedBaseX = endpoints.x2 - endUx * headLength;
    const curvedBaseY = endpoints.y2 - endUy * headLength;
    return [
      `M ${endpoints.x1 + startPx * shaftWidth * 0.5} ${endpoints.y1 + startPy * shaftWidth * 0.5}`,
      `Q ${controlX + px * shaftWidth * 0.5} ${controlY + py * shaftWidth * 0.5} ${curvedBaseX + endPx * shaftWidth * 0.5} ${curvedBaseY + endPy * shaftWidth * 0.5}`,
      `L ${curvedBaseX + endPx * headWidth * 0.5} ${curvedBaseY + endPy * headWidth * 0.5}`,
      `L ${endpoints.x2} ${endpoints.y2}`,
      `L ${curvedBaseX - endPx * headWidth * 0.5} ${curvedBaseY - endPy * headWidth * 0.5}`,
      `L ${curvedBaseX - endPx * shaftWidth * 0.5} ${curvedBaseY - endPy * shaftWidth * 0.5}`,
      `Q ${controlX - px * shaftWidth * 0.5} ${controlY - py * shaftWidth * 0.5} ${endpoints.x1 - startPx * shaftWidth * 0.5} ${endpoints.y1 - startPy * shaftWidth * 0.5}`,
      "Z",
    ].join(" ");
  }
  return [
    `M ${endpoints.x1 + px * shaftWidth * 0.5} ${endpoints.y1 + py * shaftWidth * 0.5}`,
    `L ${baseX + px * shaftWidth * 0.5} ${baseY + py * shaftWidth * 0.5}`,
    `L ${baseX + px * headWidth * 0.5} ${baseY + py * headWidth * 0.5}`,
    `L ${endpoints.x2} ${endpoints.y2}`,
    `L ${baseX - px * headWidth * 0.5} ${baseY - py * headWidth * 0.5}`,
    `L ${baseX - px * shaftWidth * 0.5} ${baseY - py * shaftWidth * 0.5}`,
    `L ${endpoints.x1 - px * shaftWidth * 0.5} ${endpoints.y1 - py * shaftWidth * 0.5}`,
    "Z",
  ].join(" ");
}

function edgeHitPath(
  endpoints: NonNullable<ReturnType<typeof edgeEndpoints>>,
  curveOffset: number,
): string {
  if (curveOffset === 0) {
    return `M ${endpoints.x1} ${endpoints.y1} L ${endpoints.x2} ${endpoints.y2}`;
  }
  const dx = endpoints.x2 - endpoints.x1;
  const dy = endpoints.y2 - endpoints.y1;
  const distance = Math.hypot(dx, dy);
  const controlX = (endpoints.x1 + endpoints.x2) / 2 + (-dy / distance) * curveOffset;
  const controlY = (endpoints.y1 + endpoints.y2) / 2 + (dx / distance) * curveOffset;
  return `M ${endpoints.x1} ${endpoints.y1} Q ${controlX} ${controlY} ${endpoints.x2} ${endpoints.y2}`;
}

function graphPoint(clientX: number, clientY: number, svg: SVGSVGElement, viewBox: ViewBox) {
  const rect = svg.getBoundingClientRect();
  return {
    x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
    y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
  };
}

function visibleEdgeLabel(edge: EpisodeGraphPreviewData["edges"][number]): string {
  return edge.kind.toUpperCase() === "MENTIONS" ? "" : edge.label;
}

/** This component renders both graph flavors the engine serves: the raw store subgraph an
 * episode created (episode + mention/tag/entity nodes, marked hop 0|1) and the one-hop
 * topological neighborhood of an entity from `graph.preview`. Both are hop-bounded, so this
 * only defends against a stray deeper node an old two-hop engine might serve — dropping it and
 * folding each dangling edge into the kept endpoint's continuation-stub count. It is a no-op
 * (fast-path identity return) for a well-formed episode graph. */
function clampToOneHop(preview: EpisodeGraphPreviewData): EpisodeGraphPreviewData {
  const kept = preview.nodes.filter((node) => node.hop <= 1);
  const keep = new Set(kept.map((node) => node.id));
  const droppedNeighbors = new Map<string, number>();
  const edges = preview.edges.filter((edge) => {
    const keepEdge = keep.has(edge.source) && keep.has(edge.target);
    if (!keepEdge) {
      for (const id of [edge.source, edge.target]) {
        if (keep.has(id)) droppedNeighbors.set(id, (droppedNeighbors.get(id) ?? 0) + 1);
      }
    }
    return keepEdge;
  });
  // Preserve identity only when there is genuinely nothing to strip — no >1-hop node AND
  // no dangling edge. The filter above runs unconditionally so an edge whose endpoint is
  // simply absent from the node set (not merely a 2-hop node) is dropped / folded into the
  // kept endpoint's continuation count, instead of surviving to point at a node never drawn.
  if (kept.length === preview.nodes.length && edges.length === preview.edges.length) {
    return preview;
  }
  return {
    ...preview,
    nodes: kept.map((node) => {
      const dropped = droppedNeighbors.get(node.id);
      return dropped ? { ...node, external_connections: node.external_connections + dropped } : node;
    }),
    edges,
  };
}

function continuationEndpoints(
  node: PositionedEpisodeGraphNode,
  center: PositionedEpisodeGraphNode | undefined,
) {
  let dx = center ? node.x - center.x : 0;
  let dy = center ? node.y - center.y : -1;
  let distance = Math.hypot(dx, dy);
  if (distance < 1) {
    const hash = [...node.id].reduce((value, character) => value + character.charCodeAt(0), 0);
    const angle = (hash % 360) * (Math.PI / 180);
    dx = Math.cos(angle);
    dy = Math.sin(angle);
    distance = 1;
  }
  const ux = dx / distance;
  const uy = dy / distance;
  const start = graphNodeOutlineRadius(node.kind, episodeGraphNodeRadius(node)) + 6;
  const length = 24 + Math.min(18, Math.log2(node.external_connections + 1) * 6);
  return {
    x1: node.x + ux * start,
    y1: node.y + uy * start,
    x2: node.x + ux * (start + length),
    y2: node.y + uy * (start + length),
  };
}

export function EpisodeGraphPreview({
  preview: fullPreview,
  focusedNodeId,
  onNodeDoubleClick,
  width = WIDTH,
  height = HEIGHT,
  label = "Memory graph",
}: {
  preview: EpisodeGraphPreviewData;
  focusedNodeId?: string | null;
  onNodeDoubleClick?: (node: EpisodeGraphPreviewNode) => void;
  /** Layout box in viewBox units. A card-sized surface wants a tighter box than the default
   *  overlay one, or the whole graph is scaled down until the labels are unreadable. */
  width?: number;
  height?: number;
  label?: string;
}) {
  const preview = useMemo(() => clampToOneHop(fullPreview), [fullPreview]);
  // The dev graph serves the raw store structure (mention/tag/relation nodes and raw edge
  // types like MENTIONED_IN/RESOLVES_TO/TAGGED_AS); only a fallback cooked graph_preview (old
  // engine) uses MENTIONS + person/place/thing glyphs. Detect raw from either a raw node kind
  // or a raw edge kind so a re-rooted neighborhood is styled consistently; when raw, nodes are
  // plain kind-colored circles and every edge keeps its label.
  const isRaw = useMemo(
    () => preview.nodes.some((node) =>
        node.kind === "mention" || node.kind === "tag" || node.kind === "relation"
        || node.kind === "source" || node.kind === "community")
      || preview.edges.some((edge) =>
        edge.kind === "MENTIONED_IN" || edge.kind === "RESOLVES_TO" || edge.kind === "TAGGED_AS"),
    [preview.nodes, preview.edges],
  );
  const [nodes, setNodes] = useState(() => layoutEpisodeGraph(preview, width, height));
  const [viewBox, setViewBox] = useState<ViewBox>({ x: 0, y: 0, width, height });
  const [panDrag, setPanDrag] = useState<PanDrag | null>(null);
  const [hoveredEdgeDirection, setHoveredEdgeDirection] = useState<string | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodesRef = useRef(nodes);
  const nodeDragRef = useRef<NodeDrag | null>(null);
  const pinnedNodeIdsRef = useRef<Set<string>>(new Set());
  const energyRef = useRef(1);
  const edgeHoverCloseRef = useRef<number | null>(null);
  /** Wakes a settled simulation (see the animate loop); replaced by the [preview] effect. */
  const restartSimulationRef = useRef<() => void>(() => {});

  const showEdgeDetails = (direction: string) => {
    if (edgeHoverCloseRef.current !== null) window.clearTimeout(edgeHoverCloseRef.current);
    edgeHoverCloseRef.current = null;
    setHoveredEdgeDirection(direction);
  };

  const scheduleEdgeDetailsClose = (direction: string) => {
    if (edgeHoverCloseRef.current !== null) window.clearTimeout(edgeHoverCloseRef.current);
    edgeHoverCloseRef.current = window.setTimeout(() => {
      setHoveredEdgeDirection((current) => current === direction ? null : current);
      edgeHoverCloseRef.current = null;
    }, 140);
  };

  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const rect = svg.getBoundingClientRect();
      setViewBox((current) =>
        zoomGraphViewBox(
          current,
          event.deltaY,
          event.clientX,
          event.clientY,
          rect.left,
          rect.top,
          rect.width,
          rect.height,
          120,
          width * 2.5,
        ),
      );
    };
    svg.addEventListener("wheel", handleWheel, { passive: false });
    return () => svg.removeEventListener("wheel", handleWheel);
  }, [width]);

  useEffect(() => () => {
    if (edgeHoverCloseRef.current !== null) window.clearTimeout(edgeHoverCloseRef.current);
  }, []);

  useEffect(() => {
    const initial = layoutEpisodeGraph(preview, width, height);
    nodesRef.current = initial;
    pinnedNodeIdsRef.current.clear();
    setNodes(initial);
    setViewBox({ x: 0, y: 0, width, height });
    energyRef.current = 1;
    let frame = 0;
    let stillFrames = 0;
    let animationFrame = 0;
    const animate = () => {
      const dragged = nodeDragRef.current;
      const fixedIds = new Set(pinnedNodeIdsRef.current);
      if (dragged) fixedIds.add(dragged.nodeId);
      const before = nodesRef.current.map((node) => ({ x: node.x, y: node.y }));
      tickEpisodeGraph(
        nodesRef.current,
        preview.edges,
        width,
        height,
        energyRef.current,
        fixedIds,
      );
      energyRef.current = Math.max(0.04, energyRef.current * 0.975);
      frame += 1;
      if (frame % 2 === 0) setNodes(nodesRef.current.map((node) => ({ ...node })));
      // Park the loop once the layout stops moving, and flush the settled frame. The board can
      // carry one of these graphs per card (the dev view), and an animation loop that never
      // ends is then one forever-running rAF per card. A drag wakes it back up.
      const movement = nodesRef.current.reduce((largest, node, index) => {
        const previous = before[index];
        if (!previous) return largest;
        return Math.max(largest, Math.abs(node.x - previous.x) + Math.abs(node.y - previous.y));
      }, 0);
      stillFrames = dragged || movement > SETTLED_MOVEMENT ? 0 : stillFrames + 1;
      if (stillFrames >= SETTLED_FRAMES) {
        animationFrame = 0;
        setNodes(nodesRef.current.map((node) => ({ ...node })));
        return;
      }
      animationFrame = requestAnimationFrame(animate);
    };
    const start = () => {
      if (animationFrame) return;
      stillFrames = 0;
      animationFrame = requestAnimationFrame(animate);
    };
    restartSimulationRef.current = start;
    animationFrame = requestAnimationFrame(animate);
    return () => {
      restartSimulationRef.current = () => {};
      cancelAnimationFrame(animationFrame);
      animationFrame = 0;
    };
  }, [preview, width, height]);

  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const edgeLanes = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of preview.edges) {
      const key = edgeDirectionKey(edge.source, edge.target);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const seen = new Map<string, number>();
    return preview.edges.map((edge) => {
      const key = edgeDirectionKey(edge.source, edge.target);
      const reverseKey = edgeDirectionKey(edge.target, edge.source);
      const parallelIndex = seen.get(key) ?? 0;
      seen.set(key, parallelIndex + 1);
      const parallelCount = counts.get(key) ?? 1;
      const oppositeCount = counts.get(reverseKey) ?? 0;
      return {
        key,
        parallelIndex,
        parallelCount,
        oppositeCount,
      };
    });
  }, [preview.edges]);
  const centerNode = nodes.find((node) => node.hop === 0);
  if (nodes.length === 0) return null;

  return (
    <section className="memory-lightbox-graph" aria-label={label}>
      <div className="history-graph-canvas">
        <svg
          ref={svgRef}
          className={`history-graph-svg${panDrag ? " dragging" : ""}`}
          viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
          role="img"
          aria-label="Force-directed graph for this memory"
          onPointerDown={(event) => {
            if (event.button !== 0 || event.target !== event.currentTarget) return;
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            setPanDrag({ pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, viewBox });
          }}
          onPointerMove={(event) => {
            if (!panDrag || panDrag.pointerId !== event.pointerId) return;
            const rect = event.currentTarget.getBoundingClientRect();
            setViewBox({
              ...panDrag.viewBox,
              x: panDrag.viewBox.x - ((event.clientX - panDrag.clientX) / rect.width) * panDrag.viewBox.width,
              y: panDrag.viewBox.y - ((event.clientY - panDrag.clientY) / rect.height) * panDrag.viewBox.height,
            });
          }}
          onPointerUp={(event) => {
            if (panDrag?.pointerId !== event.pointerId) return;
            event.currentTarget.releasePointerCapture(event.pointerId);
            setPanDrag(null);
          }}
          onPointerCancel={() => setPanDrag(null)}
        >
          <g className="history-graph-edges">
            {preview.edges.map((edge, index) => {
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              if (!source || !target) return null;
              const endpoints = edgeEndpoints(source, target);
              const lane = edgeLanes[index];
              const largestDisplayedStack = Math.max(
                summarizedLabelCount(lane?.parallelCount ?? 1),
                summarizedLabelCount(lane?.oppositeCount ?? 0),
              );
              const curveOffset = reciprocalCurveOffset(
                source,
                target,
                (lane?.oppositeCount ?? 0) > 0,
                largestDisplayedStack,
              );
              const path = endpoints ? arrowPath(endpoints, curveOffset) : null;
              if (!path) return null;
              const label = visibleEdgeLabel(edge);
              return (
                <path
                  // Parallel edges share a source/target pair (e.g. saw + went_to_see),
                  // so the pair alone is not a unique React key — include kind/label and
                  // the stable list index, or the duplicate keys orphan stale <path> DOM
                  // when this (un-keyed, reused) instance swaps to a smaller preview.
                  key={`${edge.source}:${edge.target}:${edge.kind}:${edge.label}:${index}`}
                  className="history-graph-edge fact"
                  d={path}
                  data-edge-label={label || undefined}
                />
              );
            })}
          </g>
          <g className="history-graph-edge-hit-targets">
            {preview.edges.map((edge, index) => {
              const lane = edgeLanes[index];
              if (!lane || lane.parallelIndex !== 0) return null;
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              if (!source || !target) return null;
              const endpoints = edgeEndpoints(source, target);
              if (!endpoints) return null;
              // Keep a generous invisible target on the compact curve so the relationship
              // callout is easy to reveal without making the visible arrow feel heavy.
              const compactStack = Math.max(
                summarizedLabelCount(lane.parallelCount),
                summarizedLabelCount(lane.oppositeCount),
              );
              const compactCurveOffset = reciprocalCurveOffset(
                source,
                target,
                lane.oppositeCount > 0,
                compactStack,
              );
              return (
                <path
                  key={`${lane.key}:hit-target`}
                  className="history-graph-edge-hit-target"
                  d={edgeHitPath(endpoints, compactCurveOffset)}
                  data-edge-direction={lane.key}
                  onMouseEnter={() => showEdgeDetails(lane.key)}
                  onMouseLeave={() => scheduleEdgeDetailsClose(lane.key)}
                />
              );
            })}
          </g>
          <g className="history-graph-continuations" aria-label="Connections beyond this view">
            {nodes.map((node) => {
              if (node.external_connections <= 0) return null;
              const endpoints = continuationEndpoints(node, centerNode);
              return (
                <line key={`${node.id}:continuation`} {...endpoints} />
              );
            })}
          </g>
          <g className="history-graph-edge-labels">
            {preview.edges.map((edge, index) => {
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              const label = visibleEdgeLabel(edge);
              if (!source || !target || !label) return null;
              const lane = edgeLanes[index];
              if ((lane?.parallelIndex ?? 0) >= summarizedLabelCount(lane?.parallelCount ?? 1)) {
                return null;
              }
              const visibleLabel = (lane?.parallelCount ?? 1) > 3 && lane?.parallelIndex === 3
                ? `+ ${(lane?.parallelCount ?? 1) - 3} more`
                : label;
              const visibleParallelCount = summarizedLabelCount(lane?.parallelCount ?? 1);
              const largestDisplayedStack = Math.max(
                visibleParallelCount,
                summarizedLabelCount(lane?.oppositeCount ?? 0),
              );
              const curveOffset = reciprocalCurveOffset(
                source,
                target,
                (lane?.oppositeCount ?? 0) > 0,
                largestDisplayedStack,
              );
              const stackOffset = ((lane?.parallelIndex ?? 0) - (visibleParallelCount - 1) / 2)
                * EDGE_LABEL_STACK_SPACING;
              const position = edgeLabelPosition(source, target, curveOffset, stackOffset);
              return <text key={`${edge.source}:${edge.target}:${edge.kind}:${edge.label}:${index}:label`} x={position.x} y={position.y}>{visibleLabel}</text>;
            })}
          </g>
          <g className="history-graph-nodes">
            {nodes.map((node) => (
              <g
                key={node.id}
                className={`history-graph-node ${node.kind === "episode" ? "entry" : node.kind}${node.kind === "entity" && !isRaw ? ` entity-${node.entity_category ?? "thing"}` : ""}${node.hop === 0 ? " selected-memory" : ""}${focusedNodeId === node.id ? " focused" : ""}`}
                transform={`translate(${node.x} ${node.y})`}
                onDoubleClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onNodeDoubleClick?.(node);
                }}
                onPointerDown={(event) => {
                  if (event.button !== 0) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.setPointerCapture(event.pointerId);
                  nodeDragRef.current = { pointerId: event.pointerId, nodeId: node.id };
                  energyRef.current = 0.25;
                  restartSimulationRef.current();
                }}
                onPointerMove={(event) => {
                  const drag = nodeDragRef.current;
                  const svg = svgRef.current;
                  if (!drag || drag.pointerId !== event.pointerId || drag.nodeId !== node.id || !svg) return;
                  event.preventDefault();
                  event.stopPropagation();
                  const point = graphPoint(event.clientX, event.clientY, svg, viewBox);
                  const current = nodesRef.current.find((candidate) => candidate.id === node.id);
                  if (!current) return;
                  current.x = point.x;
                  current.y = point.y;
                  current.vx = 0;
                  current.vy = 0;
                  setNodes(nodesRef.current.map((candidate) => ({ ...candidate })));
                }}
                onPointerUp={(event) => {
                  const drag = nodeDragRef.current;
                  if (!drag || drag.pointerId !== event.pointerId || drag.nodeId !== node.id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  event.currentTarget.releasePointerCapture(event.pointerId);
                  pinnedNodeIdsRef.current.add(node.id);
                  nodeDragRef.current = null;
                  energyRef.current = 0.35;
                  restartSimulationRef.current();
                }}
                onPointerCancel={() => {
                  nodeDragRef.current = null;
                  energyRef.current = 0.35;
                  restartSimulationRef.current();
                }}
              >
                <GraphNodeGlyph
                  kind={node.kind}
                  entityCategory={node.entity_category}
                  radius={episodeGraphNodeRadius(node)}
                  raw={isRaw}
                />
                <text x={0} y={episodeGraphNodeRadius(node) + 18}>{node.label}</text>
              </g>
            ))}
          </g>
          <g className="history-graph-edge-details">
            {preview.edges.map((edge, index) => {
              const lane = edgeLanes[index];
              if (!lane || lane.parallelIndex !== 0 || hoveredEdgeDirection !== lane.key) return null;
              const source = byId.get(edge.source);
              const target = byId.get(edge.target);
              if (!source || !target) return null;
              const hiddenLabels = preview.edges
                .filter((candidate) => edgeDirectionKey(candidate.source, candidate.target) === lane.key)
                .map(visibleEdgeLabel)
                .filter(Boolean)
                .slice(3);
              if (hiddenLabels.length === 0) return null;
              const panel = edgeDetailsPosition(source, target, hiddenLabels.length, width, height);
              return (
                <foreignObject
                  key={`${lane.key}:details`}
                  className="history-graph-edge-details"
                  {...panel}
                  onMouseEnter={() => showEdgeDetails(lane.key)}
                  onMouseLeave={() => scheduleEdgeDetailsClose(lane.key)}
                >
                  <div className="history-graph-edge-details-window" role="tooltip" aria-label="Additional relationships">
                    <strong>{`${hiddenLabels.length} more relationship${hiddenLabels.length === 1 ? "" : "s"}`}</strong>
                    <div className="history-graph-edge-details-list">
                      {hiddenLabels.map((hiddenLabel, hiddenIndex) => (
                        <span
                          key={`${lane.key}:${hiddenLabel}:${hiddenIndex}:detail`}
                          className="history-graph-edge-details-row"
                        >
                          {hiddenLabel}
                        </span>
                      ))}
                    </div>
                  </div>
                </foreignObject>
              );
            })}
          </g>
        </svg>
      </div>
      {nodes.length === 1 && <div className="memory-lightbox-graph-empty">No connections yet</div>}
    </section>
  );
}
