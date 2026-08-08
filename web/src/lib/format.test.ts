import { describe, expect, it } from "vitest";

import { entitySegments, markdownToSnippet, previewText } from "./format";

/** The marked entity slices, in order. */
function marked(text: string, entities: string[]): string[] {
  return entitySegments(text, entities).flatMap((s) => (s.kind === "entity" ? [s.text] : []));
}

describe("entitySegments", () => {
  it("marks an entity where it appears in the text", () => {
    expect(marked("watching soccer and eating chips", ["soccer", "chips"])).toEqual([
      "soccer",
      "chips",
    ]);
  });

  it("matches case-insensitively but keeps the user's spelling", () => {
    expect(marked("should work with llms more", ["LLMs"])).toEqual(["llms"]);
  });

  it("marks every occurrence", () => {
    expect(marked("personal first, dogfood through personal", ["personal"])).toEqual([
      "personal",
      "personal",
    ]);
  });

  it("skips entities that are not in the text (inferred/canonicalized)", () => {
    expect(marked("maybe do shrimp for dinner tn", ["me", "tonight", "shrimp"])).toEqual([
      "shrimp",
    ]);
  });

  it("respects word boundaries", () => {
    expect(marked("shipping software today", ["war", "hip"])).toEqual([]);
  });

  it("prefers the longer entity on overlap", () => {
    expect(marked("buy oat milk today", ["milk", "oat milk"])).toEqual(["oat milk"]);
  });

  it("never marks inside a link", () => {
    const segments = entitySegments("https://apple.com is down", ["apple"]);
    expect(segments.filter((s) => s.kind === "entity")).toEqual([]);
    expect(segments.some((s) => s.kind === "link")).toBe(true);
  });

  it("reassembles to the exact original text", () => {
    const text = "went to Lakeview Park  with\nSam";
    const joined = entitySegments(text, ["Lakeview Park", "Sam"])
      .map((s) => (s.kind === "link" ? s.url : s.text))
      .join("");
    expect(joined).toBe(text);
  });
});

describe("previewText", () => {
  it("lowercases the text", () => {
    expect(previewText("Dinner With Sam At The Deli")).toBe("dinner with sam at the deli");
  });

  it("reads an em or en dash as a comma", () => {
    expect(previewText("Ceb — a memory app")).toBe("ceb, a memory app");
    expect(previewText("open 9–5 daily")).toBe("open 9, 5 daily");
  });

  it("drops a dash that joins nothing", () => {
    expect(previewText("— quote\nsecond line —")).toBe("quote\nsecond line");
  });

  it("keeps line breaks", () => {
    expect(previewText("First line — here\nSecond")).toBe("first line, here\nsecond");
  });

  it("leaves a URL's case and punctuation alone", () => {
    expect(previewText("Watch https://youtu.be/AbCdEf, It's Good")).toBe(
      "watch https://youtu.be/AbCdEf, it's good",
    );
  });

  it("leaves text without dashes or capitals untouched", () => {
    expect(previewText("buy oat milk")).toBe("buy oat milk");
  });
});

describe("markdownToSnippet", () => {
  it("preserves entered line breaks while collapsing horizontal whitespace", () => {
    expect(markdownToSnippet("first paragraph\n\nsecond\t paragraph")).toBe(
      "first paragraph\n\nsecond paragraph",
    );
  });

  it("normalizes Windows line breaks without removing them", () => {
    expect(markdownToSnippet("first line\r\nsecond line")).toBe("first line\nsecond line");
  });
});
