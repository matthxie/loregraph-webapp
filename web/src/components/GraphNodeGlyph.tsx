import React from "react";
import type { EntityCategory, EpisodeGraphNodeKind } from "../shared/protocol";

export function graphNodeOutlineRadius(kind: EpisodeGraphNodeKind | "entry", radius: number): number {
  return kind === "episode" || kind === "entry" ? 13.5 : radius + 2.5;
}

export function GraphNodeGlyph({
  kind,
  entityCategory = "thing",
  radius,
  raw = false,
}: {
  kind: EpisodeGraphNodeKind | "entry";
  entityCategory?: EntityCategory | null;
  radius: number;
  /** Dev raw view: draw every non-episode node as a plain kind-colored circle rather than
   *  a person/place/thing/concept glyph, so the raw store node types read distinctly. */
  raw?: boolean;
}) {
  const outlineRadius = graphNodeOutlineRadius(kind, radius);
  const outline = <circle className="history-graph-node-outline" r={outlineRadius} aria-hidden />;
  if (kind === "episode" || kind === "entry") {
    return <>{outline}<circle className="history-graph-node-core" r={radius} /></>;
  }
  if (raw) {
    return <>{outline}<circle className="history-graph-node-core" r={radius} /></>;
  }

  const scale = radius / 11;
  if (kind === "concept") {
    return (
      <>{outline}<g className="history-graph-node-core" transform={`scale(${scale})`}>
          <path d="M-6.5 5.6C-11 4.8-11.2-.5-8-2.8C-8.2-6-4.7-8.4-1.3-6.9C1.4-9 6.2-7.5 6.7-4C10.7-3.2 11.5 2.3 7 4C7.2 7.8 2.8 9.1.1 7C-2.4 9-6 8.5-6.5 5.6Z" />
        </g></>
    );
  }

  if (entityCategory === "person") {
    const personScale = radius / 13;
    return (
      <>{outline}<g className="history-graph-node-core history-graph-person-glyph" transform={`scale(${personScale})`}>
          <path d="M0-10A4.75 4.75 0 1 1 0-.5 4.75 4.75 0 0 1 0-10ZM-10 9A10 10 0 0 1 10 9Z" />
        </g></>
    );
  }

  if (entityCategory === "place") {
    const placeScale = radius / 13;
    return (
      <>{outline}<g className="history-graph-node-core history-graph-place-glyph" transform={`scale(${placeScale})`}>
          <path d="M0 9H-10V0L0-9 10 0V9H0" />
          <path className="history-graph-glyph-detail history-graph-place-detail" d="M-3 9V3H3V9" />
        </g></>
    );
  }

  return (
    <>{outline}<g className="history-graph-node-core history-graph-thing-glyph" transform={`scale(${scale})`}>
        <path d="M0-10.392 9-5.196V5.196L0 10.392-9 5.196V-5.196Z" />
        <path className="history-graph-glyph-detail history-graph-cube-detail" d="M-9-5.196 0 0l9-5.196M0 0v10.392" />
      </g></>
  );
}
