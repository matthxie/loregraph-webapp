/**
 * The per-card dev view (Settings › Developer › "Dev view on cards", gated by
 * lib/devTools.ts `cardDevViews`): what the extraction actually pulled out of this note — its
 * summary, entities, concepts, tags — and the raw store subgraph the ingest created for it.
 *
 * Everything here reads fields `episodes.list` already ships on the row (PROTOCOL §7.2), so
 * turning the panel on costs no extra RPC: entities/concepts are their own row fields, the
 * tags come out of `graph_preview` (whose `tag` nodes are the only place the wire carries
 * them), and the summary is `description` — the extraction's own account of an attached image
 * or a resolved link, which the board otherwise never shows.
 */
import React, { useMemo, useState } from "react";
import type { EpisodeListRow } from "../shared/protocol";
import { EpisodeGraphPreview } from "./EpisodeGraphPreview";

/**
 * The graph's layout box in viewBox units — much tighter than the overlay default, because a
 * card is ~300px wide and the SVG scales to fit: the wider the box, the smaller the labels.
 */
const GRAPH_WIDTH = 560;
const GRAPH_HEIGHT = 420;

/** Tag lists run long (a 20-word note can carry 25 tags); the rest are one click away. */
const CHIP_LIMIT = 12;

/**
 * Node labels are truncated for the card graph. The episode node's label is the whole note, and
 * at this size it draws straight out of the box — the overlay could afford to spell it out, a
 * card cannot. The node keeps its full text in the layout's collision maths either way.
 */
const LABEL_LIMIT = 26;

function truncateLabels(preview: NonNullable<EpisodeListRow["graph_preview"]>) {
  return {
    ...preview,
    nodes: preview.nodes.map((node) => (
      node.label.length > LABEL_LIMIT
        ? { ...node, label: `${node.label.slice(0, LABEL_LIMIT - 1).trimEnd()}…` }
        : node
    )),
  };
}

function ChipList({ label, items, titles }: {
  label: string;
  items: readonly string[];
  /** Optional per-chip hover text, e.g. an entity's semantic type. */
  titles?: Record<string, string | undefined>;
}) {
  const [expanded, setExpanded] = useState(false);
  if (items.length === 0) return null;
  const shown = expanded ? items : items.slice(0, CHIP_LIMIT);
  const hidden = items.length - shown.length;
  return (
    <div className="card-dev-group" aria-label={`${label.toLocaleLowerCase()}-list`}>
      <h4>
        {label} <span className="card-dev-count">{items.length}</span>
      </h4>
      <ul>
        {shown.map((item) => (
          <li key={item} title={titles?.[item]}>{item}</li>
        ))}
        {hidden > 0 && (
          <li>
            <button type="button" className="card-dev-more" onClick={() => setExpanded(true)}>
              +{hidden} more
            </button>
          </li>
        )}
      </ul>
    </div>
  );
}

/** Distinct `tag` node labels from the episode's own subgraph, in the order the engine emitted. */
export function graphTags(preview: EpisodeListRow["graph_preview"]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const node of preview?.nodes ?? []) {
    if (node.kind !== "tag") continue;
    const label = node.label.trim();
    const key = label.toLocaleLowerCase();
    if (!label || seen.has(key)) continue;
    seen.add(key);
    tags.push(label);
  }
  return tags;
}

export function CardDevView({ row }: { row: EpisodeListRow }) {
  const preview = useMemo(
    () => (row.graph_preview ? truncateLabels(row.graph_preview) : undefined),
    [row.graph_preview],
  );
  const entities = row.entities ?? [];
  const concepts = row.concepts ?? [];
  const summary = (row.description ?? "").trim();
  // From the untruncated row: a chip has room for the whole tag, only the graph does not.
  const tags = useMemo(() => graphTags(row.graph_preview), [row.graph_preview]);
  const entityTitles = useMemo(() => {
    const categories = row.entity_categories ?? {};
    return Object.fromEntries(entities.map((name) => [name, categories[name]]));
  }, [entities, row.entity_categories]);
  const nothingExtracted = !summary && entities.length === 0 && concepts.length === 0
    && tags.length === 0;

  return (
    <section className="card-dev-view dev-view" aria-label={`dev-view-${row.id}`}>
      <span className="dev-view-badge">dev view</span>
      <div className="card-dev-groups">
        {summary && (
          <div className="card-dev-group" aria-label="summary">
            <h4>Summary</h4>
            <p className="card-dev-summary">{summary}</p>
          </div>
        )}
        <ChipList label="Entities" items={entities} titles={entityTitles} />
        <ChipList label="Concepts" items={concepts} />
        <ChipList label="Tags" items={tags} />
        {nothingExtracted && <p className="card-dev-empty">Nothing extracted</p>}
      </div>
      {preview && preview.nodes.length > 0 && (
        <div className="card-dev-graph">
          <EpisodeGraphPreview
            preview={preview}
            width={GRAPH_WIDTH}
            height={GRAPH_HEIGHT}
            label="Graph for this memory"
          />
        </div>
      )}
    </section>
  );
}
