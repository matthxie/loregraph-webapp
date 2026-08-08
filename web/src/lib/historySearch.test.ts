import { describe, expect, it } from "vitest";
import type { EpisodeListRow } from "../shared/protocol";
import { isSentenceQuery, matchesHistorySearch } from "./historySearch";

const row: EpisodeListRow = {
  id: "ep_note_0001",
  title: "Toronto reference",
  created_at: "2026-07-10T12:00:00Z",
  snippet: "A black and white street photograph",
  raw_text: "Trip ideas with https://example.com",
  media_paths: ["media/street.webp"],
  modality: "image",
  source: "capture",
  entities: ["Jude", "Toronto"],
  concepts: ["street photography", "travel"],
};

describe("matchesHistorySearch", () => {
  it("matches visible keywords, entities, concepts, and content tags", () => {
    expect(matchesHistorySearch(row, "black white")).toBe(true);
    expect(matchesHistorySearch(row, "jude travel")).toBe(true);
    expect(matchesHistorySearch(row, "image link")).toBe(true);
  });

  it("supports quoted phrases and ignores case and accents", () => {
    expect(matchesHistorySearch(row, '"street photograph"')).toBe(true);
    expect(matchesHistorySearch({ ...row, entities: ["Montréal"] }, "MONTREAL")).toBe(true);
  });

  it("requires every search part", () => {
    expect(matchesHistorySearch(row, "Toronto recipe")).toBe(false);
  });

  it("matches the analyzed media/link description", () => {
    const described = { ...row, description: "A rain-soaked crosswalk in Shibuya at night" };
    expect(matchesHistorySearch(described, "shibuya crosswalk")).toBe(true);
    expect(matchesHistorySearch(row, "shibuya")).toBe(false);
  });

  it("matches concrete file types from media paths", () => {
    expect(matchesHistorySearch(row, "webp")).toBe(true);
    const withPdf = { ...row, media_paths: ["media/tax-return.PDF"] };
    expect(matchesHistorySearch(withPdf, "pdf")).toBe(true);
    expect(matchesHistorySearch(withPdf, "pdf toronto")).toBe(true);
    expect(matchesHistorySearch(withPdf, "webp")).toBe(false);
  });

  it("treats jpg and jpeg as the same file type", () => {
    const jpeg = { ...row, media_paths: ["media/photo.jpeg"] };
    expect(matchesHistorySearch(jpeg, "jpg")).toBe(true);
    expect(matchesHistorySearch(jpeg, "jpeg")).toBe(true);
  });

  it("tolerates a null title and missing description from older engines", () => {
    const bare = { ...row, title: null as unknown as string, description: null };
    expect(matchesHistorySearch(bare, "street")).toBe(true);
  });
});

describe("isSentenceQuery", () => {
  it("treats questions as sentences, however short", () => {
    expect(isSentenceQuery("what did I say about the climbing gym")).toBe(true);
    expect(isSentenceQuery("where does Sam work")).toBe(true);
    expect(isSentenceQuery("the gym?")).toBe(true);
    expect(isSentenceQuery("show me my travel plans")).toBe(true);
  });

  it("treats names, phrases, and short lookups as keyword search", () => {
    expect(isSentenceQuery("kyoto")).toBe(false);
    expect(isSentenceQuery("sam chen")).toBe(false);
    expect(isSentenceQuery("climbing gym")).toBe(false);
    expect(isSentenceQuery("")).toBe(false);
    expect(isSentenceQuery("   ")).toBe(false);
  });

  it("keeps a quoted phrase on the exact-match path", () => {
    expect(isSentenceQuery('what did I say about "the climbing gym"')).toBe(false);
  });

  it("keeps content-type filters local, however many words", () => {
    expect(isSentenceQuery("pdf receipts")).toBe(false);
    expect(isSentenceQuery("image black and white street")).toBe(false);
    expect(isSentenceQuery("what pdf did I save")).toBe(false);
  });

  it("reads four plain words as a sentence, but two or three as a lookup", () => {
    expect(isSentenceQuery("dinner with sam last friday")).toBe(true);
    expect(isSentenceQuery("dinner with sam")).toBe(false);
  });

  it("ignores punctuation and case when reading the opener", () => {
    expect(isSentenceQuery("Why, exactly, did we switch?")).toBe(true);
    expect(isSentenceQuery("HOW did the migration go")).toBe(true);
  });
});
