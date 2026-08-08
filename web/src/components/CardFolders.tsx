/**
 * The card's filing line — "in bio, class, +2 more" — sitting above everything else on the
 * card, so the board tells you where each memory lives without opening it. Four or more
 * folders collapse to the first two plus a "+N more" count; long names ellipsize (the CSS
 * shrinks the names, never the count) so the line always fits the card's width on one row.
 */
import React from "react";

/** Names shown in full before the line collapses to "first two + N more". */
const MAX_NAMES = 3;

export function CardFolders({ names }: { names: readonly string[] }) {
  if (names.length === 0) return null;
  const shown = names.length > MAX_NAMES ? names.slice(0, 2) : names;
  const extra = names.length - shown.length;
  return (
    <div className="card-folders" aria-label={`card-folders-${names.join(",")}`}>
      <span className="card-folders-in">in</span>
      {/* The comma rides INSIDE the ellipsized span: a truncated name ends in "…" (which already
          says "there's more"), and a name that fits keeps its punctuation tight against it —
          a separate comma element would float a gap away from a truncated name. */}
      {shown.map((name, index) => (
        <span className="card-folders-name" key={name.toLowerCase()}>
          {index < shown.length - 1 || extra > 0 ? `${name},` : name}
        </span>
      ))}
      {extra > 0 && <span className="card-folders-more">+{extra} more</span>}
    </div>
  );
}
