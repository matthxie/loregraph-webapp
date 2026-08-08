// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import {
  addUserTag,
  applyTagSuggestion,
  backfillHashtagUserTags,
  cardTagChips,
  getCreatedFolders,
  getUserTags,
  hasAllTags,
  knownCreatedTags,
  loadCreatedFolders,
  loadUserTags,
  normalizeFolderName,
  parseTags,
  reconcileUserTags,
  removeUserTag,
  resetCreatedFoldersForTests,
  resetUserTagsForTests,
  setUserTags,
  splitSearchTags,
  spotNames,
  stripTags,
  tagSuggestions,
  tagTyping,
} from "./tags";

describe("parseTags", () => {
  it("finds /tags at start of text or after whitespace; lowercases; dedupes", () => {
    expect(parseTags("/homework due friday")).toEqual(["homework"]);
    expect(parseTags("did my /Homework and /math")).toEqual(["homework", "math"]);
    expect(parseTags("/a /b /a /A")).toEqual(["a", "b"]);
    expect(parseTags("/with-dash /under_score /número")).toEqual(["with-dash", "under_score", "número"]);
  });

  it("ignores paths (folder names can't contain /), urls, brackets, mid-word, bare /, legacy #", () => {
    expect(parseTags("/usr/local at the start is a path, not a command")).toEqual([]);
    expect(parseTags("see /etc/hosts for details")).toEqual([]);
    expect(parseTags("see example.com/section")).toEqual([]);
    expect(parseTags("https://bio.com and a/b")).toEqual([]);
    expect(parseTags("wrap (/school) up")).toEqual([]); // whitespace or start only — no brackets
    expect(parseTags("just a / alone")).toEqual([]);
    expect(parseTags("#homework is text now")).toEqual([]); // old syntax no longer files
    expect(parseTags("")).toEqual([]);
  });
});

describe("normalizeFolderName", () => {
  it("turns display names into targetable slash-command names", () => {
    expect(normalizeFolderName(" Reading List ")).toBe("Reading-List");
    expect(normalizeFolderName(" /Project Notes ")).toBe("Project-Notes");
  });
});

describe("splitSearchTags", () => {
  it("separates /tokens (quoted or bare) from the text query and intersect-dedupes", () => {
    expect(splitSearchTags("/homework")).toEqual({ tags: ["homework"], rest: "" });
    expect(splitSearchTags("/homework /math essay")).toEqual({ tags: ["homework", "math"], rest: "essay" });
    expect(splitSearchTags('"/homework" tea')).toEqual({ tags: ["homework"], rest: "tea" });
    expect(splitSearchTags("/HomeWork /homework")).toEqual({ tags: ["homework"], rest: "" });
    expect(splitSearchTags("a/b plain")).toEqual({ tags: [], rest: "a/b plain" });
    expect(splitSearchTags("")).toEqual({ tags: [], rest: "" });
  });

  it("supports quoted folder filters containing spaces", () => {
    expect(splitSearchTags('"/a b"')).toEqual({ tags: ["a b"], rest: "" });
    expect(splitSearchTags('"/homework with space" text')).toEqual({
      tags: ["homework with space"],
      rest: "text",
    });
  });

  it("hasAllTags is the intersection rule", () => {
    expect(hasAllTags(["a", "b"], ["a"])).toBe(true);
    expect(hasAllTags(["a", "b"], ["a", "b"])).toBe(true);
    expect(hasAllTags(["a"], ["a", "b"])).toBe(false);
    expect(hasAllTags([], [])).toBe(true);
  });
});

describe("card chips", () => {
  const row = {
    raw_text: "algebra set #homework due friday",
    entities: ["Mrs. Smith", "Homework"],
    concepts: ["algebra", "school"],
  };

  it("user spots come from the map only (accent), entities + concepts neutral, deduped", () => {
    // Raw-text hashtags do NOT mint chips — filing lives in the UserTagMap.
    const chips = cardTagChips(row, ["Homework", "urgent"]);
    expect(chips).toEqual([
      { name: "Homework", user: true }, // the entity repeat collapsed into the user chip
      { name: "urgent", user: true },
      { name: "Mrs. Smith", user: false },
      { name: "algebra", user: false },
      { name: "school", user: false },
    ]);
    expect(cardTagChips(row)).toEqual([
      { name: "Mrs. Smith", user: false },
      { name: "Homework", user: false },
      { name: "algebra", user: false },
      { name: "school", user: false },
    ]);
  });

  it("spotNames is the lowercase filter set — user spots only, never entities/concepts", () => {
    // A card whose text or extraction merely contains "test" must not match a /test filter.
    expect(spotNames(["Homework", "urgent"])).toEqual(new Set(["homework", "urgent"]));
    expect(spotNames()).toEqual(new Set());
  });
});

