// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  collectionKind,
  getKinds,
  loadKinds,
  pruneKinds,
  resetKindsForTests,
  setCollectionKind,
} from "./collectionKinds";

describe("collection kinds", () => {
  afterEach(() => {
    localStorage.clear();
    resetKindsForTests();
  });

  it("defaults to grid, which is what every collection was before canvases", () => {
    expect(collectionKind("anything")).toBe("grid");
  });

  it("round-trips and matches case-insensitively", () => {
    setCollectionKind("Moodboard", "canvas");
    expect(collectionKind("moodboard")).toBe("canvas");
    expect(collectionKind("MOODBOARD")).toBe("canvas");
    resetKindsForTests();
    expect(loadKinds()).toEqual({ moodboard: "canvas" });
  });

  it("ignores values that aren't a kind", () => {
    localStorage.setItem(
      "ceb.prefs.collection-kinds",
      JSON.stringify({ a: "canvas", b: "freeform", c: 3 }),
    );
    resetKindsForTests();
    expect(loadKinds()).toEqual({ a: "canvas" });
  });

  it("prunes kinds whose collection is gone", () => {
    setCollectionKind("a", "canvas");
    setCollectionKind("b", "canvas");
    pruneKinds(new Set(["a"]));
    expect(getKinds()).toEqual({ a: "canvas" });
  });

  it("survives a corrupt stored value", () => {
    localStorage.setItem("ceb.prefs.collection-kinds", "{nope");
    resetKindsForTests();
    expect(loadKinds()).toEqual({});
  });
});
