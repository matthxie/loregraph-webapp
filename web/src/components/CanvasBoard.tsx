/**
 * Free-form canvas collection: saves are dragged wherever you want, with lines, arrows,
 * rects and ellipses drawn between them.
 *
 * The document is loaded once per collection and saved on a debounce — a drag fires a state
 * change per frame, and each save is a whole-document write.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CanvasDocument, CanvasShape, CanvasShapeKind } from "../shared/api";
import type { EpisodeListRow } from "../shared/protocol";
import { markdownToSnippet, previewText } from "../lib/format";
import { spotNames, stripTags, type UserTagMap } from "../lib/tags";
import {
  CANVAS_COLORS,
  CARD_H,
  CARD_W,
  clampZoom,
  emptyCanvas,
  isDegenerate,
  makeShape,
  placeMissing,
  pruneItems,
  roundDocument,
  shapeAt,
  shapeBounds,
  toCanvasPoint,
} from "../lib/canvas";

const SAVE_DEBOUNCE_MS = 1200;

type Tool = "select" | CanvasShapeKind;

const TOOLS: ReadonlyArray<{ id: Tool; label: string }> = [
  { id: "select", label: "Select" },
  { id: "line", label: "Line" },
  { id: "arrow", label: "Arrow" },
  { id: "rect", label: "Rectangle" },
  { id: "ellipse", label: "Ellipse" },
];

function ToolGlyph({ tool }: { tool: Tool }) {
  if (tool === "select") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 3l10 6.5-4.4 1.1L8.9 15z" /></svg>;
  }
  if (tool === "line") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4 16 16 4" /></svg>;
  }
  if (tool === "arrow") {
    return (
      <svg viewBox="0 0 20 20" aria-hidden="true">
        <path d="M4 16 16 4M10 4h6v6" />
      </svg>
    );
  }
  if (tool === "rect") {
    return <svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3.5" y="5.5" width="13" height="9" /></svg>;
  }
  return <svg viewBox="0 0 20 20" aria-hidden="true"><ellipse cx="10" cy="10" rx="6.5" ry="4.5" /></svg>;
}

/** One rendered shape. Arrow heads are drawn inline so no marker defs are needed. */
function Shape({ shape, selected }: { shape: CanvasShape; selected: boolean }) {
  const stroke = CANVAS_COLORS[shape.color] ?? CANVAS_COLORS[0];
  const common = {
    stroke,
    strokeWidth: shape.width,
    fill: "none",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    className: selected ? "canvas-shape selected" : "canvas-shape",
  };
  if (shape.kind === "line" || shape.kind === "arrow") {
    const angle = Math.atan2(shape.y2 - shape.y1, shape.x2 - shape.x1);
    const head = 10 + shape.width * 2;
    const spread = 0.42;
    return (
      <g>
        <line x1={shape.x1} y1={shape.y1} x2={shape.x2} y2={shape.y2} {...common} />
        {shape.kind === "arrow" && (
          <polyline
            points={[
              [shape.x2 - head * Math.cos(angle - spread), shape.y2 - head * Math.sin(angle - spread)],
              [shape.x2, shape.y2],
              [shape.x2 - head * Math.cos(angle + spread), shape.y2 - head * Math.sin(angle + spread)],
            ]
              .map(([x, y]) => `${x},${y}`)
              .join(" ")}
            {...common}
          />
        )}
      </g>
    );
  }
  const { x, y, w, h } = shapeBounds(shape);
  if (shape.kind === "rect") return <rect x={x} y={y} width={w} height={h} rx={4} {...common} />;
  return <ellipse cx={x + w / 2} cy={y + h / 2} rx={w / 2} ry={h / 2} {...common} />;
}

