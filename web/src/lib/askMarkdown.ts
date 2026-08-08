/**
 * Tiny markdown renderer for the isolated ask panel. Escaping happens before any markup is
 * introduced so model output can never supply an HTML tag or an executable link scheme.
 */

/** Marks text removed mid-render so the whitespace around it can be swept up with it. */
const DROP = "\u0002";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderInline(value: string, episodeTokens: readonly string[]): string {
  const tokens: string[] = [];
  const protect = (html: string): string => {
    const marker = `\u0000${tokens.length}\u0000`;
    tokens.push(html);
    return marker;
  };

  let rendered = value.replace(/\u0001(\d+)\u0001/g, (_match, index: string) =>
    protect(episodeTokens[Number(index)] ?? ""),
  );
  rendered = rendered.replace(/`([^`\n]+)`/g, (_match, code: string) =>
    protect(`<code>${code}</code>`),
  );
  rendered = rendered.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^\s<>)]+)\)/gi,
    (_match, text: string, url: string) =>
      protect(`<a data-href="${url}">${text}</a>`),
  );
  rendered = rendered.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  rendered = rendered.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");

  return rendered.replace(/\u0000(\d+)\u0000/g, (_match, index: string) =>
    tokens[Number(index)] ?? "",
  );
}

/** Render the small markdown subset used by ask answers into escaped, inert HTML. */
export function renderMarkdown(md: string): string {
  // Ask reads as a plain conversation: an answer never shows note ids or citation pills. The
  // prompt no longer asks for them, so this only sweeps up what a model still emits — a note's
  // NAME survives as ordinary prose (protected from markdown, so a name full of asterisks
  // cannot bold the rest of the sentence) and the id itself is dropped.
  const episodeTokens: string[] = [];
  const plainMention = (id: string, label?: string): string => {
    const cleanId = id.trim();
    if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(cleanId)) return "";
    const cleanLabel = label?.trim().slice(0, 100);
    // An unnamed citation is pure id — nothing to say in prose, so it goes entirely.
    if (!cleanLabel) return DROP;
    const marker = `\u0001${episodeTokens.length}\u0001`;
    episodeTokens.push(escapeHtml(cleanLabel));
    return marker;
  };
  let protectedMd = md.replace(/<episode\b([^>]*)>([^<]*)<\/episode>/gi, (match, attrs: string, body: string) => {
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? body;
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    return plainMention(id, name || (body.trim() !== id.trim() ? body : undefined)) || match;
  });
  protectedMd = protectedMd.replace(/<episode\b([^>]*)\/>/gi, (match, attrs: string) => {
    const id = /\bid\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ?? "";
    const name = /\bname\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1];
    return plainMention(id, name) || match;
  });
  // A bare id in brackets carries nothing a reader wants. Everything dropped leaves a DROP
  // sentinel instead of vanishing on the spot, so the whitespace it was sitting in goes with
  // it and a sentence closes up ("per the note [ep_9]." -> "per the note.") — done as a
  // targeted sweep over the sentinel rather than a global space collapse, which would flatten
  // the indentation inside fenced code.
  protectedMd = protectedMd.replace(/\[ep_[A-Za-z0-9_.:-]{1,196}\]/g, DROP);
  protectedMd = protectedMd.replace(new RegExp(`[ \\t]*${DROP}`, "g"), "");
  const lines = escapeHtml(protectedMd).replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let fence: string[] | null = null;

  const flushParagraph = (): void => {
    if (paragraph.length === 0) return;
    output.push(`<p>${renderInline(paragraph.join(" "), episodeTokens)}</p>`);
    paragraph = [];
  };
  const flushList = (): void => {
    if (list.length === 0) return;
    output.push(`<ul>${list.map((item) => `<li>${renderInline(item, episodeTokens)}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushText = (): void => {
    flushParagraph();
    flushList();
  };

  for (const line of lines) {
    if (fence) {
      if (/^\s*```\s*$/.test(line)) {
        output.push(`<pre><code>${fence.join("\n")}</code></pre>`);
        fence = null;
      } else {
        fence.push(line);
      }
      continue;
    }

    if (/^\s*```/.test(line)) {
      flushText();
      fence = [];
      continue;
    }
    if (/^\s*$/.test(line)) {
      flushText();
      continue;
    }

    const heading = /^(#{1,3})\s+(.+)$/.exec(line);
    if (heading) {
      flushText();
      const level = heading[1]?.length ?? 1;
      output.push(`<h${level}>${renderInline(heading[2] ?? "", episodeTokens)}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*]\s+(.+)$/.exec(line);
    if (bullet) {
      flushParagraph();
      list.push(bullet[1] ?? "");
      continue;
    }

    flushList();
    paragraph.push(line.trim());
  }

  if (fence) output.push(`<pre><code>${fence.join("\n")}</code></pre>`);
  flushText();
  return output.join("\n");
}
