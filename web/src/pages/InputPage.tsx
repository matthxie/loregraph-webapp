/** Write is a continuous notepad with images and file attachments inserted into the writing flow. */
import React, { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { usageLimitMessage, type DraftAttachment } from "../shared/api";
import {
  dragHasFiles,
  filesToDraftInputs,
  formatBytes,
  middleTruncate,
  missingAttachmentIdsFromSync,
} from "../lib/attachments";
import {
  addUserTag,
  applyTagSuggestion,
  parseTags,
  peekPendingFiling,
  pushPendingFiling,
  stripTags,
  tagSuggestions,
  updateUserTags,
  useKnownTags,
} from "../lib/tags";
import { encodePcm16Wav, resamplePcm } from "../lib/voiceWav";
import { startVoiceCapture, type VoiceCapture } from "../lib/voiceRecorder";
import { ChatAnswer } from "../components/ChatAnswer";

export interface TextNode {
  type: "text";
  id: string;
  text: string;
}

export interface AttachmentNode {
  type: "attachment";
  id: string;
  attachmentId: string;
  /** Stable block identity for zero-width media-only episodes. */
  episodeId?: string;
}

export type NoteNode = TextNode | AttachmentNode;

interface PersistedWriteDocument {
  version: 2;
  text: string;
  nodes: NoteNode[];
  attachments: DraftAttachment[];
  markers: BlockMarker[];
  episodes: EpisodeRecord[];
  updatedAt: number;
}

interface InsertionPoint {
  nodeId: string;
  offset: number;
}

export interface ParsedEpisode {
  id: string;
  text: string;
  start: number;
  end: number;
  attachmentIds: string[];
}

export interface BlockMarker {
  id: string;
  offset: number;
  /** Right-affinity position of the text this UUID belongs to; may sit inside its block. */
  anchor: number;
}

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface EpisodeRecord {
  id: string;
  text: string;
  submittedText: string | null;
  processedText: string | null;
  attachmentIds: string[];
  submittedAttachmentIds: string[] | null;
  processedAttachmentIds: string[] | null;
  status: "processing" | "done" | "failed";
  spoolId: string | null;
  episodeId: string | null;
  inFlight: boolean;
  operation: "capture" | "reingest" | "delete" | null;
  operationId: string | null;
  present: boolean;
  changedAt: number;
  error?: string;
}

export interface PendingWriteEntry {
  id: string;
  /** Existing card temporarily replaced by this pending reingest. */
  replacesEpisodeId?: string | null;
  text: string;
  attachmentCount: number;
  attachments: Array<{
    size: number;
    isImage: boolean;
    aspectRatio: number | null;
  }>;
  status: "processing" | "done" | "failed";
  episodeId: string | null;
  createdAt: number;
  spoolId?: string | null;
  /** Keep a deleted in-flight capture as a non-rendered tombstone until discard settles. */
  hidden?: boolean;
  /** Mutate the authored block even while its current queue operation is settling. */
  onEdit?: (text: string) => void | Promise<void>;
  /** Remove now; the operation tracker ensures an already-committed result is also deleted. */
  onDelete?: () => void | Promise<void>;
}

interface MarkerPosition {
  top: number;
  left: number;
}

const LAYOUT_KEY = "graph.write.inline-layout.v1";
const EPISODES_KEY = "graph.write.episode-status.v1";
const BLOCK_MARKERS_KEY = "graph.write.block-markers.v1";
const WRITE_DOCUMENT_KEY = "graph.write.document.v2";
const EPISODE_MARKER_SIZE = 22;
const DRAFT_LINE_BREAK = "\u2028";
const newId = () => globalThis.crypto.randomUUID();
const newTextNode = (text = ""): TextNode => ({ type: "text", id: newId(), text });

function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6.5" />
      <path d="m15.5 15.5 4.5 4.5" />
    </svg>
  );
}

function ChatGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M20 12.5a5.5 5.5 0 0 1-5.5 5.5H9l-4 3v-3.7A5.5 5.5 0 0 1 4 12.5v-1A5.5 5.5 0 0 1 9.5 6h5A5.5 5.5 0 0 1 20 11.5z" />
    </svg>
  );
}

function MicrophoneGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="8" y="3" width="8" height="12" rx="4" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" />
    </svg>
  );
}

function ReturnGlyph() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path d="M17.5 5.5v6a3 3 0 0 1-3 3H7" />
      <path d="m10.5 10.5-4 4 4 4" />
    </svg>
  );
}

/** Outline folder — the shared mark for spots (filing note, `/` popup). Styled by .folder-glyph. */
function FolderGlyph() {
  return (
    <svg className="folder-glyph" viewBox="0 0 24 24" aria-hidden>
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function encodeDraftText(text: string): string {
  return text.replaceAll("\n", DRAFT_LINE_BREAK);
}

function decodeDraftText(text: string): string {
  return text.replaceAll(DRAFT_LINE_BREAK, "\n");
}

function textOf(nodes: NoteNode[]): string {
  return nodes.filter((node): node is TextNode => node.type === "text").map((node) => node.text).join("");
}

function normalizeEpisodeRecords(records: unknown): EpisodeRecord[] {
  if (!Array.isArray(records)) return [];
  return records.flatMap((value): EpisodeRecord[] => {
    if (!value || typeof value !== "object") return [];
    const record = value as Partial<EpisodeRecord>;
    if (typeof record.id !== "string" || typeof record.text !== "string") return [];
    const status = record.status === "done" || record.status === "failed" ? record.status : "processing";
    return [{
      id: record.id,
      text: record.text,
      submittedText: typeof record.submittedText === "string" ? record.submittedText : null,
      processedText:
        typeof record.processedText === "string"
          ? record.processedText
          : status === "done"
            ? record.text
            : null,
      attachmentIds: Array.isArray(record.attachmentIds)
        ? record.attachmentIds.filter((id): id is string => typeof id === "string")
        : [],
      submittedAttachmentIds: Array.isArray(record.submittedAttachmentIds)
        ? record.submittedAttachmentIds.filter((id): id is string => typeof id === "string")
        : null,
      processedAttachmentIds: Array.isArray(record.processedAttachmentIds)
        ? record.processedAttachmentIds.filter((id): id is string => typeof id === "string")
        : record.status === "done"
          ? []
          : null,
      status,
      spoolId: typeof record.spoolId === "string" ? record.spoolId : null,
      episodeId: typeof record.episodeId === "string" ? record.episodeId : null,
      // An unacknowledged operation is retried with its persisted idempotency key after reload.
      inFlight: false,
      operation:
        record.operation === "capture" || record.operation === "reingest" || record.operation === "delete"
          ? record.operation
          : record.inFlight === true
            ? record.present === false
              ? "delete"
              : typeof record.episodeId === "string"
                ? "reingest"
                : "capture"
            : null,
      operationId: typeof record.operationId === "string" ? record.operationId : null,
      present: record.present ?? true,
      changedAt: typeof record.changedAt === "number" ? record.changedAt : Date.now(),
      error: typeof record.error === "string" ? record.error : undefined,
    }];
  });
}

function readWriteDocument(): PersistedWriteDocument | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(WRITE_DOCUMENT_KEY) ?? "null") as Partial<PersistedWriteDocument> | null;
    if (
      parsed?.version !== 2 ||
      typeof parsed.text !== "string" ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.markers)
    ) {
      return null;
    }
    const nodes = parsed.nodes.filter((node): node is NoteNode =>
      Boolean(
        node &&
          typeof node.id === "string" &&
          ((node.type === "text" && typeof node.text === "string") ||
            (node.type === "attachment" && typeof node.attachmentId === "string")),
      ),
    );
    if (textOf(nodes) !== parsed.text) return null;
    const markers = parsed.markers.filter(
      (marker): marker is BlockMarker =>
        Boolean(marker && typeof marker.id === "string" && typeof marker.offset === "number"),
    );
    return {
      version: 2,
      text: parsed.text,
      nodes,
      attachments: Array.isArray(parsed.attachments)
        ? parsed.attachments.filter(
            (attachment): attachment is DraftAttachment =>
              Boolean(
                attachment &&
                  typeof attachment.id === "string" &&
                  typeof attachment.name === "string" &&
                  typeof attachment.size === "number" &&
                  typeof attachment.isImage === "boolean",
              ),
          )
        : [],
      markers: markers.map((marker) => ({ ...marker, anchor: marker.anchor ?? marker.offset })),
      episodes: normalizeEpisodeRecords(parsed.episodes),
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeDocument(
  nodes: NoteNode[],
  markers: BlockMarker[],
  episodes: EpisodeRecord[],
  attachments: DraftAttachment[],
): void {
  const text = textOf(nodes);
  const referencedAttachments = new Set(
    nodes.filter((node): node is AttachmentNode => node.type === "attachment").map((node) => node.attachmentId),
  );
  const document: PersistedWriteDocument = {
    version: 2,
    text,
    nodes,
    attachments: attachments.filter((attachment) => referencedAttachments.has(attachment.id)),
    markers,
    episodes,
    updatedAt: Date.now(),
  };
  try {
    localStorage.setItem(WRITE_DOCUMENT_KEY, JSON.stringify(document));
    // Keep the v1 sidecars current for a one-version rollback; v2 is the authoritative atomic copy.
    sessionStorage.setItem(LAYOUT_KEY, JSON.stringify(nodes));
    sessionStorage.setItem(BLOCK_MARKERS_KEY, JSON.stringify({ text, markers }));
    sessionStorage.setItem(EPISODES_KEY, JSON.stringify(episodes));
  } catch {
    // The note remains editable if browser storage is temporarily unavailable or full.
  }
}

export function episodeRanges(text: string): Array<Omit<ParsedEpisode, "id" | "attachmentIds">> {
  const episodes: Array<Omit<ParsedEpisode, "id" | "attachmentIds">> = [];
  const boundary = /\n[\t ]*\n+/g;
  let start = 0;
  for (const match of text.matchAll(boundary)) {
    const boundaryStart = match.index ?? 0;
    const raw = text.slice(start, boundaryStart);
    const trimmed = raw.trim();
    if (trimmed) {
      const trailing = raw.length - raw.trimEnd().length;
      episodes.push({ text: decodeDraftText(trimmed), start, end: boundaryStart - trailing });
    }
    start = boundaryStart + match[0].length;
  }
  return episodes;
}

export function blockStarts(text: string): number[] {
  const starts = [0];
  for (const match of text.matchAll(/\n[\t ]*\n+/g)) starts.push((match.index ?? 0) + match[0].length);
  return starts;
}

function blockContentEnds(text: string): number[] {
  const ends = [...text.matchAll(/\n[\t ]*\n+/g)].map((match) => match.index ?? 0);
  ends.push(text.length);
  return ends;
}

function blockIndexAt(starts: number[], anchor: number): number {
  for (let index = 0; index < starts.length - 1; index += 1) {
    if (anchor < (starts[index + 1] as number)) return index;
  }
  return starts.length - 1;
}

function nonWhitespaceCount(text: string, start: number, end: number): number {
  let count = 0;
  for (let index = Math.max(0, start); index < Math.min(end, text.length); index += 1) {
    if (/\S/.test(text[index] as string)) count += 1;
  }
  return count;
}

export function normalizeBlockMarkers(text: string, markers: BlockMarker[]): BlockMarker[] {
  const starts = blockStarts(text);
  const assigned = new Map<number, BlockMarker>();
  for (const marker of [...markers].sort((a, b) => a.offset - b.offset)) {
    const anchor = Math.max(0, Math.min(marker.anchor ?? marker.offset, text.length));
    const blockIndex = blockIndexAt(starts, anchor);
    if (!assigned.has(blockIndex)) assigned.set(blockIndex, { ...marker, offset: starts[blockIndex] as number, anchor });
  }
  return starts.map((offset, index) => assigned.get(index) ?? { id: newId(), offset, anchor: offset });
}

function initialBlockMarkers(text: string, records: EpisodeRecord[]): BlockMarker[] {
  const ranges = episodeRanges(text);
  const recordIdsByStart = new Map<number, string>();
  const used = new Set<string>();
  ranges.forEach((range, index) => {
    const exact = records.find(
      (candidate) => candidate.present && !used.has(candidate.id) && candidate.text === range.text,
    );
    const sameIndex = records[index];
    const record = exact ?? (sameIndex && !used.has(sameIndex.id) ? sameIndex : undefined);
    if (record) {
      used.add(record.id);
      recordIdsByStart.set(range.start, record.id);
    }
  });
  return blockStarts(text).map((offset) => ({ id: recordIdsByStart.get(offset) ?? newId(), offset, anchor: offset }));
}

function restoreBlockMarkers(text: string, records: EpisodeRecord[]): BlockMarker[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(BLOCK_MARKERS_KEY) ?? "null") as {
      text?: string;
      markers?: BlockMarker[];
    } | null;
    if (saved?.text === text && Array.isArray(saved.markers)) {
      const migrated = saved.markers.map((marker) => ({ ...marker, anchor: marker.anchor ?? marker.offset }));
      const normalized = normalizeBlockMarkers(text, migrated);
      if (
        normalized.length === saved.markers.length &&
        normalized.every((marker, index) => marker.id === saved.markers?.[index]?.id)
      ) {
        return normalized;
      }
    }
  } catch {
    // Migrate the current visible document below.
  }
  return initialBlockMarkers(text, records);
}

export function transformBlockMarkers(
  oldText: string,
  newText: string,
  markers: BlockMarker[],
  edit?: TextEdit,
): BlockMarker[] {
  if (oldText === newText) return markers;
  const exactEdit =
    edit &&
    edit.from >= 0 &&
    edit.to >= edit.from &&
    edit.to <= oldText.length &&
    `${oldText.slice(0, edit.from)}${edit.insert}${oldText.slice(edit.to)}` === newText
      ? edit
      : undefined;
  let start: number;
  let oldEnd: number;
  let newEnd: number;
  if (exactEdit) {
    start = exactEdit.from;
    oldEnd = exactEdit.to;
    newEnd = exactEdit.from + exactEdit.insert.length;
  } else {
    start = 0;
    while (start < oldText.length && start < newText.length && oldText[start] === newText[start]) start += 1;
    let suffix = 0;
    while (
      suffix < oldText.length - start &&
      suffix < newText.length - start &&
      oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]
    ) {
      suffix += 1;
    }
    oldEnd = oldText.length - suffix;
    newEnd = newText.length - suffix;
  }
  const delta = newEnd - oldEnd;

  const oldStarts = blockStarts(oldText);
  const newStarts = blockStarts(newText);
  const oldContentEnds = blockContentEnds(oldText);
  const newContentEnds = blockContentEnds(newText);
  const normalizedOld = normalizeBlockMarkers(oldText, markers);
  const candidates = normalizedOld.map((marker, oldIndex) => {
    const oldAnchor = marker.anchor ?? marker.offset;
    let anchor: number;
    if (oldAnchor < start) anchor = oldAnchor;
    else if (oldAnchor >= oldEnd) anchor = oldAnchor + delta;
    else anchor = newEnd;

    anchor = Math.max(0, Math.min(anchor, newText.length));
    const blockIndex = blockIndexAt(newStarts, anchor);
    const targetStart = newStarts[blockIndex] as number;
    const targetEnd = newContentEnds[blockIndex] ?? newText.length;
    const oldStart = oldStarts[oldIndex] as number;
    const oldBlockEnd = oldContentEnds[oldIndex] ?? oldText.length;
    let survivingOverlap = 0;

    const beforeEnd = Math.min(oldBlockEnd, start);
    if (beforeEnd > oldStart) {
      const overlapStart = Math.max(oldStart, targetStart);
      const overlapEnd = Math.min(beforeEnd, targetEnd);
      survivingOverlap += nonWhitespaceCount(oldText, overlapStart, overlapEnd);
    }
    const afterStart = Math.max(oldStart, oldEnd);
    if (oldBlockEnd > afterStart) {
      const mappedStart = afterStart + delta;
      const mappedEnd = oldBlockEnd + delta;
      const overlapStart = Math.max(mappedStart, targetStart);
      const overlapEnd = Math.min(mappedEnd, targetEnd);
      survivingOverlap += nonWhitespaceCount(oldText, overlapStart - delta, overlapEnd - delta);
    }

    return {
      marker: { ...marker, offset: targetStart, anchor },
      blockIndex,
      oldIndex,
      survivingOverlap,
    };
  });

  return newStarts.map((offset, blockIndex) => {
    const contenders = candidates
      .filter((candidate) => candidate.blockIndex === blockIndex)
      .sort((left, right) => {
        const leftSurvives = left.survivingOverlap > 0 ? 1 : 0;
        const rightSurvives = right.survivingOverlap > 0 ? 1 : 0;
        return rightSurvives - leftSurvives || left.oldIndex - right.oldIndex;
      });
    const winner = contenders[0];
    return winner ? { ...winner.marker, offset } : { id: newId(), offset, anchor: offset };
  });
}