export function CanvasBoard({
  collection,
  episodeIds,
  rows,
  tags,
}: {
  collection: string;
  /** Episode ids filed into this collection, from the tag map. */
  episodeIds: string[];
  /** Rows for those episodes, so cards can show their text. */
  rows: Map<string, EpisodeListRow>;
  /** Filed folder names per episode — stripped from the card text, as on the grid. */
  tags: UserTagMap;
}) {
  const [doc, setDoc] = useState<CanvasDocument | null>(null);
  const [tool, setTool] = useState<Tool>("select");
  const [color, setColor] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const etag = useRef<string | null>(null);
  const surface = useRef<HTMLDivElement | null>(null);
  const dirty = useRef(false);
  const saveTimer = useRef<number | null>(null);
  /** The interaction in flight: dragging a card, drawing a shape, or panning. */
  const drag = useRef<
    | { kind: "item"; id: string; dx: number; dy: number }
    | { kind: "draw"; id: string }
    | { kind: "pan"; startX: number; startY: number; viewX: number; viewY: number }
    | null
  >(null);

  // What the saver reads, so `flush` can stay identity-stable. A flush recreated per edit would
  // make the unmount effect below fire on every edit, and those racing saves reject each other
  // on a stale etag ("canvas changed elsewhere"). `collectionRef` is set in the load effect, not
  // during render, so a cleanup running on a collection switch still sees the one it must save.
  const docRef = useRef<CanvasDocument | null>(null);
  docRef.current = doc;
  const collectionRef = useRef(collection);
  const saving = useRef(false);

  const flush = useCallback(async () => {
    const current = docRef.current;
    const target = collectionRef.current;
    if (!dirty.current || !current || saving.current) return;
    saving.current = true;
    dirty.current = false;
    try {
      const result = await window.graph.canvasSave(target, roundDocument(current), etag.current);
      if (collectionRef.current !== target) return; // switched away mid-save; it owns the etag now
      etag.current = result.etag;
      setError(null);
      // Edits that arrived mid-save missed this write.
      if (dirty.current && saveTimer.current === null) {
        saveTimer.current = window.setTimeout(() => {
          saveTimer.current = null;
          void flushRef.current();
        }, SAVE_DEBOUNCE_MS);
      }
    } catch (cause) {
      // Leave it dirty so the next edit retries rather than dropping the work.
      dirty.current = true;
      setError((cause as Error).message);
    } finally {
      saving.current = false;
    }
  }, []);
  const flushRef = useRef(flush);
  flushRef.current = flush;

  // Load once per collection, saving whatever the previous one still owed.
  useEffect(() => {
    let alive = true;
    void flush();
    collectionRef.current = collection;
    dirty.current = false;
    etag.current = null;
    setDoc(null);
    void window.graph
      .canvasGet(collection)
      .then((loaded) => {
        if (!alive) return;
        etag.current = loaded.etag;
        setDoc(loaded.doc);
      })
      .catch((cause: Error) => {
        if (!alive) return;
        setError(cause.message);
        setDoc(emptyCanvas());
      });
    return () => {
      alive = false;
    };
  }, [collection, flush]);

  // Saves filed here since the last visit need a home; ones that left lose theirs. Depends on
  // `doc` too — the load usually lands after the ids, and placing only on an id change would
  // leave a freshly-loaded canvas with nothing on it. Both helpers return the same object when
  // there is nothing to do, so this settles in one pass.
  useEffect(() => {
    if (!doc) return;
    const next = pruneItems(placeMissing(doc, episodeIds), episodeIds);
    if (next === doc) return;
    dirty.current = true;
    setDoc(next);
  }, [doc, episodeIds]);

  // Debounced autosave: a drag changes state every frame and each save is a whole document.
  useEffect(() => {
    if (!dirty.current || !doc) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void flush();
    }, SAVE_DEBOUNCE_MS);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [doc, flush]);

  // Leaving the canvas must not lose the last edit.
  useEffect(() => () => {
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    void flush();
  }, [flush]);

  const edit = useCallback((change: (current: CanvasDocument) => CanvasDocument) => {
    setDoc((current) => {
      if (!current) return current;
      const next = change(current);
      if (next !== current) dirty.current = true;
      return next;
    });
  }, []);

  const pointAt = useCallback(
    (event: { clientX: number; clientY: number }) => {
      const rect = surface.current?.getBoundingClientRect() ?? { left: 0, top: 0 };
      return toCanvasPoint(event.clientX, event.clientY, rect, doc?.view ?? { x: 0, y: 0, zoom: 1 });
    },
    [doc?.view],
  );

  const onPointerDown = (event: React.PointerEvent) => {
    if (!doc || event.button !== 0) return;
    const point = pointAt(event);
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);

    if (tool !== "select") {
      const shape = makeShape(tool, point.x, point.y, color, 3);
      drag.current = { kind: "draw", id: shape.id };
      setSelected(shape.id);
      edit((current) => ({ ...current, shapes: [...current.shapes, shape] }));
      return;
    }

    const hit = shapeAt(doc.shapes, point.x, point.y);
    if (hit) {
      setSelected(hit.id);
      return;
    }
    setSelected(null);
    drag.current = {
      kind: "pan",
      startX: event.clientX,
      startY: event.clientY,
      viewX: doc.view.x,
      viewY: doc.view.y,
    };
  };

  const onPointerMove = (event: React.PointerEvent) => {
    const active = drag.current;
    if (!active || !doc) return;
    if (active.kind === "pan") {
      const dx = (event.clientX - active.startX) / doc.view.zoom;
      const dy = (event.clientY - active.startY) / doc.view.zoom;
      // Panning is viewport state, not content — it saves, but it isn't an edit worth
      // marking dirty on its own.
      setDoc((current) =>
        current
          ? { ...current, view: { ...current.view, x: active.viewX - dx, y: active.viewY - dy } }
          : current,
      );
      return;
    }
    const point = pointAt(event);
    if (active.kind === "draw") {
      edit((current) => ({
        ...current,
        shapes: current.shapes.map((shape) =>
          shape.id === active.id ? { ...shape, x2: point.x, y2: point.y } : shape,
        ),
      }));
      return;
    }
    edit((current) => ({
      ...current,
      items: current.items.map((item) =>
        item.id === active.id ? { ...item, x: point.x - active.dx, y: point.y - active.dy } : item,
      ),
    }));
  };

  const onPointerUp = () => {
    const active = drag.current;
    drag.current = null;
    if (active?.kind !== "draw") return;
    // A click with a drawing tool selected isn't a shape.
    edit((current) => ({
      ...current,
      shapes: current.shapes.filter((shape) => shape.id !== active.id || !isDegenerate(shape)),
    }));
    setTool("select");
  };

  const startItemDrag = (event: React.PointerEvent, id: string) => {
    if (!doc || tool !== "select" || event.button !== 0) return;
    event.stopPropagation();
    const item = doc.items.find((candidate) => candidate.id === id);
    if (!item) return;
    const point = pointAt(event);
    (event.currentTarget.parentElement as HTMLElement)?.setPointerCapture(event.pointerId);
    drag.current = { kind: "item", id, dx: point.x - item.x, dy: point.y - item.y };
    setSelected(null);
    // Bring it to the front; a dragged card should not slide under its neighbours.
    edit((current) => {
      const topZ = current.items.reduce((max, candidate) => Math.max(max, candidate.z), 0);
      return {
        ...current,
        items: current.items.map((candidate) =>
          candidate.id === id ? { ...candidate, z: topZ + 1 } : candidate,
        ),
      };
    });
  };

  const onWheel = (event: React.WheelEvent) => {
    if (!doc) return;
    const rect = surface.current?.getBoundingClientRect();
    if (!rect) return;
    const zoom = clampZoom(doc.view.zoom * (event.deltaY < 0 ? 1.08 : 1 / 1.08));
    // Keep the point under the cursor still.
    const cx = event.clientX - rect.left;
    const cy = event.clientY - rect.top;
    setDoc((current) =>
      current
        ? {
            ...current,
            view: {
              zoom,
              x: current.view.x + cx / current.view.zoom - cx / zoom,
              y: current.view.y + cy / current.view.zoom - cy / zoom,
            },
          }
        : current,
    );
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Backspace" && event.key !== "Delete") return;
      if (!selected) return;
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      event.preventDefault();
      edit((current) => ({
        ...current,
        shapes: current.shapes.filter((shape) => shape.id !== selected),
      }));
      setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, edit]);

  const ordered = useMemo(
    () => (doc ? [...doc.items].sort((a, b) => a.z - b.z) : []),
    [doc],
  );

  if (!doc) return <p className="muted canvas-loading">Loading canvas…</p>;

  const { view } = doc;

  return (
    <div className="canvas-board">
      <div className="canvas-tools" role="toolbar" aria-label="Canvas tools">
        {TOOLS.map((entry) => (
          <button
            type="button"
            key={entry.id}
            className={`canvas-tool${tool === entry.id ? " active" : ""}`}
            aria-label={entry.label}
            aria-pressed={tool === entry.id}
            title={entry.label}
            onClick={() => setTool(entry.id)}
          >
            <ToolGlyph tool={entry.id} />
          </button>
        ))}
        <span className="canvas-tools-divider" aria-hidden="true" />
        {CANVAS_COLORS.map((value, index) => (
          <button
            type="button"
            key={value}
            className={`canvas-swatch${color === index ? " active" : ""}`}
            aria-label={`Colour ${index + 1}`}
            aria-pressed={color === index}
            style={{ background: value }}
            onClick={() => setColor(index)}
          />
        ))}
      </div>

      {error && <p className="error-text canvas-error">{error}</p>}

      <div
        ref={surface}
        className={`canvas-surface tool-${tool}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="canvas-content"
          style={{
            transform: `scale(${view.zoom}) translate(${-view.x}px, ${-view.y}px)`,
            transformOrigin: "0 0",
          }}
        >
          <svg className="canvas-shapes" aria-hidden="true">
            {doc.shapes.map((shape) => (
              <Shape key={shape.id} shape={shape} selected={selected === shape.id} />
            ))}
          </svg>
          {ordered.map((item) => {
            const row = rows.get(item.id);
            return (
              <div
                key={item.id}
                className="canvas-card"
                data-episode-id={item.id}
                aria-label={`canvas-card-${item.id}`}
                style={{ left: item.x, top: item.y, width: item.w, minHeight: item.h, zIndex: item.z }}
                onPointerDown={(event) => startItemDrag(event, item.id)}
              >
                <div className="canvas-card-body">
                  {row
                    ? previewText(
                        markdownToSnippet(stripTags(row.raw_text ?? "", spotNames(tags[row.id]))) ||
                          "Untitled input",
                      )
                    : "…"}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <p className="canvas-hint muted">
        Drag to pan · scroll to zoom · pick a tool to draw · Delete removes a selected shape
      </p>
    </div>
  );
}
