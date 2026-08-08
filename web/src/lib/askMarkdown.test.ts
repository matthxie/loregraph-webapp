import { describe, expect, it } from "vitest";

import { renderMarkdown } from "./askMarkdown";

describe("renderMarkdown", () => {
  it("escapes model-supplied HTML before rendering markdown", () => {
    const rendered = renderMarkdown("<script>alert('nope')</script> **safe**");

    expect(rendered).not.toContain("<script>");
    expect(rendered).toContain("&lt;script&gt;");
    expect(rendered).toContain("<strong>safe</strong>");
  });

  it("renders headings, inline styles, code, and bullet lists", () => {
    const rendered = renderMarkdown(
      "## Answer\n\nUse **bold**, *italic*, and `code`.\n\n- first\n* second",
    );

    expect(rendered).toContain("<h2>Answer</h2>");
    expect(rendered).toContain("<strong>bold</strong>");
    expect(rendered).toContain("<em>italic</em>");
    expect(rendered).toContain("<code>code</code>");
    expect(rendered).toContain("<ul><li>first</li><li>second</li></ul>");
  });

  it("renders fenced code without interpreting its contents", () => {
    expect(renderMarkdown("```html\n<strong>not markup</strong>\n```")).toContain(
      "<pre><code>&lt;strong&gt;not markup&lt;/strong&gt;</code></pre>",
    );
  });

  it("renders only http and https links", () => {
    const rendered = renderMarkdown(
      "[safe](https://example.com/path) [unsafe](javascript:alert(1))",
    );

    expect(rendered).toContain('<a data-href="https://example.com/path">safe</a>');
    expect(rendered).toContain("[unsafe](javascript:alert(1))");
    expect(rendered).not.toContain('data-href="javascript:');
  });

  it("keeps a cited note's name as prose and drops its id", () => {
    const rendered = renderMarkdown(
      'See <episode id="ep_123" name="Dinner with Ana"></episode>, <episode id="ep_789" name="Trip" />, and [ep_456].',
    );

    expect(rendered).toBe("<p>See Dinner with Ana, Trip, and.</p>");
    expect(rendered).not.toContain("ep_");
    expect(rendered).not.toContain("episode-pill");
    expect(rendered).not.toContain("<episode");
  });

  it("drops an unnamed citation with the space it was sitting in", () => {
    expect(renderMarkdown('You booked it on the 14th <episode id="ep_1" />.')).toBe(
      "<p>You booked it on the 14th.</p>",
    );
  });

  it("leaves a cited name inert rather than letting it turn into markdown", () => {
    const rendered = renderMarkdown('From <episode id="ep_1" name="**loud** note"></episode> today.');

    expect(rendered).toBe("<p>From **loud** note today.</p>");
    expect(rendered).not.toContain("<strong>");
  });

  it("escapes episode labels and rejects unsafe ids", () => {
    const rendered = renderMarkdown(
      '<episode id="ep_good" name="&lt;img&gt;"></episode> <episode id="bad id">nope</episode>',
    );

    expect(rendered).toContain("&amp;lt;img&amp;gt;");
    expect(rendered).toContain("&lt;episode id=&quot;bad id&quot;&gt;nope&lt;/episode&gt;");
  });
});