export function completedEpisodes(text: string, markers: BlockMarker[]): ParsedEpisode[] {
  const markerAt = new Map(markers.map((marker) => [marker.offset, marker.id]));
  return episodeRanges(text).flatMap((range): ParsedEpisode[] => {
    const id = markerAt.get(range.start);
    return id ? [{ ...range, id, attachmentIds: [] }] : [];
  });
}

function attachmentTextContext(nodes: NoteNode[], nodeIndex: number): {
  previousText: string;
  followingText: string;
} {
  return {
    // Attachments have zero textual width. Empty text nodes between co-located attachments must
    // not hide a caption farther along the same visual row, or an earlier attachment is
    // incorrectly classified as a completed media-only episode while that caption is active.
    previousText: textOf(nodes.slice(0, nodeIndex)),
    followingText: textOf(nodes.slice(nodeIndex + 1)),
  };
}

function followsBlankLineBoundary(text: string): boolean {
  return text.length === 0 || /\n[\t ]*\n+$/.test(text);
}

function beginsBlankLineBoundary(text: string): boolean {
  return /^\n[\t ]*\n+/.test(text);
}

/** A media node after a separator stays its own active block until caption text is entered. */
function isStandaloneMediaBlock(node: AttachmentNode, previousText: string, followingText: string): boolean {
  return Boolean(node.episodeId) &&
    followsBlankLineBoundary(previousText) &&
    (!/\S/.test(followingText) || beginsBlankLineBoundary(followingText));
}

function forwardCaptionBlockStart(starts: number[], offset: number, followingText: string): number | undefined {
  if (!/\S/.test(followingText)) return undefined;
  const leadingWhitespace = followingText.search(/\S/);
  const furthestStart = offset + Math.max(0, leadingWhitespace);
  return starts.find((start) => start >= offset && start <= furthestStart);
}

/**
 * Persist the identity decision when a text edit changes the block containing an attachment.
 *
 * Text blocks and zero-width attachment nodes carry identity independently. Most of the time
 * they agree, but a split can leave an attachment carrying the prefix id while the marker
 * transformer correctly gives its new suffix a fresh id. Conversely, adding a caption to a
 * media-only episode creates a fresh text marker that must inherit the media episode's id.
 * Resolving that mismatch only while parsing makes the id flip again on the next edit, so this
 * function reconciles both sources before the document and episode records are persisted.
 */
export function reconcileEpisodeIdentitySources(
  previousNodes: NoteNode[],
  previousMarkers: BlockMarker[],
  nextText: string,
  nextMarkers: BlockMarker[],
  nextNodes: NoteNode[],
  knownEpisodeIds: Iterable<string> = [],
): { nodes: NoteNode[]; markers: BlockMarker[] } {
  const nodes = nextNodes.map((node) => ({ ...node }));
  const markers = nextMarkers.map((marker) => ({ ...marker }));
  if (markers.length === 0 || !nodes.some((node) => node.type === "attachment")) {
    return { nodes, markers };
  }

  const ranges = episodeRanges(nextText);
  const starts = blockStarts(nextText);
  const markerIndexAtOffset = new Map(markers.map((marker, index) => [marker.offset, index]));
  const initialMarkerOwner = new Map(markers.map((marker, index) => [marker.id, index]));
  const claimedIdentityOwner = new Map(initialMarkerOwner);
  const previousMarkerIds = new Set(previousMarkers.map((marker) => marker.id));
  const knownIds = new Set(knownEpisodeIds);
  const previousAttachmentIdentity = new Map<string, string>();
  previousNodes.forEach((node) => {
    if (node.type !== "attachment" || !node.episodeId) return;
    previousAttachmentIdentity.set(node.id, node.episodeId);
    previousAttachmentIdentity.set(`attachment:${node.attachmentId}`, node.episodeId);
  });

  const attachmentsByMarker = new Map<number, number[]>();
  const attachmentOffsets = new Map<number, number>();
  let offset = 0;
  nodes.forEach((node, nodeIndex) => {
    if (node.type === "text") {
      offset += node.text.length;
      return;
    }
    attachmentOffsets.set(nodeIndex, offset);

    const containingRange = ranges.find((range) => offset >= range.start && offset <= range.end);
    let markerOffset = containingRange?.start;
    if (markerOffset === undefined) {
      const { previousText, followingText } = attachmentTextContext(nodes, nodeIndex);
      if (!isStandaloneMediaBlock(node, previousText, followingText)) {
        markerOffset = followsBlankLineBoundary(previousText)
          ? forwardCaptionBlockStart(starts, offset, followingText)
          : undefined;
        markerOffset ??= starts[blockIndexAt(starts, offset)];
      }
    }
    if (markerOffset === undefined) return;
    const markerIndex = markerIndexAtOffset.get(markerOffset);
    if (markerIndex === undefined) return;
    const grouped = attachmentsByMarker.get(markerIndex) ?? [];
    grouped.push(nodeIndex);
    attachmentsByMarker.set(markerIndex, grouped);
  });

  // Sequential attachments pasted at one zero-width caret share both an episode id and a text
  // offset, even though empty text nodes may sit between them. When a caption is typed, only the
  // final attachment directly sees that caption. Move its co-located siblings onto the same marker
  // too, otherwise typing and then deleting the caption splits one visual episode into two ids.
  attachmentsByMarker.forEach((nodeIndices, markerIndex) => {
    const groupedOffsets = new Set(nodeIndices.map((nodeIndex) => attachmentOffsets.get(nodeIndex)));
    const groupedIds = new Set(
      nodeIndices.flatMap((nodeIndex): string[] => {
        const node = nodes[nodeIndex];
        return node?.type === "attachment" && node.episodeId ? [node.episodeId] : [];
      }),
    );
    nodes.forEach((candidate, candidateIndex) => {
      if (
        candidate.type === "attachment" &&
        candidate.episodeId &&
        groupedIds.has(candidate.episodeId) &&
        groupedOffsets.has(attachmentOffsets.get(candidateIndex)) &&
        !nodeIndices.includes(candidateIndex)
      ) {
        nodeIndices.push(candidateIndex);
      }
    });
    nodeIndices.sort((left, right) => left - right);
    attachmentsByMarker.set(markerIndex, nodeIndices);
  });

  [...attachmentsByMarker.entries()]
    .sort(([left], [right]) => left - right)
    .forEach(([markerIndex, nodeIndices]) => {
      const marker = markers[markerIndex];
      if (!marker) return;
      const candidateIds = [
        ...new Set(
          nodeIndices.flatMap((nodeIndex): string[] => {
            const node = nodes[nodeIndex];
            return node?.type === "attachment" && node.episodeId ? [node.episodeId] : [];
          }),
        ),
      ];
      let desiredId = marker.id;
      const knownCandidates = candidateIds.filter((candidateId) => knownIds.has(candidateId));
      const identityClaimedElsewhere = candidateIds.some((candidateId) => {
        const owner = claimedIdentityOwner.get(candidateId);
        return owner !== undefined && owner !== markerIndex;
      });

      if (!knownIds.has(marker.id) && knownCandidates.length === 1) {
        const knownCandidate = knownCandidates[0] as string;
        const owner = claimedIdentityOwner.get(knownCandidate);
        const ownerMarker = owner === undefined ? undefined : markers[owner];
        const ownerHasCompletedText = Boolean(
          ownerMarker && ranges.some((range) => range.start === ownerMarker.offset),
        );
        if (owner === undefined || owner === markerIndex || !ownerHasCompletedText) {
          desiredId = knownCandidate;
          if (owner !== undefined && owner !== markerIndex && ownerMarker) {
            const replacementId = newId();
            markers[owner] = { ...ownerMarker, id: replacementId };
            claimedIdentityOwner.delete(knownCandidate);
            claimedIdentityOwner.set(replacementId, owner);
          }
        }
      } else if (!identityClaimedElsewhere && !knownIds.has(marker.id)) {
        if (!previousMarkerIds.has(marker.id)) {
          const survivingCandidates = candidateIds.filter((candidateId) =>
            nodeIndices.some((nodeIndex) => {
              const node = nodes[nodeIndex];
              if (!node || node.type !== "attachment") return false;
              return previousAttachmentIdentity.get(node.id) === candidateId ||
                previousAttachmentIdentity.get(`attachment:${node.attachmentId}`) === candidateId;
            }),
          );
          if (survivingCandidates.length === 1) desiredId = survivingCandidates[0] as string;
        }
      }

      if (desiredId !== marker.id) {
        markers[markerIndex] = { ...marker, id: desiredId };
        if (claimedIdentityOwner.get(marker.id) === markerIndex) claimedIdentityOwner.delete(marker.id);
        claimedIdentityOwner.set(desiredId, markerIndex);
      }
      nodeIndices.forEach((nodeIndex) => {
        const node = nodes[nodeIndex];
        if (node?.type === "attachment" && node.episodeId !== desiredId) {
          nodes[nodeIndex] = { ...node, episodeId: desiredId };
        }
      });
    });

  return { nodes, markers };
}

export function completedEpisodesWithAttachments(
  text: string,
  markers: BlockMarker[],
  nodes: NoteNode[],
): ParsedEpisode[] {
  const enriched = completedEpisodes(text, markers).map((episode) => ({
    ...episode,
    attachmentIds: [] as string[],
  }));
  const starts = blockStarts(text);
  const markerAt = new Map(markers.map((marker) => [marker.offset, marker.id]));
  const contentEnds = blockContentEnds(text);
  let offset = 0;
  const episodeIdClaimedByRange = new Map<string, string>();
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.type === "text") {
      offset += node.text.length;
      continue;
    }
    let { previousText, followingText } = attachmentTextContext(nodes, nodeIndex);
    const directCaption = /\S/.test(followingText.split("\n", 1)[0] ?? "");
    const captionHasBlankLineBoundary = /\n[\t ]*\n/.test(followingText);
    // DOM order is the source of truth at an attachment's zero-width boundary. Text authored
    // directly after the attachment is rendered on the next visual line, but remains its active
    // caption until a real blank line exists. Never let an older marker at the same numeric offset
    // resurrect a media-only episode while the user is still typing.
    if (directCaption && !captionHasBlankLineBoundary) continue;
    let episode = enriched.find((candidate) => offset >= candidate.start && offset <= candidate.end);
    if (episode && node.episodeId) {
      const rangeKey = `${episode.start}:${episode.end}`;
      const claimed = episodeIdClaimedByRange.get(rangeKey);
      if (!claimed) {
        const duplicate = enriched.find(
          (candidate) => candidate !== episode && candidate.id === node.episodeId,
        );
        if (!duplicate) episode.id = node.episodeId;
        episodeIdClaimedByRange.set(rangeKey, episode.id);
      }
    }
    let standaloneMediaBlock = false;
    if (!episode) {
      standaloneMediaBlock = isStandaloneMediaBlock(node, previousText, followingText);
      if (standaloneMediaBlock && beginsBlankLineBoundary(followingText) && node.episodeId) {
        episode = enriched.find((candidate) => candidate.id === node.episodeId);
        if (!episode) {
          episode = {
            id: node.episodeId,
            text: "",
            start: offset,
            end: offset,
            attachmentIds: [],
          };
          enriched.push(episode);
        }
      }
    }
    if (!episode && !standaloneMediaBlock) {
      const preferredStart = followsBlankLineBoundary(previousText)
        ? forwardCaptionBlockStart(starts, offset, followingText)
        : undefined;
      const preferredIndex = preferredStart === undefined ? -1 : starts.indexOf(preferredStart);
      const blockIndex = preferredIndex >= 0 ? preferredIndex : blockIndexAt(starts, offset);
      const start = starts[blockIndex];
      const id = start === undefined ? undefined : markerAt.get(start);
      // The last block is still being authored. A prior block—even one containing only media
      // or whitespace—is locked once a blank-line boundary exists after it.
      if (id && start !== undefined && blockIndex < starts.length - 1) {
        episode = enriched.find((candidate) => candidate.id === id);
        if (!episode) {
          const created: ParsedEpisode = {
            id,
            text: decodeDraftText(text.slice(start, contentEnds[blockIndex] ?? start).trim()),
            start,
            end: contentEnds[blockIndex] ?? start,
            attachmentIds: [],
          };
          enriched.push(created);
          episode = created;
        }
      }
    }
    episode?.attachmentIds.push(node.attachmentId);
  }
  // Sequential pastes at the same zero-width caret share an episode id. An empty text node can
  // sit between them, so an earlier attachment may not see the later blank-line boundary during
  // the first pass. Once any member resolves, attach the complete group in document order.
  const attachmentsByEpisodeId = new Map<string, AttachmentNode[]>();
  nodes.forEach((node) => {
    if (node.type !== "attachment" || !node.episodeId) return;
    const grouped = attachmentsByEpisodeId.get(node.episodeId) ?? [];
    grouped.push(node);
    attachmentsByEpisodeId.set(node.episodeId, grouped);
  });
  attachmentsByEpisodeId.forEach((group, episodeId) => {
    const episode = enriched.find((candidate) => candidate.id === episodeId);
    if (!episode || !group.some((node) => episode.attachmentIds.includes(node.attachmentId))) return;
    group.forEach((node) => {
      if (!episode.attachmentIds.includes(node.attachmentId)) episode.attachmentIds.push(node.attachmentId);
    });
  });
  const attachmentOrder = new Map<string, number>();
  let attachmentIndex = 0;
  nodes.forEach((node) => {
    if (node.type === "attachment") attachmentOrder.set(node.attachmentId, attachmentIndex++);
  });
  enriched.forEach((episode) => {
    episode.attachmentIds.sort(
      (left, right) => (attachmentOrder.get(left) ?? 0) - (attachmentOrder.get(right) ?? 0),
    );
  });
  return enriched.sort((left, right) => left.start - right.start);
}

