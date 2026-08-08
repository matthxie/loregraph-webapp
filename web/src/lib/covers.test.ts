// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { clearCover, getCovers, loadCovers, pruneCovers, resetCoversForTests, setCover } from "./covers";

const PNG = "data:image/png;base64,iVBORw0KGgo=";

describe("collection covers", () => {
  afterEach(() => {
    localStorage.clear();
    resetCoversForTests();
  });

  it("round-trips through the prefs mirror, keyed case-insensitively", () => {
    setCover("Coffee", PNG);
    expect(getCovers()).toEqual({ coffee: PNG });
    resetCoversForTests();
    expect(loadCovers()).toEqual({ coffee: PNG });

    clearCover("COFFEE");
    expect(getCovers()).toEqual({});
  });

  it("drops anything that isn't an image data URL", () => {
    // A stored URL is rendered straight into background-image, so only data: images load.
    localStorage.setItem(
      "ceb.prefs.collection-covers",
      JSON.stringify({ a: PNG, b: "javascript:alert(1)", c: 42, d: "https://example.com/x.png" }),
    );
    resetCoversForTests();
    expect(loadCovers()).toEqual({ a: PNG });
  });

  it("prunes covers whose collection is gone", () => {
    setCover("coffee", PNG);
    setCover("travel", PNG);
    pruneCovers(new Set(["coffee"]));
    expect(getCovers()).toEqual({ coffee: PNG });
  });

  it("survives a corrupt stored value", () => {
    localStorage.setItem("ceb.prefs.collection-covers", "{not json");
    resetCoversForTests();
    expect(loadCovers()).toEqual({});
  });
});
