/**
 * Removable attachment chips under the capture composer: image thumbnail or a
 * file glyph, middle-truncated name, byte size, and an × to remove. Shared by the in-window
 * Write page (the quick-capture tray panel renders equivalent chips in plain DOM).
 */
import React from "react";
import type { DraftAttachment } from "../shared/api";
import { formatBytes, middleTruncate } from "../lib/attachments";

export function AttachmentChips({
  attachments,
  onRemove,
  disabled,
}: {
  attachments: DraftAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachment-chips" aria-label="attachment-chips">
      {attachments.map((a) => (
        <div key={a.id} className="attach-chip">
          {a.isImage && a.url ? (
            <img src={a.url} alt="" />
          ) : (
            <span className="glyph" aria-hidden>
              📄
            </span>
          )}
          <span className="meta">
            <span className="name">{middleTruncate(a.name)}</span>
            <span className="size tertiary">{formatBytes(a.size)}</span>
          </span>
          <button
            className="remove"
            aria-label={`remove-attachment-${a.id}`}
            disabled={disabled}
            onClick={(e) => {
              e.stopPropagation();
              onRemove(a.id);
            }}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