/** Return the attachment node when it is the last visual item in an episode. */
export function episodeEndpointAttachmentNodeId(
  episode: ParsedEpisode,
  nodes: NoteNode[],
): string | null {
  let textOffset = 0;
  let textEndpointIndex = -1;
  for (const [nodeIndex, node] of nodes.entries()) {
    if (node.type !== "text") continue;
    if (textEndpointIndex < 0 && episode.end <= textOffset + node.text.length) {
      textEndpointIndex = nodeIndex;
    }
    textOffset += node.text.length;
  }

  const attachmentIds = new Set(episode.attachmentIds);
  let endpointNodeId: string | null = null;
  nodes.forEach((node, nodeIndex) => {
    if (
      node.type === "attachment" &&
      nodeIndex > textEndpointIndex &&
      attachmentIds.has(node.attachmentId)
    ) {
      endpointNodeId = node.id;
    }
  });
  return endpointNodeId;
}

function sameIds(left: string[] | null, right: string[] | null): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

export function episodeHasProcessedCurrentContent(record: EpisodeRecord): boolean {
  return Boolean(record.episodeId) &&
    record.processedText === record.text &&
    sameIds(record.processedAttachmentIds, record.attachmentIds);
}

function isTerminalSubmissionError(cause: unknown): boolean {
  const message = cause instanceof Error ? cause.message : String(cause);
  return /WRITE_TERMINAL:|not supported|invalid (?:attachment|input|episode)|attachment path is invalid|no episode\b|no longer available|already bound|needs non-empty/i.test(
    message,
  );
}

function retainedOperationAttachmentIds(records: EpisodeRecord[]): string[] {
  const ids = new Set<string>();
  records.forEach((record) => {
    const operationActive =
      record.inFlight ||
      Boolean(record.spoolId) ||
      record.operation === "capture" ||
      record.operation === "reingest";
    if (!operationActive) return;
    record.submittedAttachmentIds?.forEach((id) => ids.add(id));
  });
  return [...ids];
}