describe("stripTags", () => {
  const names = new Set(["homework", "bio"]);

  it("removes filed spot tokens — current /syntax and legacy #syntax — and tidies the hole", () => {
    expect(stripTags("/homework one test", names)).toBe("one test");
    expect(stripTags("did /homework today", names)).toBe("did today");
    expect(stripTags("/homework\nbody line", names)).toBe("body line");
    expect(stripTags("one\n\n/bio\n\ntwo", names)).toBe("one\n\ntwo");
    expect(stripTags("#homework one test", names)).toBe("one test"); // legacy notes still strip
  });

  it("leaves unfiled tokens, paths, and everything else alone", () => {
    expect(stripTags("keep /other tags", names)).toBe("keep /other tags");
    expect(stripTags("see /bio/x stays", names)).toBe("see /bio/x stays"); // path, not a command
    expect(stripTags("url.com/homework stays", names)).toBe("url.com/homework stays");
    expect(stripTags("no tags here", names)).toBe("no tags here");
    const untouched = "plain text";
    expect(stripTags(untouched, new Set())).toBe(untouched);
  });

  it("/ syntax: bracket prefixes don't strip (filing requires whitespace-or-start only)", () => {
    // "(/bio)" can never be a filing command — the "(" is regular text
    expect(stripTags("wrap (/bio) up", names)).toBe("wrap (/bio) up");
    expect(stripTags("note [/homework] here", names)).toBe("note [/homework] here");
    expect(stripTags("use {/bio} in text", names)).toBe("use {/bio} in text");
  });

  it("# syntax (legacy): bracket prefixes DO strip, preserving old behavior", () => {
    // Legacy notes supported bracket prefixes for compatibility
    expect(stripTags("wrap (#bio) up", names)).toBe("wrap () up");
    expect(stripTags("note [#homework] here", names)).toBe("note [] here");
    expect(stripTags("use {#bio} in text", names)).toBe("use {} in text");
  });

  it("regex special chars in names are safe: matched via Set lookup, not interpolated", () => {
    // Names containing regex chars like "-" or unicode don't cause injection
    // (the name is matched via Set, not interpolated into the pattern)
    const specialNames = new Set(["a-b", "número"]);
    expect(stripTags("filed to /a-b here", specialNames)).toBe("filed to here");
    expect(stripTags("Spanish /número tag", specialNames)).toBe("Spanish tag");
  });
});

describe("user tags", () => {
  it("adds (tolerating a typed / or legacy #), rejects slashes in names, removes case-insensitively", () => {
    expect(addUserTag({}, "ep_1", "usr/local")).toEqual({}); // folder names can't contain /
    let map = addUserTag({}, "ep_1", " /urgent ");
    expect(map).toEqual({ ep_1: ["urgent"] });
    expect(addUserTag(map, "ep_1", "URGENT")).toBe(map);
    expect(addUserTag(map, "ep_1", "  ")).toBe(map);
    expect(addUserTag({}, "ep_1", "Reading List")).toEqual({ ep_1: ["Reading-List"] });
    map = addUserTag(map, "ep_1", "later");
    map = removeUserTag(map, "ep_1", "Urgent");
    expect(map).toEqual({ ep_1: ["later"] });
    expect(removeUserTag(map, "ep_2", "x")).toBe(map);
    expect(removeUserTag(removeUserTag(map, "ep_1", "later"), "ep_1", "x")).toEqual({});
  });

  it("reconciles across edits and deletes like pins", () => {
    const map = { ep_old: ["urgent"], ep_live: ["keep"], ep_gone: ["drop"], ep_mid: ["wait"] };
    const entries = [
      { id: "e1", replacesEpisodeId: "ep_old", episodeId: "ep_new" },
      { id: "e2", replacesEpisodeId: "ep_mid", episodeId: null },
    ];
    const next = reconcileUserTags(map, new Set(["ep_live", "ep_new"]), entries, true);
    expect(next).toEqual({ ep_new: ["urgent"], ep_live: ["keep"], ep_mid: ["wait"] });
    // Incomplete list → nothing pruned (ep_gone survives), but migrations still apply.
    expect(reconcileUserTags(map, new Set(), entries, false)).toEqual({
      ep_new: ["urgent"],
      ep_live: ["keep"],
      ep_gone: ["drop"],
      ep_mid: ["wait"],
    });
    // No edits + incomplete list → untouched, same reference.
    expect(reconcileUserTags(map, new Set(), [], false)).toBe(map);
  });

  it("walks a fresh capture's spots from the pending record id to its episode id", () => {
    const map = { rec_1: ["bio"], rec_2: ["math"] };
    // Mid-flight (no episode yet): the pending key survives even a full-list prune.
    expect(reconcileUserTags(map, new Set(), [{ id: "rec_1", episodeId: null }, { id: "rec_2", episodeId: null }], true))
      .toEqual(map);
    // Episode assigned: the key follows it and the pending key is gone.
    const next = reconcileUserTags(map, new Set(["ep_9"]), [
      { id: "rec_1", episodeId: "ep_9" },
      { id: "rec_2", episodeId: null },
    ], true);
    expect(next).toEqual({ ep_9: ["bio"], rec_2: ["math"] });
  });

  it("backfills pre-map hashtag rows into the map, once and idempotently", () => {
    const rows = [
      { id: "ep_1", raw_text: "#Math one" },
      { id: "ep_2", raw_text: "plain" },
    ];
    const map = backfillHashtagUserTags(rows, { ep_1: ["extra"] });
    expect(map).toEqual({ ep_1: ["extra", "math"] }); // legacy parse lowercases

    expect(backfillHashtagUserTags(rows, map)).toBe(map); // nothing new → same reference
  });

  it("round-trips through the prefs mirror and drops junk", () => {
    localStorage.clear();
    resetUserTagsForTests();
    setUserTags({ ep_1: ["urgent"] });
    resetUserTagsForTests();
    expect(getUserTags()).toEqual({ ep_1: ["urgent"] });
    localStorage.setItem("ceb.prefs.user-tags", '{"ep_2": "not-an-array", "ep_3": ["ok", 5, "  "]}');
    resetUserTagsForTests();
    expect(loadUserTags()).toEqual({ ep_3: ["ok"] });
    localStorage.setItem("ceb.prefs.user-tags", "{corrupt");
    expect(loadUserTags()).toEqual({});
  });

  it("migrates and persists legacy folder names with spaces without duplicating collisions", () => {
    localStorage.setItem(
      "ceb.prefs.user-tags",
      JSON.stringify({
        ep_1: ["Reading List", "reading-list", " Work Notes ", 5],
        ep_junk: "not-an-array",
      }),
    );
    resetUserTagsForTests();

    expect(getUserTags()).toEqual({ ep_1: ["Reading-List", "Work-Notes"] });
    expect(JSON.parse(localStorage.getItem("ceb.prefs.user-tags") ?? "null")).toEqual({
      ep_1: ["Reading-List", "Work-Notes"],
    });
  });
});

