// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPins, reconcilePins, resetPinsForTests, savePins } from "./pins";

describe("pins store", () => {
  beforeEach(() => resetPinsForTests());
  afterEach(() => localStorage.clear());

  it("round-trips through the prefs mirror", () => {
    expect(loadPins()).toEqual([]);
    savePins(["ep_a", "ep_b"]);
    expect(loadPins()).toEqual(["ep_a", "ep_b"]);
  });

  it("ignores a corrupt persisted value", () => {
    localStorage.setItem("ceb.prefs.pins", "{not json");
    expect(loadPins()).toEqual([]);
    localStorage.setItem("ceb.prefs.pins", JSON.stringify({ nope: 1 }));
    expect(loadPins()).toEqual([]);
    localStorage.setItem("ceb.prefs.pins", JSON.stringify(["ok", 3, null]));
    expect(loadPins()).toEqual(["ok"]);
  });
});

describe("reconcilePins", () => {
  it("keeps live pins and returns the SAME reference when nothing changed", () => {
    const pins = ["ep_a", "ep_b"];
    const result = reconcilePins(pins, new Set(["ep_a", "ep_b", "ep_c"]), []);
    expect(result).toBe(pins);
  });

  it("drops a pin whose episode was deleted (complete list)", () => {
    const result = reconcilePins(["ep_a", "ep_b"], new Set(["ep_a"]), []);
    expect(result).toEqual(["ep_a"]);
  });

  it("keeps a missing pin when the list is truncated (aged out of window, not deleted)", () => {
    const pins = ["ep_a"];
    // ep_a is absent from the capped top-2000 page, but the page is incomplete → keep, don't drop.
    const result = reconcilePins(pins, new Set(["ep_b", "ep_c"]), [], false);
    expect(result).toBe(pins);
  });

  it("still migrates across an edit even when the list is truncated", () => {
    const result = reconcilePins(
      ["ep_a"],
      new Set(["ep_b"]),
      [{ replacesEpisodeId: "ep_a", episodeId: "ep_b" }],
      false,
    );
    expect(result).toEqual(["ep_b"]);
  });

  it("migrates a pin across a completed edit (A replaced by B), preserving order", () => {
    const result = reconcilePins(
      ["ep_a", "ep_keep"],
      new Set(["ep_b", "ep_keep"]), // A is gone from the live list, B took its place
      [{ replacesEpisodeId: "ep_a", episodeId: "ep_b" }],
    );
    expect(result).toEqual(["ep_b", "ep_keep"]);
  });

  it("keeps a pin whose episode is mid-edit (reingest queued, no new id yet)", () => {
    // The old episode still exists until the replacement lands, so the live set still has it.
    const result = reconcilePins(
      ["ep_a"],
      new Set(["ep_a"]),
      [{ replacesEpisodeId: "ep_a", episodeId: null }],
    );
    expect(result).toEqual(["ep_a"]);
  });

  it("keeps a mid-edit pin even after the old episode leaves the live list", () => {
    const result = reconcilePins(
      ["ep_a"],
      new Set([]), // brief window: old gone, new not fetched yet, still processing
      [{ replacesEpisodeId: "ep_a", episodeId: null }],
    );
    expect(result).toEqual(["ep_a"]);
  });

  it("dedupes when two pins collapse onto one id via edits", () => {
    const result = reconcilePins(
      ["ep_a", "ep_b"],
      new Set(["ep_c"]),
      [
        { replacesEpisodeId: "ep_a", episodeId: "ep_c" },
        { replacesEpisodeId: "ep_b", episodeId: "ep_c" },
      ],
    );
    expect(result).toEqual(["ep_c"]);
  });
});