function restoreEpisodeRecords(): EpisodeRecord[] {
  try {
    return normalizeEpisodeRecords(JSON.parse(sessionStorage.getItem(EPISODES_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export function alignEpisodeRecords(current: EpisodeRecord[], episodes: ParsedEpisode[], now: number): EpisodeRecord[] {
  const activeIds = new Set(episodes.map((episode) => episode.id));
  const aligned = episodes.map((episode): EpisodeRecord => {
    const record = current.find((candidate) => candidate.id === episode.id);
    if (!record) {
      return {
        id: episode.id,
        text: episode.text,
        submittedText: null,
        processedText: null,
        attachmentIds: episode.attachmentIds,
        submittedAttachmentIds: null,
        processedAttachmentIds: null,
        status: "processing",
        spoolId: null,
        episodeId: null,
        inFlight: false,
        operation: null,
        operationId: null,
        present: true,
        changedAt: now,
      };
    }
    const contentSame = record.text === episode.text && sameIds(record.attachmentIds, episode.attachmentIds);
    const operationActive =
      record.inFlight ||
      Boolean(record.spoolId) ||
      Boolean(
        record.operationId &&
        (record.operation === "capture" || record.operation === "reingest"),
      );
    const alreadyProcessed =
      Boolean(record.episodeId) &&
      !operationActive &&
      record.processedText === episode.text &&
      sameIds(record.processedAttachmentIds, episode.attachmentIds);
    if (contentSame && record.present && (record.status !== "done" || alreadyProcessed)) return record;
    return {
      ...record,
      text: episode.text,
      attachmentIds: episode.attachmentIds,
      status: alreadyProcessed ? "done" : "processing",
      present: true,
      changedAt: alreadyProcessed || (contentSame && record.status !== "done") ? record.changedAt : now,
      operationId: operationActive || alreadyProcessed ? record.operationId : null,
      error: undefined,
    };
  });
  const removed = current
    .filter((record) => !activeIds.has(record.id))
    .map((record) => (record.present ? { ...record, present: false, changedAt: now } : record));
  return [...aligned, ...removed];
}

function normalizeNodes(nodes: NoteNode[]): NoteNode[] {
  const merged: NoteNode[] = [];
  for (const node of nodes) {
    const previous = merged[merged.length - 1];
    if (node.type === "text" && previous?.type === "text") previous.text += node.text;
    else merged.push({ ...node });
  }
  if (merged[0]?.type !== "text") merged.unshift(newTextNode());
  if (merged[merged.length - 1]?.type !== "text") merged.push(newTextNode());
  return merged.length > 0 ? merged : [newTextNode()];
}

function trailingDraftStart(text: string): number {
  let start = 0;
  for (const match of text.matchAll(/\n[\t ]*\n+/g)) {
    start = (match.index ?? 0) + match[0].length;
  }
  return start;
}

function replaceTrailingDraftText(nodes: NoteNode[], start: number, text: string): NoteNode[] {
  const prefix: NoteNode[] = [];
  const draftAttachments: AttachmentNode[] = [];
  let offset = 0;

  nodes.forEach((node) => {
    if (node.type === "attachment") {
      if (offset < start) prefix.push(node);
      else draftAttachments.push(node);
      return;
    }

    const nodeStart = offset;
    offset += node.text.length;
    if (offset <= start) {
      prefix.push(node);
    } else if (nodeStart < start) {
      prefix.push({ ...node, text: node.text.slice(0, start - nodeStart) });
    }
  });

  return normalizeNodes([
    ...prefix,
    newTextNode(text),
    ...draftAttachments,
    newTextNode(),
  ]);
}

/** Replace a text range without disturbing zero-width attachment nodes inside the block. */
export function replaceTextRange(
  nodes: NoteNode[],
  start: number,
  end: number,
  insert: string,
  removeAttachmentIds: ReadonlySet<string> = new Set(),
): NoteNode[] {
  const next: NoteNode[] = [];
  let offset = 0;
  let inserted = false;
  for (const node of nodes) {
    if (node.type === "attachment") {
      if (!removeAttachmentIds.has(node.attachmentId)) next.push(node);
      continue;
    }
    const nodeStart = offset;
    const nodeEnd = offset + node.text.length;
    offset = nodeEnd;
    if (nodeEnd <= start) {
      next.push(node);
      continue;
    }
    if (nodeStart >= end) {
      if (!inserted) {
        next.push(newTextNode(insert));
        inserted = true;
      }
      next.push(node);
      continue;
    }
    const prefixLength = Math.max(0, start - nodeStart);
    const suffixStart = Math.max(0, end - nodeStart);
    if (prefixLength > 0) next.push({ ...node, text: node.text.slice(0, prefixLength) });
    if (!inserted) {
      next.push(newTextNode(insert));
      inserted = true;
    }
    if (suffixStart < node.text.length) next.push({ ...node, text: node.text.slice(suffixStart) });
  }
  if (!inserted) next.push(newTextNode(insert));
  return normalizeNodes(next);
}

function restoreDocumentNodes(document: PersistedWriteDocument, attachments: DraftAttachment[]): NoteNode[] {
  const availableAttachments = new Set(attachments.map((attachment) => attachment.id));
  return normalizeNodes(
    document.nodes.filter(
      (node) => node.type === "text" || availableAttachments.has(node.attachmentId),
    ),
  );
}

function mergeAttachments(...groups: DraftAttachment[][]): DraftAttachment[] {
  const merged = new Map<string, DraftAttachment>();
  groups.flat().forEach((attachment) => merged.set(attachment.id, attachment));
  return [...merged.values()];
}

export function InputPage({
  focusToken,
  composerOnly = false,
  activeFolder = null,
  onPendingEntriesChange,
  onSearchChange,
  chatOpen = false,
  onToggleChat,
  onChatSubmit,
}: {
  focusToken: number;
  composerOnly?: boolean;
  /** Folder the board is filtered to; when set, the empty composer pre-fills `/folder ` so a
      note added while viewing it files there. Null when not inside a single folder. */
  activeFolder?: string | null;
  onPendingEntriesChange?: (entries: PendingWriteEntry[]) => void;
  /** Live search-mode text — filters the board behind the bar. */
  onSearchChange?: (query: string) => void;
  /** Chat has the bar, so it asks Ceb rather than writing a memory. */
  chatOpen?: boolean;
  onToggleChat?: () => void;
  /** Send the bar's text to Ceb. The drawer has no input of its own — this is the only one. */
  onChatSubmit?: (text: string) => void;
}) {
  const initialDocumentRef = useRef<PersistedWriteDocument | null>(readWriteDocument());
  const initialNodesRef = useRef<NoteNode[]>(
    initialDocumentRef.current ? normalizeNodes(initialDocumentRef.current.nodes) : [newTextNode()],
  );
  const initialMarkersRef = useRef<BlockMarker[]>(
    initialDocumentRef.current
      ? normalizeBlockMarkers(initialDocumentRef.current.text, initialDocumentRef.current.markers)
      : [],
  );
  const initialEpisodeRecordsRef = useRef<EpisodeRecord[]>(
    initialDocumentRef.current?.episodes ?? restoreEpisodeRecords(),
  );
  const [nodes, setNodes] = useState<NoteNode[]>(initialNodesRef.current);
  // Staging is authoritative for attachment availability. Do not render persisted URLs until
  // writeAttachmentsSync has verified their files; stale local-storage entries otherwise issue
  // a burst of graph-staging 404s during startup before reconciliation removes them.
  const [attachments, setAttachments] = useState<DraftAttachment[]>([]);
  const [episodeRecords, setEpisodeRecords] = useState<EpisodeRecord[]>(initialEpisodeRecordsRef.current);
  const [dismissedEpisodeIds, setDismissedEpisodeIds] = useState<Set<string>>(
    () => new Set(
      initialEpisodeRecordsRef.current
        .filter((record) => record.present && episodeHasProcessedCurrentContent(record))
        .map((record) => record.id),
    ),
  );
  const [fadingEpisodeIds, setFadingEpisodeIds] = useState<Set<string>>(() => new Set());
  const [attachmentAspectRatios, setAttachmentAspectRatios] = useState<Map<string, number>>(() => new Map());
  const [blockMarkers, setBlockMarkers] = useState<BlockMarker[]>(initialMarkersRef.current);
  const [markerPositions, setMarkerPositions] = useState<Array<MarkerPosition | null>>([]);
  const [draftLoaded, setDraftLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [composerFocused, setComposerFocused] = useState(false);
  const [searchActive, setSearchActive] = useState(false);
  const knownTags = useKnownTags();
  const [tagMenuIndex, setTagMenuIndex] = useState(0);
  /** The exact draft text Esc dismissed the tag menu for; any keystroke reopens it. */
  const [tagMenuDismissedFor, setTagMenuDismissedFor] = useState<string | null>(null);
  /** Search-mode text is deliberately NOT the note draft — queries must never edit it. */
  const [searchText, setSearchText] = useState("");
  /** Committed filter pills; Enter moves the typed text here. All must match. */
  const [searchFilters, setSearchFilters] = useState<string[]>([]);
  /** Dictation: hosted OpenAI transcription via the mic button (mirrors the Ask popup's states). */
  const [dictationState, setDictationState] = useState<"idle" | "recording" | "transcribing">("idle");
  const dictationCaptureRef = useRef<VoiceCapture | null>(null);
  const dictationTimerRef = useRef<number>(0);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const paperRef = useRef<HTMLDivElement | null>(null);
  const textRefs = useRef(new Map<string, HTMLTextAreaElement>());
  const attachmentRefs = useRef(new Map<string, HTMLElement>());
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  /** The search-mode editable region — a contentEditable so committed pills sit
   *  inline and the typed query flows as real text, wrapping to full-width lines. */
  const searchTextRef = useRef<HTMLSpanElement | null>(null);
  const searchCaretTargetRef = useRef<number | null>(null);
  const composerCaretTargetRef = useRef<number | null>(null);
  const searchSeedRef = useRef<{ composerText: string; searchText: string } | null>(null);
  const addDroppedFilesRef = useRef<(files: File[]) => void>(() => undefined);
  const feedEndRef = useRef<HTMLDivElement | null>(null);
  const insertionRef = useRef<InsertionPoint | null>(null);
  const focusAfterCommit = useRef<InsertionPoint | null>(null);
  const attachmentQueueRef = useRef<Promise<void>>(Promise.resolve());
  const nodesRef = useRef<NoteNode[]>(nodes);
  const attachmentsRef = useRef<DraftAttachment[]>(attachments);
  const localRevisionRef = useRef(0);
  const episodeRecordsRef = useRef(episodeRecords);
  const blockMarkersRef = useRef<BlockMarker[]>(blockMarkers);
  const dismissalTimersRef = useRef(new Map<string, { fade: number; remove: number }>());
  const beforeInputRef = useRef<{
    nodeId: string;
    selectionStart: number;
    selectionEnd: number;
    inputType: string;
  } | null>(null);

  const parsedEpisodes = useMemo(
    () => completedEpisodesWithAttachments(textOf(nodes), blockMarkers, nodes),
    [nodes, blockMarkers],
  );

  useEffect(() => {
    let alive = true;
    attachments.forEach((attachment) => {
      if (!attachment.isImage || !attachment.url || attachmentAspectRatios.has(attachment.id)) return;
      const image = new Image();
      image.onload = () => {
        if (!alive || image.naturalWidth <= 0 || image.naturalHeight <= 0) return;
        setAttachmentAspectRatios((current) => {
          if (current.has(attachment.id)) return current;
          const next = new Map(current);
          next.set(attachment.id, image.naturalWidth / image.naturalHeight);
          return next;
        });
      };
      image.src = attachment.url;
    });
    return () => {
      alive = false;
    };
  }, [attachments, attachmentAspectRatios]);

  useEffect(() => {
    const settledIds = new Set(
      episodeRecords
        .filter((record) => record.present && episodeHasProcessedCurrentContent(record))
        .map((record) => record.id),
    );

    dismissalTimersRef.current.forEach((timers, id) => {
      if (settledIds.has(id)) return;
      window.clearTimeout(timers.fade);
      window.clearTimeout(timers.remove);
      dismissalTimersRef.current.delete(id);
      setFadingEpisodeIds((current) => {
        if (!current.has(id)) return current;
        const next = new Set(current);
        next.delete(id);
        return next;
      });
    });

    settledIds.forEach((id) => {
      if (dismissedEpisodeIds.has(id) || dismissalTimersRef.current.has(id)) return;
      const fade = window.setTimeout(() => {
        setFadingEpisodeIds((current) => new Set(current).add(id));
      }, 5000);
      const remove = window.setTimeout(() => {
        setDismissedEpisodeIds((current) => new Set(current).add(id));
        setFadingEpisodeIds((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        dismissalTimersRef.current.delete(id);
      }, 5500);
      dismissalTimersRef.current.set(id, { fade, remove });
    });
  }, [episodeRecords, dismissedEpisodeIds]);

  useEffect(() => () => {
    dismissalTimersRef.current.forEach((timers) => {
      window.clearTimeout(timers.fade);
      window.clearTimeout(timers.remove);
    });
    dismissalTimersRef.current.clear();
  }, []);

  const updateEpisodeRecords = (change: (current: EpisodeRecord[]) => EpisodeRecord[]) => {
    const next = change(episodeRecordsRef.current);
    episodeRecordsRef.current = next;
    setEpisodeRecords(next);
    writeDocument(nodesRef.current, blockMarkersRef.current, next, attachmentsRef.current);
  };

  const commitBlockMarkers = (markers: BlockMarker[], nextNodes = nodesRef.current) => {
    blockMarkersRef.current = markers;
    setBlockMarkers(markers);
    writeDocument(nextNodes, markers, episodeRecordsRef.current, attachmentsRef.current);
  };

  const commitAttachments = (next: DraftAttachment[]) => {
    attachmentsRef.current = next;
    setAttachments(next);
    writeDocument(nodesRef.current, blockMarkersRef.current, episodeRecordsRef.current, next);
  };

  const commitNodes = (change: (current: NoteNode[]) => NoteNode[], edit?: TextEdit) => {
    const current = nodesRef.current;
    const previousText = textOf(current);
    const changedNodes = normalizeNodes(change(current));
    const nextText = textOf(changedNodes);
    const transformedMarkers =
      previousText === nextText
        ? blockMarkersRef.current
        : transformBlockMarkers(previousText, nextText, blockMarkersRef.current, edit);
    const reconciled = reconcileEpisodeIdentitySources(
      current,
      blockMarkersRef.current,
      nextText,
      transformedMarkers,
      changedNodes,
      episodeRecordsRef.current.map((record) => record.id),
    );
    const next = reconciled.nodes;
    const nextMarkers = reconciled.markers;
    const nextRecords = draftLoaded
      ? alignEpisodeRecords(
          episodeRecordsRef.current,
          completedEpisodesWithAttachments(nextText, nextMarkers, next),
          Date.now(),
        )
      : episodeRecordsRef.current;
    localRevisionRef.current += 1;
    nodesRef.current = next;
    blockMarkersRef.current = nextMarkers;
    episodeRecordsRef.current = nextRecords;
    setNodes(next);
    setBlockMarkers(nextMarkers);
    setEpisodeRecords(nextRecords);
    writeDocument(next, nextMarkers, nextRecords, attachmentsRef.current);
  };

  useEffect(() => {
    let alive = true;
    const revisionAtStart = localRevisionRef.current;
    window.graph.writeAttachmentsGet()
      .then(async (writeAttachmentState) => {
        if (!alive) return;
        const saved = initialDocumentRef.current;
        const retainedIds = retainedOperationAttachmentIds(saved?.episodes ?? []);
        writeAttachmentState = await window.graph.writeAttachmentsSync(saved?.attachments ?? [], retainedIds);
        if (!alive) return;
        const storedById = new Map(
          writeAttachmentState.attachments.map((attachment) => [attachment.id, attachment]),
        );
        const restoredAttachments = saved
          ? saved.attachments.flatMap((attachment): DraftAttachment[] => {
              const stored = storedById.get(attachment.id);
              return stored ? [{ ...attachment, ...stored }] : [];
            })
          : [];
        attachmentsRef.current = restoredAttachments;
        setAttachments(restoredAttachments);
        if (localRevisionRef.current !== revisionAtStart) {
          setDraftLoaded(true);
          return;
        }
        const restoredNodes = saved
          ? restoreDocumentNodes(saved, restoredAttachments)
          : [newTextNode()];
        const restoredText = saved ? saved.text : "";
        const restoredMarkers = saved
          ? normalizeBlockMarkers(restoredText, saved.markers)
          : restoreBlockMarkers(restoredText, episodeRecordsRef.current);
        // Reconcile documents written by earlier builds that only overlaid attachment identity
        // during parsing. Passing no trusted previous markers lets a known media episode migrate
        // onto a newly-created caption marker, while collision checks still protect text blocks.
        const reconciled = reconcileEpisodeIdentitySources(
          restoredNodes,
          [],
          restoredText,
          restoredMarkers,
          restoredNodes,
          episodeRecordsRef.current.map((record) => record.id),
        );
        nodesRef.current = reconciled.nodes;
        setNodes(reconciled.nodes);
        commitBlockMarkers(reconciled.markers, reconciled.nodes);
        setDraftLoaded(true);
      })
      .catch(() => {
        if (alive) setDraftLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const retainedAttachmentKey = retainedOperationAttachmentIds(episodeRecords).sort().join("|");

  useEffect(() => {
    if (!draftLoaded) return;
    let alive = true;
    const run = () => {
      const submittedAttachments = [...attachmentsRef.current];
      const requestedIds = new Set(submittedAttachments.map((attachment) => attachment.id));
      return window.graph
        .writeAttachmentsSync(
          submittedAttachments,
          retainedOperationAttachmentIds(episodeRecordsRef.current),
        )
        .then((state) => ({ state, requestedIds }));
    };
    const queued = attachmentQueueRef.current.then(run, run);
    attachmentQueueRef.current = queued.then(() => undefined, () => undefined);
    queued
      .then(({ state, requestedIds }) => {
        if (!alive) return;
        const available = new Set(state.attachments.map((attachment) => attachment.id));
        const missingIds = new Set(missingAttachmentIdsFromSync(
          attachmentsRef.current.map((attachment) => attachment.id),
          requestedIds,
          available,
        ));
        if (missingIds.size === 0) return;
        commitAttachments(attachmentsRef.current.filter((attachment) => !missingIds.has(attachment.id)));
        commitNodes((current) =>
          current.filter((node) => node.type !== "attachment" || !missingIds.has(node.attachmentId)),
        );
        setError("An attachment file was no longer available and was removed.");
      })
      .catch((cause: Error) => {
        if (alive) setError(cause.message);
      });
    return () => {
      alive = false;
    };
  }, [draftLoaded, attachments, retainedAttachmentKey]);

  useEffect(() => {
    nodes.forEach((node, index) => {
      if (node.type !== "text") return;
      const el = textRefs.current.get(node.id);
      if (!el) return;
      const followedByAttachment = nodes[index + 1]?.type === "attachment";
      el.style.height = "0px";
      let height = el.scrollHeight;
      if (followedByAttachment && node.text.endsWith("\n")) {
        const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 28;
        height -= lineHeight;
      }
      if (followedByAttachment && node.text.length === 0) height = 0;
      el.style.height = `${Math.max(height, followedByAttachment ? 0 : 28)}px`;
    });
    const target = focusAfterCommit.current;
    if (target) {
      focusAfterCommit.current = null;
      requestAnimationFrame(() => {
        const el = textRefs.current.get(target.nodeId);
        if (!el) return;
        el.focus();
        el.setSelectionRange(target.offset, target.offset);
        insertionRef.current = target;
      });
    }
  }, [nodes]);

  useEffect(() => {
    if (!draftLoaded) return;
    updateEpisodeRecords((current) => alignEpisodeRecords(current, parsedEpisodes, Date.now()));
  }, [draftLoaded, parsedEpisodes]);

  const submitEpisode = async (recordId: string) => {
    const record = episodeRecordsRef.current.find((candidate) => candidate.id === recordId);
    const recoveringOperation = Boolean(
      record?.operationId &&
      (record.operation === "capture" || record.operation === "reingest") &&
      record.submittedText !== null,
    );
    if (
      !record ||
      (!record.present && !recoveringOperation) ||
      record.inFlight ||
      record.spoolId ||
      record.operation === "delete" ||
      (!recoveringOperation && episodeHasProcessedCurrentContent(record)) ||
      (!recoveringOperation &&
        record.status === "failed" &&
        record.submittedText === record.text &&
        sameIds(record.submittedAttachmentIds, record.attachmentIds))
    ) return;
    // An unacknowledged operation is retried byte-for-byte with its original payload. If the
    // user edited (or deleted) the block while that request was uncertain, we first settle the
    // old operation by id, then the normal loop submits the newer state as a separate operation.
    const submittedText = recoveringOperation ? record.submittedText as string : record.text;
    const submittedAttachmentIds = recoveringOperation
      ? [...(record.submittedAttachmentIds ?? [])]
      : [...record.attachmentIds];
    const operationId = record.operationId ?? newId();
    const operation = recoveringOperation
      ? record.operation === "reingest" && record.episodeId
        ? "reingest"
        : "capture"
      : record.episodeId
        ? "reingest"
        : "capture";
    updateEpisodeRecords((current) =>
      current.map((candidate) =>
        candidate.id === recordId
          ? {
              ...candidate,
              inFlight: true,
              operation,
              operationId,
              status: "processing",
              submittedText,
              submittedAttachmentIds,
              error: undefined,
            }
          : candidate,
      ),
    );
    try {
      if (operation === "reingest" && record.episodeId) {
        const result = await window.graph.episodeReingest(
          record.episodeId,
          submittedText,
          operationId,
          submittedAttachmentIds,
        );
        updateEpisodeRecords((current) =>
          current.map((candidate) =>
            candidate.id === recordId
              ? result.episode_id
                ? {
                    ...candidate,
                    inFlight: false,
                    operation: null,
                    operationId:
                      candidate.text === submittedText && sameIds(candidate.attachmentIds, submittedAttachmentIds)
                        ? operationId
                        : null,
                    spoolId: null,
                    episodeId: result.episode_id,
                    processedText: submittedText,
                    processedAttachmentIds: submittedAttachmentIds,
                    status:
                      candidate.text === submittedText && sameIds(candidate.attachmentIds, submittedAttachmentIds)
                        ? "done"
                        : "processing",
                  }
                : {
                    ...candidate,
                    inFlight: false,
                    operation,
                    operationId,
                    spoolId: result.spool_id,
                    episodeId: null,
                  }
              : candidate,
          ),
        );
      } else {
        const result = await window.graph.capture(submittedText, operationId, submittedAttachmentIds);
        if (result.status !== "spooled" || !result.spoolId) throw new Error("The episode could not be queued.");
        updateEpisodeRecords((current) =>
          current.map((candidate) =>
            candidate.id === recordId
              ? result.episodeId
                ? {
                    ...candidate,
                    inFlight: false,
                    operation: null,
                    operationId:
                      candidate.text === submittedText && sameIds(candidate.attachmentIds, submittedAttachmentIds)
                        ? operationId
                        : null,
                    spoolId: null,
                    episodeId: result.episodeId,
                    processedText: submittedText,
                    processedAttachmentIds: submittedAttachmentIds,
                    status:
                      candidate.text === submittedText && sameIds(candidate.attachmentIds, submittedAttachmentIds)
                        ? "done"
                        : "processing",
                  }
                : {
                    ...candidate,
                    inFlight: false,
                    operation,
                    operationId,
                    spoolId: result.spoolId,
                  }
              : candidate,
          ),
        );
      }
    } catch (cause) {
      const terminal = isTerminalSubmissionError(cause);
      const message = cause instanceof Error ? cause.message : String(cause);
      // The per-card glyph is only a "!", so the one failure the user can act on — the day's
      // entries being gone — says so in the composer's error line too.
      const limit = usageLimitMessage(message);
      if (limit) setError(limit);
      updateEpisodeRecords((current) =>
        current.map((candidate) =>
          candidate.id === recordId
            ? {
                ...candidate,
                inFlight: false,
                // The daemon may have committed before the reply was lost. Keep the operation
                // key and retry the exact submitted payload; the backend makes that retry a
                // lookup rather than a second capture.
                operation: terminal ? null : operation,
                operationId: terminal ? null : operationId,
                status: terminal ? "failed" : "processing",
                changedAt: Date.now(),
                error: limit ?? message ?? "The episode could not be added.",
              }
            : candidate,
        ),
      );
    }
  };

  const deleteEpisodeRecord = async (record: EpisodeRecord) => {
    if (record.inFlight) return;
    updateEpisodeRecords((current) =>
      current.map((candidate) =>
        candidate.id === record.id
          ? { ...candidate, inFlight: true, operation: "delete", operationId: null }
          : candidate,
      ),
    );
    try {
      await window.graph.pendingDelete({
        id: record.id,
        text: record.text,
        createdAt: record.changedAt,
        spoolId: record.spoolId,
        episodeId: record.episodeId,
        attachmentIds: record.attachmentIds,
      });
      updateEpisodeRecords((current) =>
        current.flatMap((candidate): EpisodeRecord[] => {
          if (candidate.id !== record.id) return [candidate];
          if (!candidate.present) return [];
          // The user restored this block while its delete was in flight. The old graph episode
          // is gone, so keep the block and queue its current text as a fresh capture.
          return [{
            ...candidate,
            submittedText: null,
            processedText: null,
            submittedAttachmentIds: null,
            processedAttachmentIds: null,
            status: "processing",
            spoolId: null,
            episodeId: null,
            inFlight: false,
            operation: null,
            operationId: null,
            changedAt: Date.now(),
            error: undefined,
          }];
        }),
      );
    } catch (cause) {
      updateEpisodeRecords((current) =>
        current.map((candidate) =>
          candidate.id === record.id
            ? {
                ...candidate,
                inFlight: false,
                // Delete is idempotent. Retain this uncertain state so an absent block retries
                // deletion, while a restored block checks whether the old episode survived.
                operation: "delete",
                operationId: null,
                status: "processing",
                changedAt: Date.now(),
                error: cause instanceof Error ? cause.message : "The episode could not be deleted.",
              }
            : candidate,
        ),
      );
    }
  };

  useEffect(() => {
    if (!draftLoaded) return;
    const timer = setInterval(() => {
      const now = Date.now();
      episodeRecordsRef.current.forEach((record) => {
        if (now - record.changedAt < 3000) return;
        if (
          record.present ||
          (record.operationId && (record.operation === "capture" || record.operation === "reingest"))
        ) void submitEpisode(record.id);
        else void deleteEpisodeRecord(record);
      });
    }, 250);
    return () => clearInterval(timer);
  }, [draftLoaded]);

  const uncertainRestoredDeletes = episodeRecords
    .filter((record) => !record.inFlight && record.operation === "delete" && record.present && record.episodeId)
    .map((record) => `${record.id}:${record.episodeId}`)
    .join("|");

  useEffect(() => {
    if (!draftLoaded) return;
    if (!uncertainRestoredDeletes) return;
    let alive = true;
    const recover = async () => {
      try {
        const existingIds = new Set<string>();
        let offset = 0;
        let total = Number.POSITIVE_INFINITY;
        while (alive && offset < total) {
          const result = await window.graph.episodesList({ offset, limit: 5000 });
          result.episodes.forEach((episode) => existingIds.add(episode.id));
          total = result.total;
          if (result.episodes.length === 0) break;
          offset += result.episodes.length;
        }
        if (!alive) return;
        updateEpisodeRecords((current) =>
            current.map((record) => {
              if (record.operation !== "delete" || !record.present || !record.episodeId) return record;
              if (existingIds.has(record.episodeId)) return { ...record, operation: null };
              return {
                ...record,
                submittedText: null,
                processedText: null,
                submittedAttachmentIds: null,
                processedAttachmentIds: null,
                status: "processing",
                spoolId: null,
                episodeId: null,
                operation: null,
                operationId: null,
                changedAt: Date.now(),
                error: undefined,
              };
            }),
        );
      } catch {
        // Engine unavailable: retain the uncertain delete and try again later.
      }
    };
    recover();
    const timer = setInterval(recover, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [draftLoaded, uncertainRestoredDeletes]);

  const trackedSpools = useMemo(
    () => episodeRecords.map((record) => record.spoolId).filter(Boolean).join("|"),
    [episodeRecords],
  );

  useEffect(() => {
    if (!trackedSpools) return;
    let alive = true;
    let inFlight = false;
    const refresh = () => {
      if (inFlight) return;
      inFlight = true;
      window.graph
        .inboxStatus(trackedSpools.split("|").filter(Boolean))
        .then((queue) => {
          if (!alive) return;
          const discardedSpools = new Set(
            queue.last_receipts
              .filter((receipt) => receipt.discarded)
              .map((receipt) => receipt.spool_id),
          );
          const receipts = new Map(
            queue.last_receipts
              .filter((receipt) => !receipt.discarded)
              .map((receipt) => [receipt.spool_id, receipt.note_ids[0] ?? null]),
          );
          updateEpisodeRecords((current) =>
            current.flatMap((record): EpisodeRecord[] => {
              if (!record.spoolId) return [record];
              // While deleteEpisodeRecord owns the request, do not let a concurrent status poll
              // clear its inFlight guard and launch a duplicate delete. After an uncertain reply,
              // the durable discard receipt below settles the record without leaking it forever.
              if (record.inFlight && record.operation === "delete") return [record];
              if (discardedSpools.has(record.spoolId)) {
                if (!record.present) return [];
                return [{
                  ...record,
                  submittedText: null,
                  processedText: null,
                  submittedAttachmentIds: null,
                  processedAttachmentIds: null,
                  status: "processing",
                  spoolId: null,
                  episodeId: null,
                  inFlight: false,
                  operation: null,
                  operationId: null,
                  changedAt: Date.now(),
                  error: undefined,
                }];
              }
              const batchItem = queue.batch?.items[record.spoolId];
              const episodeId = batchItem?.episode_id ?? receipts.get(record.spoolId) ?? null;
              if (episodeId) {
                const processedText = record.submittedText;
                const processedAttachmentIds = record.submittedAttachmentIds;
                const clean =
                  record.text === processedText && sameIds(record.attachmentIds, processedAttachmentIds);
                return [{
                  ...record,
                  inFlight: false,
                  operation: null,
                  operationId: clean ? record.operationId : null,
                  spoolId: null,
                  episodeId,
                  processedText,
                  processedAttachmentIds,
                  status: clean ? "done" : "processing",
                  error: undefined,
                }];
              }
              if (batchItem?.state === "failed") {
                return [{
                  ...record,
                  inFlight: false,
                  // The spool remains durable and may succeed on the drainer backstop. Keep its
                  // operation identity so edits wait for this exact payload to settle first.
                  status: "failed",
                  changedAt: Date.now(),
                  error: batchItem.error ?? "The episode could not be added.",
                }];
              }
              return [record];
            }),
          );
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight = false;
        });
    };
    refresh();
    const timer = setInterval(refresh, 1200);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [trackedSpools]);

  useEffect(() => {
    const paper = paperRef.current;
    if (!paper) return;
    let animationFrame = 0;
    const measure = () => {
      const paperRect = paper.getBoundingClientRect();
      setMarkerPositions(
        parsedEpisodes.map((episode) => {
          const attachmentNodeId = episodeEndpointAttachmentNodeId(episode, nodes);
          if (attachmentNodeId) {
            const attachment = attachmentRefs.current.get(attachmentNodeId);
            if (!attachment) return null;
            const rect = attachment.getBoundingClientRect();
            return {
              top: rect.bottom - paperRect.top - EPISODE_MARKER_SIZE,
              left: rect.right - paperRect.left + 6,
            };
          }

          let offset = 0;
          for (const node of nodes) {
            if (node.type !== "text") continue;
            if (episode.end <= offset + node.text.length) {
              const el = textRefs.current.get(node.id);
              if (!el) return null;
              const localOffset = Math.max(0, episode.end - offset);
              const computed = getComputedStyle(el);
              const elRect = el.getBoundingClientRect();
              const lineHeight = Number.parseFloat(computed.lineHeight) || 28;
              const mirror = document.createElement("div");
              Object.assign(mirror.style, {
                position: "fixed",
                visibility: "hidden",
                pointerEvents: "none",
                top: `${elRect.top}px`,
                left: `${elRect.left}px`,
                width: `${el.clientWidth}px`,
                margin: "0",
                padding: computed.padding,
                border: computed.border,
                boxSizing: computed.boxSizing,
                font: computed.font,
                letterSpacing: computed.letterSpacing,
                lineHeight: computed.lineHeight,
                textAlign: computed.textAlign,
                tabSize: computed.tabSize,
                whiteSpace: "pre-wrap",
                overflowWrap: computed.overflowWrap,
                wordBreak: computed.wordBreak,
              });
              const beforeEndpoint = node.text.slice(0, localOffset);
              const mirrorText = document.createTextNode(beforeEndpoint);
              mirror.append(mirrorText);
              document.body.append(mirror);

              let endpointRect: DOMRect | DOMRectReadOnly | undefined;
              if (beforeEndpoint.length > 0) {
                const lastCodePoint = [...beforeEndpoint].pop() ?? "";
                const range = document.createRange();
                range.setStart(mirrorText, beforeEndpoint.length - lastCodePoint.length);
                range.setEnd(mirrorText, beforeEndpoint.length);
                const rects = range.getClientRects();
                endpointRect = rects.length > 0 ? rects[rects.length - 1] : undefined;
              }
              if (!endpointRect) {
                const endpoint = document.createElement("span");
                endpoint.style.display = "inline-block";
                endpoint.style.width = "0";
                endpoint.style.height = `${lineHeight}px`;
                mirror.append(endpoint);
                endpointRect = endpoint.getBoundingClientRect();
              }
              mirror.remove();
              return {
                top:
                  endpointRect.top -
                  paperRect.top +
                  (endpointRect.height - EPISODE_MARKER_SIZE) / 2,
                left: endpointRect.right - paperRect.left + 6,
              };
            }
            offset += node.text.length;
          }
          return null;
        }),
      );
    };
    const scheduleMeasure = () => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    observer.observe(paper);
    textRefs.current.forEach((element) => observer.observe(element));
    attachmentRefs.current.forEach((element) => observer.observe(element));
    window.addEventListener("resize", scheduleMeasure);
    return () => {
      cancelAnimationFrame(animationFrame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
    };
  }, [nodes, parsedEpisodes, episodeRecords, focusToken, attachments]);

  useEffect(() => {
    const lastText = [...nodes].reverse().find((node): node is TextNode => node.type === "text");
    if (!lastText) return;
    const el = textRefs.current.get(lastText.id);
    el?.focus();
  }, [focusToken]);

  const attachmentById = useMemo(
    () => new Map(attachments.map((attachment) => [attachment.id, attachment])),
    [attachments],
  );

  const currentInsertion = (): InsertionPoint => {
    const saved = insertionRef.current;
    if (saved && nodes.some((node) => node.type === "text" && node.id === saved.nodeId)) return saved;
    const last = [...nodes].reverse().find((node): node is TextNode => node.type === "text");
    return last ? { nodeId: last.id, offset: last.text.length } : { nodeId: nodes[0]?.id ?? "", offset: 0 };
  };

  const globalOffsetForNode = (nodeId: string): number => {
    let offset = 0;
    for (const node of nodesRef.current) {
      if (node.type !== "text") continue;
      if (node.id === nodeId) return offset;
      offset += node.text.length;
    }
    return offset;
  };

  const insertAttachments = (point: InsertionPoint, added: DraftAttachment[]) => {
    if (added.length === 0) return;
    commitNodes((current) => {
      const index = current.findIndex((node) => node.type === "text" && node.id === point.nodeId);
      const target = current[index];
      if (index < 0 || !target || target.type !== "text") return current;
      const offset = Math.max(0, Math.min(point.offset, target.text.length));
      const globalOffset = current.slice(0, index).reduce(
        (total, node) => total + (node.type === "text" ? node.text.length : 0),
        offset,
      );
      const currentText = textOf(current);
      const currentStarts = blockStarts(currentText);
      const blockIndex = blockIndexAt(currentStarts, globalOffset);
      const blockStart = currentStarts[blockIndex] ?? 0;
      const blockEnd = blockContentEnds(currentText)[blockIndex] ?? currentText.length;
      const markerId = blockMarkersRef.current.find((marker) => marker.offset === blockStart)?.id;
      const existingAtOffset = (() => {
        let cursor = 0;
        for (const candidate of current) {
          if (candidate.type === "text") cursor += candidate.text.length;
          else if (cursor === globalOffset && candidate.episodeId) return candidate.episodeId;
        }
        return undefined;
      })();
      const attachmentEpisodeId = currentText.slice(blockStart, blockEnd).trim()
        ? markerId ?? newId()
        : existingAtOffset ?? newId();
      const after = newTextNode(target.text.slice(offset));
      focusAfterCommit.current = { nodeId: after.id, offset: 0 };
      return [
        ...current.slice(0, index),
        { ...target, text: target.text.slice(0, offset) },
        ...added.map((attachment): AttachmentNode => ({
          type: "attachment",
          id: newId(),
          attachmentId: attachment.id,
          episodeId: attachmentEpisodeId,
        })),
        after,
        ...current.slice(index + 1),
      ];
    });
  };

  const addInputs = (
    inputs: Awaited<ReturnType<typeof filesToDraftInputs>>,
    point: InsertionPoint,
  ): Promise<void> => {
    if (!draftLoaded || inputs.length === 0) return Promise.resolve();
    const run = async () => {
      try {
        const before = await window.graph.writeAttachmentsGet();
        const previousIds = new Set(before.attachments.map((attachment) => attachment.id));
        const result = await window.graph.writeAttachmentsAdd(inputs);
        const added = result.draft.attachments.filter((attachment) => !previousIds.has(attachment.id));
        if (!nodesRef.current.some((node) => node.type === "text" && node.id === point.nodeId)) {
          await Promise.all(added.map((attachment) => window.graph.writeAttachmentRemove(attachment.id)));
          return;
        }
        commitAttachments(mergeAttachments(attachmentsRef.current, added));
        insertAttachments(point, added);
        if (result.skipped > 0) setError("Some files couldn’t be attached.");
      } catch (cause) {
        setError((cause as Error).message);
      }
    };
    const queued = attachmentQueueRef.current.then(run, run);
    attachmentQueueRef.current = queued.catch(() => undefined);
    return queued;
  };

  const addFiles = async (files: FileList | File[], point = currentInsertion()) => {
    if (!draftLoaded) return;
    const inputs = await filesToDraftInputs(files);
    if (inputs.length === 0 && files.length > 0) setError("Some files couldn’t be attached.");
    await addInputs(inputs, point);
  };

  addDroppedFilesRef.current = (files: File[]) => {
    void addFiles(files);
  };

  useEffect(() => {
    // In chat mode the window is not a drop target: a staged file would ride the memory
    // draft while the chat submit ignored it.
    if (!composerOnly || !draftLoaded || chatOpen) return;
    let dragDepth = 0;
    const reset = () => {
      dragDepth = 0;
      setDragging(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
      setDragging(true);
    };
    const onDragLeave = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!dragHasFiles(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      const files = Array.from(event.dataTransfer?.files ?? []);
      reset();
      if (files.length > 0) addDroppedFilesRef.current(files);
    };
    window.addEventListener("dragenter", onDragEnter, true);
    window.addEventListener("dragover", onDragOver, true);
    window.addEventListener("dragleave", onDragLeave, true);
    window.addEventListener("drop", onDrop, true);
    window.addEventListener("dragend", reset, true);
    return () => {
      window.removeEventListener("dragenter", onDragEnter, true);
      window.removeEventListener("dragover", onDragOver, true);
      window.removeEventListener("dragleave", onDragLeave, true);
      window.removeEventListener("drop", onDrop, true);
      window.removeEventListener("dragend", reset, true);
      reset();
    };
  }, [composerOnly, draftLoaded]);

  const removeAttachment = (id: string) => {
    commitAttachments(attachmentsRef.current.filter((attachment) => attachment.id !== id));
    commitNodes((current) => current.filter((node) => node.type !== "attachment" || node.attachmentId !== id));
  };

  const removeAdjacentAttachment = (
    event: React.KeyboardEvent<HTMLTextAreaElement>,
    node: TextNode,
    direction: "before" | "after",
  ) => {
    const el = event.currentTarget;
    if (el.selectionStart !== el.selectionEnd) return false;
    if (direction === "before" && el.selectionStart !== 0) return false;
    if (direction === "after" && el.selectionStart !== node.text.length) return false;
    const index = nodes.findIndex((candidate) => candidate.id === node.id);
    const adjacent = nodes[index + (direction === "before" ? -1 : 1)];
    if (!adjacent || adjacent.type !== "attachment") return false;
    event.preventDefault();
    if (direction === "before") {
      const previousText = nodes[index - 2];
      focusAfterCommit.current =
        previousText?.type === "text"
          ? { nodeId: previousText.id, offset: previousText.text.length }
          : { nodeId: node.id, offset: 0 };
    } else {
      focusAfterCommit.current = { nodeId: node.id, offset: node.text.length };
    }
    removeAttachment(adjacent.attachmentId);
    return true;
  };

  const placeCaretOnBlankLine = (clientY: number): boolean => {
    if (!draftLoaded) return false;
    const lastText = [...nodes].reverse().find((node): node is TextNode => node.type === "text");
    if (!lastText) return false;
    const el = textRefs.current.get(lastText.id);
    if (!el) return false;
    const lineHeight = Number.parseFloat(getComputedStyle(el).lineHeight) || 28;
    const targetLine = Math.max(0, Math.floor((clientY - el.getBoundingClientRect().top) / lineHeight));
    const currentLastLine = lastText.text.split("\n").length - 1;
    if (targetLine <= currentLastLine) return false;
    const nextText = `${lastText.text}${"\n".repeat(targetLine - currentLastLine)}`;
    focusAfterCommit.current = { nodeId: lastText.id, offset: nextText.length };
    commitNodes((current) =>
      current.map((node) => (node.id === lastText.id ? { ...lastText, text: nextText } : node)),
    );
    return true;
  };

  const writeText = textOf(nodes);
  const composerStart = trailingDraftStart(writeText);
  const composerText = decodeDraftText(writeText.slice(composerStart));
  const composerAttachmentIds = useMemo(() => {
    const ids: string[] = [];
    let offset = 0;
    nodes.forEach((node) => {
      if (node.type === "text") {
        offset += node.text.length;
      } else if (offset >= trailingDraftStart(textOf(nodes))) {
        ids.push(node.attachmentId);
      }
    });
    return ids;
  }, [nodes]);
  const composerAttachments = composerAttachmentIds.flatMap((id) => {
    const attachment = attachmentById.get(id);
    return attachment ? [attachment] : [];
  });
  const visibleEpisodes = parsedEpisodes.filter((episode) => !dismissedEpisodeIds.has(episode.id));
  // Filing is a TYPED act: `/names` that arrived via paste are ordinary text, so they're
  // recorded here (per draft) and excluded from the spot set. Submitting snapshots that set;
  // the effect below derives spots per completed block, then hands each key to its episode id.
  const pastedTagsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    // An emptied composer abandons its draft, including the provenance of pasted `/names`.
    if (composerOnly && composerText.length === 0) pastedTagsRef.current = new Set();
  }, [composerOnly, composerText]);
  /** The draft's typed spots — the ones that will file (and strip from display) on submit. */
  const typedComposerSpots = composerOnly
    ? parseTags(composerText).filter((tag) => !pastedTagsRef.current.has(tag))
    : [];
  // Typed spot commands aren't content: a draft that is ONLY `/tags` has nothing to say, so
  // it can't submit (the empty card it would make is pure noise). Attachments still count.
  const composerContent = composerOnly
    ? stripTags(composerText, new Set(typedComposerSpots)).trim()
    : composerText.trim();
  const canSubmit = draftLoaded && (composerContent.length > 0 || composerAttachments.length > 0);
  /**
   * Filings are queued in the shared pendingFilings store (lib/tags) at submit and joined to
   * their episode BY TEXT — record ids are offset-keyed and unstable, and the episode id can
   * be assigned and drained away inside one render batch, so no id-keyed or state-observation
   * scheme is reliable. This effect only shows the filing EARLY — a chip under whichever id the
   * matching record currently has — and never consumes the queue entry: every key it can reach
   * is provisional, and a key the board hasn't met yet is pruned as an orphan the moment the
   * record drains. The board's row refetch (HistoryPage) is the one consumer, because a row id
   * is the only key that is live by construction.
   */
  useEffect(() => {
    if (!composerOnly) return;
    for (const record of episodeRecords) {
      const filing = peekPendingFiling(record.text);
      if (!filing) continue;
      // File under the record's CURRENT id every run — addUserTag is a no-op (same map
      // reference) once present, and a re-keyed record simply re-files under its new id.
      // Stale record-keyed entries are pruned once the full list confirms them gone.
      updateUserTags((map) => filing.spots.reduce((next, name) => addUserTag(next, record.id, name), map));
      // Once the daemon has named the episode, wear the chip under that id too, so the card
      // keeps its folder across the hand-off. The board still does the durable filing.
      if (record.episodeId) {
        const episodeId = record.episodeId;
        updateUserTags((map) => filing.spots.reduce((next, name) => addUserTag(next, episodeId, name), map));
      }
    }
  }, [composerOnly, episodeRecords]);

  // `/tag` autocomplete: live while the composer draft — or the search query — ends in an
  // unbroken /token. It's a scrollable list of previously created tags; the token itself is
  // ordinary text (in a note it stays; in search it's a filter term), so completion is optional.
  const tagSourceText = searchActive ? searchText : composerText;
  const tagMenuSuggestions = useMemo(
    () => (composerOnly && !chatOpen && tagMenuDismissedFor !== tagSourceText
      ? tagSuggestions(knownTags, tagSourceText)
      : []),
    [composerOnly, chatOpen, tagMenuDismissedFor, tagSourceText, knownTags],
  );
  const tagMenuOpen = tagMenuSuggestions.length > 0;
  const tagMenuActive = Math.min(tagMenuIndex, Math.max(0, tagMenuSuggestions.length - 1));

  const acceptTagSuggestion = (tag: string) => {
    setTagMenuIndex(0);
    if (searchActive) {
      const next = applyTagSuggestion(readSearchText(), tag);
      writeSearchText(next);
      notifySearch(searchFilters, next);
      return;
    }
    updateComposerText(applyTagSuggestion(composerText, tag));
    requestAnimationFrame(() => {
      const element = composerRef.current;
      if (!element) return;
      element.focus();
      element.setSelectionRange(element.value.length, element.value.length);
    });
  };

  /** Shared keydown handling for the `/` popup; true when the event was consumed. */
  const handleTagMenuKeyDown = (event: React.KeyboardEvent): boolean => {
    if (!tagMenuOpen) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const delta = event.key === "ArrowDown" ? 1 : -1;
      setTagMenuIndex((tagMenuActive + delta + tagMenuSuggestions.length) % tagMenuSuggestions.length);
      return true;
    }
    // Enter (like Tab) completes the highlighted tag rather than submitting the entry or
    // committing a search pill — the menu only opens mid-token, so a finished tag (trailing
    // space or exact name) closes it and Enter regains its normal meaning.
    if (
      event.key === "Tab" ||
      (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing)
    ) {
      event.preventDefault();
      const active = tagMenuSuggestions[tagMenuActive];
      if (active) acceptTagSuggestion(active);
      return true;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation(); // in search mode the outer Escape handler would exit search
      setTagMenuDismissedFor(tagSourceText);
      return true;
    }
    return false;
  };

  const editPendingEntry = (recordId: string, text: string) => {
    const episode = completedEpisodesWithAttachments(
      textOf(nodesRef.current),
      blockMarkersRef.current,
      nodesRef.current,
    ).find((candidate) => candidate.id === recordId);
    if (!episode) return;
    const insert = encodeDraftText(text);
    commitNodes(
      (current) => replaceTextRange(current, episode.start, episode.end, insert),
      { from: episode.start, to: episode.end, insert },
    );
  };

  const deletePendingEntry = async (recordId: string) => {
    const record = episodeRecordsRef.current.find((candidate) => candidate.id === recordId);
    const episode = completedEpisodesWithAttachments(
      textOf(nodesRef.current),
      blockMarkersRef.current,
      nodesRef.current,
    ).find((candidate) => candidate.id === recordId);
    if (!record || !episode) return;
    try {
      await window.graph.pendingDelete({
        id: record.id,
        text: record.text,
        createdAt: record.changedAt,
        spoolId: record.spoolId,
        episodeId: record.episodeId,
        attachmentIds: record.attachmentIds,
      });
    } catch (cause) {
      updateEpisodeRecords((current) => current.map((candidate) =>
        candidate.id === record.id
          ? { ...candidate, error: cause instanceof Error ? cause.message : "The entry could not be deleted." }
          : candidate));
      return;
    }
    const removeIds = new Set(record.attachmentIds);
    commitAttachments(attachmentsRef.current.filter((attachment) => !removeIds.has(attachment.id)));
    commitNodes(
      (current) => replaceTextRange(current, episode.start, episode.end, "", removeIds),
      { from: episode.start, to: episode.end, insert: "" },
    );
    updateEpisodeRecords((current) => current.map((candidate) =>
      candidate.id === record.id
        ? {
            ...candidate,
            present: false,
            inFlight: false,
            operation: "delete",
            operationId: null,
            error: undefined,
          }
        : candidate));
  };

  useEffect(() => {
    if (!onPendingEntriesChange) return;
    onPendingEntriesChange(
      episodeRecords
        .filter((record) =>
          (record.present && !dismissedEpisodeIds.has(record.id)) ||
          (!record.present && record.operation === "delete" && Boolean(record.spoolId)))
        .map((record) => ({
          id: record.id,
          text: record.text,
          attachmentCount: record.attachmentIds.length,
          attachments: record.attachmentIds.flatMap((id) => {
            const attachment = attachmentById.get(id);
            return attachment ? [{
              size: attachment.size,
              isImage: attachment.isImage,
              aspectRatio: attachmentAspectRatios.get(id) ?? null,
            }] : [];
          }),
          status: record.status,
          episodeId: record.episodeId,
          createdAt: record.changedAt,
          spoolId: record.spoolId,
          hidden: !record.present,
          onEdit: (text: string) => editPendingEntry(record.id, text),
          onDelete: () => deletePendingEntry(record.id),
        })),
    );
  }, [attachmentAspectRatios, attachmentById, dismissedEpisodeIds, episodeRecords, onPendingEntriesChange]);

  useEffect(() => {
    // Only the compose textarea auto-grows; the search field is a contentEditable
    // that grows on its own, and composerRef is null while search is active.
    const textarea = composerRef.current;
    if (!textarea) return;
    textarea.style.height = "26px";
    if (textarea.value.length === 0) return;
    textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, 26), 168)}px`;
  }, [composerText, searchActive]);

  useEffect(() => {
    // The omnibar rests collapsed on launch; only an explicit focus request expands it.
    if (focusToken > 0) (searchActive ? searchTextRef.current : composerRef.current)?.focus();
  }, [focusToken, searchActive]);

  useEffect(() => {
    if (searchActive) {
      // Entering search mounts the contentEditable. Restore the translated composer
      // offset instead of always pushing the caret to the end of the query.
      const element = searchTextRef.current;
      if (!element) return;
      if (element.textContent !== searchText) element.textContent = searchText;
      const target = searchCaretTargetRef.current ?? searchText.length;
      searchCaretTargetRef.current = null;
      placeCaretAtOffset(element, target);
      return;
    }
    // The composer remounts when Search closes. A mode-switch requests focus and
    // restores the corresponding offset; blur-driven Search dismissal does neither.
    const target = composerCaretTargetRef.current;
    if (target === null) return;
    composerCaretTargetRef.current = null;
    const element = composerRef.current;
    if (!element) return;
    element.focus();
    const offset = Math.min(target, element.value.length);
    element.setSelectionRange(offset, offset);
  }, [searchActive]);

  useEffect(() => {
    feedEndRef.current?.scrollIntoView({ block: "end" });
  }, [visibleEpisodes.length]);

  const updateComposerText = (value: string) => {
    commitNodes((current) =>
      replaceTrailingDraftText(current, trailingDraftStart(textOf(current)), encodeDraftText(value)),
    );
  };

  // -- dictation (hosted OpenAI; states mirror the Ask popup's mic button) ----------------
  useEffect(() => {
    return () => {
      // Unmount during a recording: stop the tracks so the mic indicator never dangles.
      dictationCaptureRef.current?.dispose();
      dictationCaptureRef.current = null;
      window.clearTimeout(dictationTimerRef.current);
    };
  }, []);

  const stopDictation = async (transcribe = true) => {
    const capture = dictationCaptureRef.current;
    if (!capture) return;
    dictationCaptureRef.current = null;
    window.clearTimeout(dictationTimerRef.current);
    capture.dispose();
    if (!transcribe) {
      setDictationState("idle");
      return;
    }
    const sampleCount = capture.chunks.reduce((total, chunk) => total + chunk.length, 0);
    if (sampleCount < capture.sampleRate / 4) {
      // Tapped the mic and said nothing. That is a non-event, not a failure — the field is
      // untouched and the user can just try again.
      setDictationState("idle");
      return;
    }
    setDictationState("transcribing");
    try {
      const pcm = resamplePcm(capture.chunks, capture.sampleRate, 16_000);
      const wav = encodePcm16Wav([pcm], 16_000);
      const transcript = (await window.graph.dictationTranscribe(wav)).trim();
      if (transcript) {
        // Splice against the text as it is NOW (typing stays enabled while recording), so a
        // draft edited mid-recording is appended to, never clobbered.
        const element = composerRef.current;
        const current = element?.value ?? composerText;
        updateComposerText(current ? `${current.replace(/\s+$/, "")} ${transcript}` : transcript);
      }
    } catch (cause) {
      const raw = (cause as Error).message;
      // Silence isn't a failure either: the transcriber reports an empty result as an error,
      // and surfacing it would put a red line under the bar for doing nothing wrong.
      if (!/no speech was heard/i.test(raw)) {
        // Dictation draws on the same daily allowance as everything else; when it is spent,
        // show the plain sentence rather than the marker-prefixed error.
        setError(usageLimitMessage(raw) ?? raw ?? "Couldn't transcribe that recording");
      }
    } finally {
      setDictationState("idle");
      requestAnimationFrame(() => composerRef.current?.focus());
    }
  };

  const startDictation = async () => {
    if (dictationState !== "idle") return;
    setError(null);
    try {
      // The browser owns the mic prompt: startVoiceCapture throws if it is denied.
      const capture = await startVoiceCapture();
      dictationCaptureRef.current = capture;
      // 120 s of 16 kHz mono 16-bit PCM is 3.84 MB — a sane upload ceiling.
      dictationTimerRef.current = window.setTimeout(() => {
        void stopDictation();
      }, 120_000);
      setDictationState("recording");
    } catch (cause) {
      setDictationState("idle");
      setError((cause as Error).message || "Couldn't use the microphone");
    }
  };

  // Pre-fill `/folder ` when the board is showing a single folder, so a note added while
  // viewing it files there. We only touch the composer while it's "pristine" — empty, or still
  // holding exactly the token we last injected — so an in-progress draft (or a restored one) is
  // never clobbered. Once the user types past the token we stop managing it until it empties
  // again. The `/folder` is left as a normal typed spot (not added to pastedTagsRef), so it files.
  const autoFolderPrefillRef = useRef<string | null>(null);
  useEffect(() => {
    if (!composerOnly || !draftLoaded || searchActive) return;
    const injected = autoFolderPrefillRef.current;
    const pristine = composerText.length === 0 || (injected !== null && composerText === injected);
    if (!pristine) {
      autoFolderPrefillRef.current = null; // user owns the draft now — hands off
      return;
    }
    const desired = activeFolder ? `/${activeFolder} ` : "";
    if (composerText === desired) {
      autoFolderPrefillRef.current = desired.length > 0 ? desired : null;
      return;
    }
    autoFolderPrefillRef.current = desired.length > 0 ? desired : null;
    updateComposerText(desired);
    if (desired.length > 0) {
      const caret = desired.length;
      requestAnimationFrame(() => {
        const element = composerRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(caret, caret);
      });
    }
  }, [composerOnly, draftLoaded, searchActive, activeFolder, composerText]);

  const submitComposer = () => {
    if (!canSubmit) return;
    // Chat mode: the same bar, asking instead of writing. Nothing is captured or filed, and
    // the draft clears the way it would after a note.
    if (chatOpen && composerOnly) {
      const question = composerText.trim();
      if (!question) return;
      onChatSubmit?.(question);
      pastedTagsRef.current = new Set();
      commitNodes(() => [newTextNode()]);
      requestAnimationFrame(() => composerRef.current?.focus());
      return;
    }
    if (composerOnly) {
      // Queue the draft's typed spots against the text the completed record will carry (the
      // block parser trims, and trim eats the draft's encoded line separators the same way).
      // The pasted-set belongs to this draft and dies with it.
      if (typedComposerSpots.length > 0) {
        pushPendingFiling({ text: composerText.trim(), spots: typedComposerSpots });
      }
      pastedTagsRef.current = new Set();
    }
    commitNodes((current) => {
      // Draft line breaks STAY encoded through the submit boundary: one submit is one card,
      // even for a multi-paragraph note (the block parser decodes them when it builds the
      // episode, so the stored text keeps its real newlines).
      let lastTextIndex = -1;
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (current[index]?.type === "text") {
          lastTextIndex = index;
          break;
        }
      }
      return current.map((node, index) =>
        index === lastTextIndex && node.type === "text"
          ? { ...node, text: `${node.text}\n\n` }
          : node,
      );
    });
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const handleFileInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.currentTarget.files;
    if (draftLoaded && files) void addFiles(files);
    event.currentTarget.value = "";
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  /** Compose pills + live text into one query; multi-word pills stay quoted phrases. */
  const notifySearch = (filters: string[], text: string) => {
    const terms = filters.map((term) => (/\s/.test(term) ? `"${term}"` : term));
    onSearchChange?.([...terms, text.trim()].filter(Boolean).join(" "));
  };

  /** The search field is a contentEditable: the DOM (not React) owns the typed
   *  text, so we read it straight off the node and only ever write it imperatively. */
  const readSearchText = () => searchTextRef.current?.textContent ?? "";

  const placeCaretAtOffset = (el: HTMLElement, requestedOffset: number) => {
    el.focus();
    const range = document.createRange();
    const target = Math.max(0, requestedOffset);
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let remaining = target;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) {
        range.setStart(node, remaining);
        range.collapse(true);
        break;
      }
      remaining -= length;
      node = walker.nextNode();
    }
    if (!node) {
      range.selectNodeContents(el);
      range.collapse(false);
    }
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  };

  const placeCaretAtEnd = (el: HTMLElement) => {
    placeCaretAtOffset(el, el.textContent?.length ?? 0);
  };

  const searchCaretOffset = () => {
    const element = searchTextRef.current;
    const selection = window.getSelection();
    const focusNode = selection?.focusNode;
    if (!element || !selection || !focusNode || !element.contains(focusNode)) {
      return element?.textContent?.length ?? 0;
    }
    const before = document.createRange();
    before.selectNodeContents(element);
    before.setEnd(focusNode, selection.focusOffset);
    return before.toString().length;
  };

  const normalizedSearchSeed = (text: string, composerOffset: number) => {
    const searchText = text.replace(/\s+/g, " ").trim();
    const prefix = text.slice(0, composerOffset).replace(/\s+/g, " ").trimStart();
    return { searchText, searchOffset: Math.min(searchText.length, prefix.length) };
  };

  const composerOffsetFromSearch = (text: string, searchOffset: number) => {
    let composerOffset = 0;
    for (let offset = 0; offset <= text.length; offset += 1) {
      if (normalizedSearchSeed(text, offset).searchOffset > searchOffset) break;
      composerOffset = offset;
    }
    return composerOffset;
  };

  /** Push text into the uncontrolled field and keep the mirror state in sync. */
  const writeSearchText = (value: string) => {
    setSearchText(value);
    const el = searchTextRef.current;
    if (!el) return;
    if (el.textContent !== value) el.textContent = value;
    placeCaretAtEnd(el);
  };

  const commitSearchFilter = () => {
    const term = readSearchText().trim().replaceAll('"', "");
    if (!term) return;
    const next = searchFilters.includes(term) ? searchFilters : [...searchFilters, term];
    setSearchFilters(next);
    writeSearchText("");
    notifySearch(next, "");
  };

  const removeSearchFilter = (index: number) => {
    const next = searchFilters.filter((_, at) => at !== index);
    setSearchFilters(next);
    notifySearch(next, readSearchText());
    requestAnimationFrame(() => searchTextRef.current?.focus());
  };

  /** Backspace on an empty field lifts the last pill back into the editable text so
   *  it can be edited (or deleted with one more Backspace) — standard chip-input feel. */
  const popSearchFilterToText = () => {
    const last = searchFilters[searchFilters.length - 1];
    if (last === undefined) return;
    const next = searchFilters.slice(0, -1);
    setSearchFilters(next);
    writeSearchText(last);
    notifySearch(next, last);
  };

  const exitSearch = (restoreComposerCaret = false) => {
    if (restoreComposerCaret) {
      const offset = searchCaretOffset();
      const seed = searchSeedRef.current;
      composerCaretTargetRef.current = seed && seed.composerText === composerText && seed.searchText === readSearchText()
        ? composerOffsetFromSearch(composerText, offset)
        : Math.min(composerText.length, offset);
    }
    setSearchActive(false);
    setSearchText("");
    setSearchFilters([]);
    onSearchChange?.("");
  };

  if (composerOnly) {
    const expanded =
      composerFocused ||
      dragging ||
      searchActive ||
      composerText.length > 0 ||
      composerAttachments.length > 0;
    const omnibarState = `${expanded ? "omnibar-expanded" : "omnibar-collapsed"}${searchActive ? " omnibar-search" : ""}${chatOpen ? " omnibar-chat" : ""}`;
    // Spots the draft will file to on submit — the `/tags` in the note, first-mention order.
    // Search mode never files (its /tokens are filters), so the indicator is composer-only.
    const composerSpots = searchActive || chatOpen ? [] : typedComposerSpots;
    // Tab visible ⇢ the host squares the bar's top-left corner so the two shapes connect
    // (same condition as the note itself: the `/` suggestion menu owns the anchor when open).
    const filing = composerSpots.length > 0 && !tagMenuOpen;
    return (
      <div
        ref={wrapRef}
        className={`memory-write-composer-host omnibar-host ${omnibarState}${filing ? " omnibar-filing" : ""}${dragging ? " dropping" : ""}`}
      >
        <div className="write-composer-wrap">
          {chatOpen && <ChatAnswer />}
          {tagMenuOpen && (
            <div className="tag-command-menu" role="listbox" aria-label="Tag suggestions">
              {tagMenuSuggestions.map((tag, index) => (
                <button
                  type="button"
                  key={tag}
                  role="option"
                  aria-selected={index === tagMenuActive}
                  className={`tag-command-option${index === tagMenuActive ? " active" : ""}`}
                  // Mouse-down (not click) so the textarea never loses focus.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    acceptTagSuggestion(tag);
                  }}
                  onMouseEnter={() => setTagMenuIndex(index)}
                >
                  <FolderGlyph />
                  {tag}
                </button>
              ))}
            </div>
          )}
          {/* Filing note: confirms where a hashtagged note routes before submit. Purely
              informational — pointer events pass through — and it yields to the `/`
              suggestion menu, which anchors to the same spot above the bar. */}
          {filing && (
            <div className="omnibar-file-note" aria-live="polite">
              <FolderGlyph />
              files to {composerSpots.join(", ")}
            </div>
          )}
          {/* The same idea as the popup: the draft's attachments as one horizontally
              scrollable chip row above the bar. */}
          {composerAttachments.length > 0 && (
            <div className="write-composer-attachments">
              {composerAttachments.map((attachment) => (
                <div key={attachment.id} className="write-composer-attachment">
                  {attachment.isImage && attachment.url
                    ? <img src={attachment.url} alt="" />
                    : <span className="glyph" aria-hidden>📄</span>}
                  <span>{middleTruncate(attachment.name, 28)}</span>
                  <button
                    type="button"
                    aria-label={`remove-attachment-${attachment.id}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div
            className="write-composer omnibar"
            onFocusCapture={() => setComposerFocused(true)}
            onBlurCapture={(event) => {
              const next = event.relatedTarget;
              if (next instanceof Node && event.currentTarget.contains(next)) return;
              setComposerFocused(false);
              // Click-off exits an idle search; an active query keeps filtering the
              // board (so clicking a result works) until Esc or the magnifier clears it.
              // Read the live field, not the mirror, which can lag a keystroke.
              if (searchActive && !readSearchText() && searchFilters.length === 0) exitSearch();
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && searchActive) {
                event.preventDefault();
                exitSearch(true);
              }
            }}
          >
            {/* Buttons are absolutely positioned; the field is the only in-flow
                child, so the text always starts at the same inset and state changes
                just slide the buttons along the edges. In search the field is a
                contentEditable so pills sit inline and the query wraps like text. */}
            <div
              className="omnibar-field"
              onMouseDown={(event) => {
                // Clicking empty field space (not a pill or the text itself) drops
                // the caret at the end, so the whole bar reads as one input.
                if (!searchActive) return;
                const target = event.target as HTMLElement;
                if (target === searchTextRef.current) return;
                if (target.closest(".omnibar-filter-pill")) return;
                event.preventDefault();
                if (searchTextRef.current) placeCaretAtEnd(searchTextRef.current);
              }}
            >
              {searchActive ? (
                <>
                  {searchFilters.map((term, index) => (
                    <span key={`${term}-${index}`} className="omnibar-filter-pill" contentEditable={false}>
                      <span>{term}</span>
                      <button
                        type="button"
                        aria-label={`Remove filter ${term}`}
                        onMouseDown={(event) => event.preventDefault()}
                        onClick={() => removeSearchFilter(index)}
                      >
                        ×
                      </button>
                    </span>
                  ))}
                  <span
                    key="omnibar-search-text"
                    ref={searchTextRef}
                    className="omnibar-search-text"
                    contentEditable={draftLoaded}
                    suppressContentEditableWarning
                    role="textbox"
                    aria-label="Search your history"
                    aria-multiline="false"
                    // Drive the placeholder off React state, not CSS :empty — a
                    // contentEditable can keep a stray <br> after you delete the
                    // last char, which would defeat :empty and strand the placeholder.
                    data-empty={searchText.length === 0}
                    data-placeholder={
                      searchFilters.length > 0
                        ? "add another filter..."
                        : "search your history, enter to set a filter..."
                    }
                    spellCheck={false}
                    onInput={() => {
                      const value = readSearchText();
                      setSearchText(value);
                      notifySearch(searchFilters, value);
                    }}
                    onKeyDown={(event) => {
                      // The `/` popup gets first pick (arrows/Tab/Esc) — typing / in search
                      // suggests previously created tags, same as in the composer.
                      if (handleTagMenuKeyDown(event)) return;
                      // Swallow every Enter so the single-line field never takes a
                      // line break; a plain Enter commits, Shift+Enter just no-ops.
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                        event.preventDefault();
                        if (!event.shiftKey) commitSearchFilter();
                        return;
                      }
                      // Backspace on empty text pops the last pill back in as
                      // editable text (delete once more to drop it).
                      if (
                        event.key === "Backspace" &&
                        !event.nativeEvent.isComposing &&
                        readSearchText().length === 0 &&
                        searchFilters.length > 0
                      ) {
                        event.preventDefault();
                        popSearchFilterToText();
                      }
                    }}
                    onPaste={(event) => {
                      // contentEditable pastes rich HTML by default — force flat,
                      // single-line plain text (a query is never multi-line).
                      event.preventDefault();
                      const text = event.clipboardData?.getData("text/plain") ?? "";
                      if (text) document.execCommand("insertText", false, text.replace(/\s+/g, " "));
                    }}
                  />
                </>
              ) : (
                <textarea
                  ref={composerRef}
                  value={composerText}
                  readOnly={!draftLoaded}
                  aria-label="Add anything"
                  placeholder={chatOpen ? "^^ what's up?" : "add anything..."}
                  onChange={(event) => updateComposerText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    // Arrows/Tab/Esc drive the / popup; Enter still submits (a typed /word is
                    // already a valid tag — completion is optional).
                    if (handleTagMenuKeyDown(event)) return;
                    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      submitComposer();
                    }
                  }}
                  onPaste={(event) => {
                    // A pasted `/name` is text, not a filing command — remember it so the
                    // spot set (filing tab + submit) skips it. Only a hand-typed / files.
                    const pasted = event.clipboardData?.getData("text/plain") ?? "";
                    for (const tag of parseTags(pasted)) pastedTagsRef.current.add(tag);
                    const files = event.clipboardData?.files;
                    if (!draftLoaded || !files || files.length === 0) return;
                    event.preventDefault();
                    void addFiles(files);
                  }}
                  autoCapitalize="sentences"
                  autoCorrect="on"
                  autoComplete="off"
                  spellCheck
                />
              )}
            </div>
            <button
              type="button"
              className="write-attach omnibar-btn omnibar-attach"
              disabled={!draftLoaded || chatOpen}
              tabIndex={expanded && !searchActive ? undefined : -1}
              aria-hidden={!expanded || searchActive}
              aria-label="Attach file"
              onClick={() => fileInputRef.current?.click()}
            />
            {/* Search fires on pointer-down so a click from the resting pill
                runs the action immediately, even as the bar expands under it. */}
            {!chatOpen && (
            <button
              type="button"
              className={`write-tool-button omnibar-btn omnibar-search-btn${searchActive ? " active" : ""}`}
              aria-label="Search"
              aria-pressed={searchActive}
              onPointerDown={(event) => {
                event.preventDefault();
                if (searchActive) {
                  exitSearch(true);
                } else {
                  // The contentEditable mounts on this state change; the effect
                  // below moves focus into it once it exists.
                  const composerOffset = composerRef.current?.selectionStart ?? composerText.length;
                  const seed = normalizedSearchSeed(composerText, composerOffset);
                  setSearchFilters([]);
                  setSearchText(seed.searchText);
                  onSearchChange?.(seed.searchText);
                  searchCaretTargetRef.current = seed.searchOffset;
                  searchSeedRef.current = { composerText, searchText: seed.searchText };
                  setSearchActive(true);
                }
              }}
            >
              <SearchGlyph />
            </button>
            )}
            {!searchActive && (
              <button
                type="button"
                className={`write-tool-button omnibar-btn omnibar-chat-btn${chatOpen ? " active" : ""}`}
                aria-label="Chat with Ceb"
                aria-pressed={chatOpen}
                title={chatOpen ? "Leave chat" : "Chat with Ceb"}
                onPointerDown={(event) => {
                  event.preventDefault();
                  // The bar has two exclusive modes; opening chat leaves search.
                  if (!chatOpen && searchActive) exitSearch(true);
                  onToggleChat?.();
                }}
              >
                <ChatGlyph />
              </button>
            )}
            {!searchActive && !chatOpen && (
              <button
                type="button"
                className={`write-tool-button omnibar-btn omnibar-mic write-dictation${dictationState !== "idle" ? ` ${dictationState}` : ""}`}
                disabled={dictationState === "transcribing" || !draftLoaded}
                aria-pressed={dictationState === "recording"}
                aria-label={
                  dictationState === "recording"
                    ? "Stop recording"
                    : dictationState === "transcribing"
                      ? "Transcribing"
                      : "Dictate a note"
                }
                title={
                  dictationState === "recording"
                    ? "Stop recording"
                    : dictationState === "transcribing"
                      ? "Transcribing with GPT-4o mini Transcribe…"
                      : "Dictate a note (up to 2 minutes)"
                }
                // Pointer-down, not click: from the resting pill this button slides 46px as
                // the bar expands under the cursor, so mouseup lands somewhere else and the
                // click never fires — pressing the mic did nothing at all. Same reason the
                // magnifier fires on pointer-down.
                onPointerDown={(event) => {
                  event.preventDefault();
                  if (dictationState === "recording") {
                    void stopDictation();
                    return;
                  }
                  // Speaking into a bar you haven't focused should still put the caret where
                  // the words are going to land.
                  composerRef.current?.focus();
                  void startDictation();
                }}
              >
                <MicrophoneGlyph />
                <span className="stop-glyph" aria-hidden />
              </button>
            )}
            <button
              type="button"
              className="write-send omnibar-btn omnibar-send"
              disabled={searchActive ? searchText.trim().length === 0 : !canSubmit}
              tabIndex={expanded || searchActive ? undefined : -1}
              aria-hidden={!expanded && !searchActive}
              aria-label={searchActive ? "Set search filter" : chatOpen ? "Ask Ceb" : "Add entry"}
              onClick={searchActive ? commitSearchFilter : submitComposer}
            >
              {searchActive ? <ReturnGlyph /> : <span aria-hidden>↑</span>}
            </button>
          </div>
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            multiple
            tabIndex={-1}
            onChange={handleFileInputChange}
          />
          {error && <div className="write-error error-text">{error}</div>}
        </div>
        {dragging && <div className="drop-pill">Drop to attach</div>}
      </div>
    );
  }

  const renderEntryStatus = (record: EpisodeRecord, placement: "inline" | "attachment") => (
    <span
      className={`write-entry-status ${record.status} ${placement}`}
      role="status"
      aria-label={record.status === "done" ? "Added" : record.status === "failed" ? "Add failed" : "Adding"}
    >
      {record.status === "processing" ? (
        <span className="write-processing-dots" aria-hidden><i /><i /><i /></span>
      ) : (
        <span aria-hidden>{record.status === "done" ? "✓" : "!"}</span>
      )}
    </span>
  );

  return (
    <div
      ref={wrapRef}
      className={`write-page chat-write-page${dragging ? " dropping" : ""}`}
      onDragOver={(event) => {
        if (draftLoaded && dragHasFiles(event.dataTransfer)) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (!draftLoaded || !dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      <div ref={paperRef} className="write-paper chat-write-paper">
        <div className="write-feed" aria-label="Writing entries">
          {visibleEpisodes.length === 0 && (
            <div className="write-feed-empty">
              <span>Start writing</span>
              <p>Your entries will appear here in the order you add them.</p>
            </div>
          )}
          {visibleEpisodes.map((episode, index) => {
            const record = episodeRecords.find((candidate) => candidate.id === episode.id);
            const attachmentOnly = episode.text.trim().length === 0 && episode.attachmentIds.length > 0;
            const fading = fadingEpisodeIds.has(episode.id);
            return (
              <div key={episode.id} className={`write-entry-collapse${fading ? " fading" : ""}`}>
                <div className="write-entry-collapse-inner">
                  <div className="write-entry-row">
                    <article
                      className={`write-entry${attachmentOnly ? " attachment-only" : ""}`}
                      data-block-id={episode.id}
                    >
                      {episode.text && (
                        <div className="write-entry-text">
                          {episode.text}
                          {episode.attachmentIds.length === 0 && record && renderEntryStatus(record, "inline")}
                        </div>
                      )}
                      {episode.attachmentIds.length > 0 && (
                        <div
                          className="write-entry-attachments"
                          data-count={Math.min(episode.attachmentIds.length, 6)}
                        >
                          {episode.attachmentIds.map((id, attachmentIndex) => {
                            const attachment = attachmentById.get(id);
                            if (!attachment) return null;
                            const isLast = attachmentIndex === episode.attachmentIds.length - 1;
                            if (attachment.isImage && attachment.url) {
                              return (
                                <span key={id} className="write-entry-attachment-shell">
                                  <img src={attachment.url} alt={attachment.name} />
                                  {isLast && record && renderEntryStatus(record, "attachment")}
                                </span>
                              );
                            }
                            return (
                              <span key={id} className="write-entry-attachment-shell">
                                <span className="write-entry-file">
                                  <span aria-hidden>📄</span>
                                  <span>{middleTruncate(attachment.name, 38)}</span>
                                  <small>{formatBytes(attachment.size)}</small>
                                </span>
                                {isLast && record && renderEntryStatus(record, "attachment")}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </article>
                  </div>
                  {index < visibleEpisodes.length - 1 && <div className="write-entry-divider" aria-hidden />}
                </div>
              </div>
            );
          })}
          <div ref={feedEndRef} />
        </div>

        <div className="write-composer-wrap">
          {composerAttachments.length > 0 && (
            <div className="write-composer-attachments">
              {composerAttachments.map((attachment) => (
                <div key={attachment.id} className="write-composer-attachment">
                  {attachment.isImage && attachment.url
                    ? <img src={attachment.url} alt="" />
                    : <span className="glyph" aria-hidden>📄</span>}
                  <span>{middleTruncate(attachment.name, 28)}</span>
                  <button
                    type="button"
                    aria-label={`remove-attachment-${attachment.id}`}
                    onClick={() => removeAttachment(attachment.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="write-composer">
            <textarea
              ref={composerRef}
              value={composerText}
              readOnly={!draftLoaded}
              aria-label="Write a new entry"
              placeholder="add anything..."
              onChange={(event) => updateComposerText(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submitComposer();
                }
              }}
              onPaste={(event) => {
                const files = event.clipboardData?.files;
                if (!draftLoaded || !files || files.length === 0) return;
                event.preventDefault();
                void addFiles(files);
              }}
              autoFocus
              autoCapitalize="sentences"
              autoCorrect="on"
              autoComplete="off"
              spellCheck
            />
            <div className="write-composer-actions">
              <div className="write-composer-actions-left">
                <button
                  type="button"
                  className="write-attach"
                  disabled={!draftLoaded}
                  aria-label="Attach file"
                  onClick={() => fileInputRef.current?.click()}
                />
                <button
                  type="button"
                  className="write-tool-button"
                  aria-label="Search"
                >
                  <SearchGlyph />
                </button>
              </div>
              <div className="write-composer-actions-right">
                <button
                  type="button"
                  className="write-send"
                  disabled={!canSubmit}
                  aria-label="Add entry"
                  onClick={submitComposer}
                >
                  <span aria-hidden>↑</span>
                </button>
              </div>
            </div>
          </div>
          <input
            ref={fileInputRef}
            className="composer-file-input"
            type="file"
            multiple
            tabIndex={-1}
            onChange={handleFileInputChange}
          />
          {error && <div className="write-error error-text">{error}</div>}
        </div>
      </div>
      {dragging && <div className="drop-pill">Drop to attach</div>}
    </div>
  );

  const isEmpty = textOf(nodes).length === 0 && attachments.length === 0;

  return (
    <div
      ref={wrapRef}
      className={`write-page${dragging ? " dropping" : ""}`}
      onBlur={(event) => {
        if (!draftLoaded) return;
        const nextTarget = event.relatedTarget;
        if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
        if (textOf(nodes).trim().length === 0 && attachments.length === 0) {
          commitNodes(() => [newTextNode()]);
        }
      }}
      onDragOver={(event) => {
        if (draftLoaded && dragHasFiles(event.dataTransfer)) {
          event.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(event) => {
        if (event.currentTarget === event.target) setDragging(false);
      }}
      onDrop={(event) => {
        if (!draftLoaded || !dragHasFiles(event.dataTransfer)) return;
        event.preventDefault();
        setDragging(false);
        void addFiles(event.dataTransfer.files);
      }}
    >
      <div ref={paperRef} className="write-paper">
        {parsedEpisodes.map((episode, index) => {
          const record = episodeRecords.find((candidate) => candidate.id === episode.id);
          const position = markerPositions[index];
          if (!record || !position) return null;
          return (
            <span
              key={record.id}
              className={`episode-marker ${record.status}`}
              data-block-id={record.id}
              style={{ top: position.top, left: position.left }}
              role="status"
              aria-label={record.status === "done" ? "Added to History" : record.status === "failed" ? "Add failed" : "Adding to History"}
            >
              <span aria-hidden>
                {record.status === "done" ? "✅" : record.status === "failed" ? "⚠️" : "👀"}
              </span>
            </span>
          );
        })}
        {isEmpty && <div className="write-placeholder">Write anything…</div>}
        <div
          className="inline-note"
          aria-label="Write"
          onMouseDown={(event) => {
            if (event.target !== event.currentTarget) return;
            if (placeCaretOnBlankLine(event.clientY)) event.preventDefault();
          }}
        >
          {nodes.map((node, index) => {
            if (node.type === "text") {
              const isLast = !nodes.slice(index + 1).some((candidate) => candidate.type === "text");
              const beforeAttachment = nodes[index + 1]?.type === "attachment";
              const attachmentCaret =
                isLast && node.text.length === 0 && nodes[index - 1]?.type === "attachment";
              const betweenAttachments =
                node.text.length === 0 &&
                nodes[index - 1]?.type === "attachment" &&
                nodes[index + 1]?.type === "attachment";
              // The attachment already occupies the textarea's implicit first visual row. When
              // the following segment begins with a newline, collapse that duplicate row so one
              // Enter means "the next line" and only a second Enter leaves a visible blank line.
              const leadingNewlineAfterAttachment =
                nodes[index - 1]?.type === "attachment" && node.text.startsWith("\n");
              return (
                <textarea
                  key={node.id}
                  ref={(el) => {
                    if (el) textRefs.current.set(node.id, el);
                    else textRefs.current.delete(node.id);
                  }}
                  className={`note-text-segment${isLast ? " last" : ""}${beforeAttachment ? " before-attachment" : ""}${attachmentCaret ? " attachment-caret" : ""}${betweenAttachments ? " between-attachments" : ""}${leadingNewlineAfterAttachment ? " leading-newline-after-attachment" : ""}`}
                  value={node.text}
                  readOnly={!draftLoaded}
                  autoFocus={index === 0}
                  onFocus={(event) => {
                    insertionRef.current = { nodeId: node.id, offset: event.currentTarget.selectionStart };
                  }}
                  onSelect={(event) => {
                    insertionRef.current = { nodeId: node.id, offset: event.currentTarget.selectionStart };
                  }}
                  onBeforeInput={(event) => {
                    const nativeEvent = event.nativeEvent as InputEvent;
                    beforeInputRef.current = {
                      nodeId: node.id,
                      selectionStart: event.currentTarget.selectionStart,
                      selectionEnd: event.currentTarget.selectionEnd,
                      inputType: nativeEvent.inputType ?? "",
                    };
                  }}
                  onChange={(event) => {
                    const value = event.target.value;
                    const pending = beforeInputRef.current?.nodeId === node.id ? beforeInputRef.current : null;
                    beforeInputRef.current = null;
                    let edit: TextEdit | undefined;
                    if (pending) {
                      let from = pending.selectionStart;
                      let to = pending.selectionEnd;
                      if (from === to && pending.inputType === "deleteContentBackward") from = Math.max(0, from - 1);
                      if (from === to && pending.inputType === "deleteContentForward") to = Math.min(node.text.length, to + 1);
                      const insertedLength = value.length - (node.text.length - (to - from));
                      if (insertedLength >= 0) {
                        edit = {
                          from: globalOffsetForNode(node.id) + from,
                          to: globalOffsetForNode(node.id) + to,
                          insert: value.slice(from, from + insertedLength),
                        };
                      }
                    }
                    commitNodes(
                      (current) =>
                        current.map((candidate) =>
                          candidate.id === node.id ? { ...node, text: value } : candidate,
                        ),
                      edit,
                    );
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                      event.preventDefault();
                      beforeInputRef.current = null;
                      const from = event.currentTarget.selectionStart;
                      const to = event.currentTarget.selectionEnd;
                      const currentValue = event.currentTarget.value;
                      const nextValue = `${currentValue.slice(0, from)}\n${currentValue.slice(to)}`;
                      flushSync(() => {
                        commitNodes(
                          (current) =>
                            current.map((candidate) =>
                              candidate.type === "text" && candidate.id === node.id
                                ? { ...candidate, text: nextValue }
                                : candidate,
                            ),
                          {
                            from: globalOffsetForNode(node.id) + from,
                            to: globalOffsetForNode(node.id) + to,
                            insert: "\n",
                          },
                        );
                      });
                      const updated = textRefs.current.get(node.id) ?? event.currentTarget;
                      updated.focus();
                      updated.setSelectionRange(from + 1, from + 1);
                      insertionRef.current = { nodeId: node.id, offset: from + 1 };
                      return;
                    }
                    if (event.key === "Backspace" || event.key === "Delete") {
                      beforeInputRef.current = {
                        nodeId: node.id,
                        selectionStart: event.currentTarget.selectionStart,
                        selectionEnd: event.currentTarget.selectionEnd,
                        inputType: event.key === "Backspace" ? "deleteContentBackward" : "deleteContentForward",
                      };
                    }
                    if (event.key === "Backspace") removeAdjacentAttachment(event, node, "before");
                    if (event.key === "Delete") removeAdjacentAttachment(event, node, "after");
                  }}
                  onCut={(event) => {
                    beforeInputRef.current = {
                      nodeId: node.id,
                      selectionStart: event.currentTarget.selectionStart,
                      selectionEnd: event.currentTarget.selectionEnd,
                      inputType: "deleteByCut",
                    };
                  }}
                  onMouseDown={(event) => {
                    if (isLast && placeCaretOnBlankLine(event.clientY)) event.preventDefault();
                  }}
                  onPaste={(event) => {
                    if (!draftLoaded) return;
                    beforeInputRef.current = {
                      nodeId: node.id,
                      selectionStart: event.currentTarget.selectionStart,
                      selectionEnd: event.currentTarget.selectionEnd,
                      inputType: "insertFromPaste",
                    };
                    const files = event.clipboardData?.files;
                    if (!files || files.length === 0) return;
                    event.preventDefault();
                    const point = { nodeId: node.id, offset: event.currentTarget.selectionStart };
                    void filesToDraftInputs(files).then((inputs) => addInputs(inputs, point));
                  }}
                  autoCapitalize="sentences"
                  autoCorrect="on"
                  autoComplete="off"
                  spellCheck
                />
              );
            }

            const attachment = attachmentById.get(node.attachmentId);
            if (!attachment) return null;
            const nextNode = nodes[index + 1];
            const carriesCaret =
              nextNode?.type === "text" &&
              nextNode.text.length === 0 &&
              !nodes.slice(index + 2).some((candidate) => candidate.type === "text");
            const precedesLeadingNewline =
              nextNode?.type === "text" && nextNode.text.startsWith("\n");
            const breaksBeforeFollowingText =
              nextNode?.type === "text" && nextNode.text.length > 0;
            if (attachment.isImage && attachment.url) {
              return (
                <React.Fragment key={node.id}>
                  <figure
                    ref={(element) => {
                      if (element) attachmentRefs.current.set(node.id, element);
                      else attachmentRefs.current.delete(node.id);
                    }}
                    className={`inline-image${carriesCaret ? " carries-caret" : ""}${precedesLeadingNewline ? " precedes-leading-newline" : ""}`}
                  >
                    <img src={attachment.url} alt={attachment.name} />
                    <button aria-label={`remove-attachment-${attachment.id}`} onClick={() => removeAttachment(attachment.id)} />
                  </figure>
                  {breaksBeforeFollowingText && <span className="attachment-text-break" aria-hidden />}
                </React.Fragment>
              );
            }
            return (
              <React.Fragment key={node.id}>
                <div
                  ref={(element) => {
                    if (element) attachmentRefs.current.set(node.id, element);
                    else attachmentRefs.current.delete(node.id);
                  }}
                  className={`inline-file${carriesCaret ? " carries-caret" : ""}${precedesLeadingNewline ? " precedes-leading-newline" : ""}`}
                >
                  <span className="glyph" aria-hidden>📄</span>
                  <span className="meta">
                    <span className="name">{middleTruncate(attachment.name, 34)}</span>
                    <span className="size tertiary">{formatBytes(attachment.size)}</span>
                  </span>
                  <button aria-label={`remove-attachment-${attachment.id}`} onClick={() => removeAttachment(attachment.id)} />
                </div>
                {breaksBeforeFollowingText && <span className="attachment-text-break" aria-hidden />}
              </React.Fragment>
            );
          })}
        </div>

        <button
          type="button"
          className="write-attach"
          disabled={!draftLoaded}
          aria-label="Attach file"
          onClick={() => fileInputRef.current?.click()}
        />
        <input
          ref={fileInputRef}
          className="composer-file-input"
          type="file"
          multiple
          tabIndex={-1}
          onChange={(event) => {
            if (draftLoaded && event.currentTarget.files) void addFiles(event.currentTarget.files);
            event.currentTarget.value = "";
          }}
        />
        {error && <div className="write-error error-text">{error}</div>}
      </div>
      {dragging && <div className="drop-pill">Drop to attach</div>}
    </div>
  );
}