describe("created folders", () => {
  it("migrates, lowercases, deduplicates, and persists legacy names with spaces", () => {
    localStorage.clear();
    localStorage.setItem(
      "ceb.prefs.created-folders",
      JSON.stringify(["Reading List", "reading-list", " Work Notes ", 5]),
    );
    resetCreatedFoldersForTests();

    expect(loadCreatedFolders()).toEqual(["reading-list", "work-notes"]);
    resetCreatedFoldersForTests();
    expect(getCreatedFolders()).toEqual(["reading-list", "work-notes"]);
    expect(JSON.parse(localStorage.getItem("ceb.prefs.created-folders") ?? "null"))
      .toEqual(["reading-list", "work-notes"]);
  });
});

describe("knownCreatedTags", () => {
  it("reads the map only, scoped to live cards, lowercased and sorted", () => {
    const rows = [
      { id: "ep_1", raw_text: "#Math one" }, // raw hashtag alone is NOT a spot (pre-backfill)
      { id: "ep_2", raw_text: "plain" },
    ];
    expect(knownCreatedTags(rows, { ep_1: ["Math"], ep_2: ["Urgent"], ep_gone: ["stale"] }))
      .toEqual(["math", "urgent"]);
    expect(knownCreatedTags(rows, {})).toEqual([]);
  });
});

describe("composer / autocomplete", () => {
  beforeEach(() => {
    localStorage.clear();
    resetUserTagsForTests();
  });
  const known = ["homework", "home", "math"];

  it("detects an in-progress trailing /token only", () => {
    expect(tagTyping("essay /ho")).toEqual({ prefix: "essay /", partial: "ho" });
    expect(tagTyping("/")).toEqual({ prefix: "/", partial: "" });
    expect(tagTyping("essay /ho ")).toBeNull(); // whitespace ends the tag — nothing to complete
    expect(tagTyping("essay")).toBeNull();
    expect(tagTyping("url.com/frag")).toBeNull(); // mid-word slash is a path, not a command
  });

  it("suggests known tags by prefix, excluding an exact match", () => {
    expect(tagSuggestions(known, "essay /ho")).toEqual(["homework", "home"]);
    expect(tagSuggestions(known, "essay /home")).toEqual(["homework"]);
    expect(tagSuggestions(known, "/")).toEqual(["homework", "home", "math"]);
    expect(tagSuggestions(known, "essay /zzz")).toEqual([]);
    expect(tagSuggestions(known, "essay")).toEqual([]);
  });

  it("applyTagSuggestion completes the token and adds a space", () => {
    expect(applyTagSuggestion("essay /ho", "homework")).toBe("essay /homework ");
    expect(applyTagSuggestion("/", "math")).toBe("/math ");
    expect(applyTagSuggestion("essay", "math")).toBe("essay");
  });
});
