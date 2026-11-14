// Minimal zero-dependency Markdown renderer for assistant messages.
// Security model: ALL text is HTML-escaped before any inline formatting is
// applied, so model output can never inject raw HTML. Only the tags this
// module emits exist in the result. Links are restricted to http(s)/relative.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Inline formatting: `code` → **bold** → *italic* → [link](url). */
function inline(text) {
  let s = escapeHtml(text);
  const codes = [];
  // Stash inline code first so its content is not mangled by later rules.
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  });
  // Links: http(s) absolute or site-relative paths only.
  s = s.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  s = s.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*\w])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => `<code>${codes[Number(n)]}</code>`);
  return s.replace(/\n/g, "<br>");
}

/** Flatten a list block into <ul>/<ol> with one nesting level via indentation. */
function renderList(items, ordered, start, indent) {
  const tag = ordered ? "ol" : "ul";
  let html = `<${tag}>`;
  let i = start;
  while (i < items.length && items[i].indent >= indent) {
    let content = inline(items[i].text);
    i++;
    if (i < items.length && items[i].indent > indent) {
      const sub = renderList(items, ordered, i, items[i].indent);
      content += sub.html;
      i = sub.next;
    }
    html += `<li>${content}</li>`;
  }
  return { html: `${html}</${tag}>`, next: i };
}

const FENCE_OPEN = /^\s*```(\S*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const HEADING = /^(#{1,4})\s+(.*)$/;
const HR = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const QUOTE = /^\s*>\s?/;
const UL_ITEM = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM = /^(\s*)\d+[.)]\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/;

/**
 * Render Markdown source to an HTML string. Tolerant of incomplete input so it
 * can be called on every streaming delta (unclosed fences degrade gracefully).
 */
export function renderMarkdown(src) {
  if (src === undefined || src === null || src === "") return "";
  const lines = String(src).replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let para = [];
  let i = 0;

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(para.join("\n"))}</p>`);
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block (unclosed fence at EOF → rest of input is code).
    const fence = line.match(FENCE_OPEN);
    if (fence) {
      flushPara();
      const buf = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence (or step past EOF)
      out.push(
        `<pre class="md-code"${fence[1] ? ` data-lang="${escapeHtml(fence[1])}"` : ""}><code>${escapeHtml(buf.join("\n"))}</code></pre>`,
      );
      continue;
    }

    // ATX heading.
    const h = line.match(HEADING);
    if (h) {
      flushPara();
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(h[2].replace(/\s*#+\s*$/, ""))}</h${lv}>`);
      i++;
      continue;
    }

    // Thematic break.
    if (HR.test(line)) {
      flushPara();
      out.push("<hr>");
      i++;
      continue;
    }

    // Blockquote (recursive render of the stripped content).
    if (QUOTE.test(line)) {
      flushPara();
      const buf = [];
      while (i < lines.length && QUOTE.test(lines[i])) {
        buf.push(lines[i].replace(QUOTE, ""));
        i++;
      }
      out.push(`<blockquote>${renderMarkdown(buf.join("\n"))}</blockquote>`);
      continue;
    }

    // Table: header row followed by a separator row.
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      flushPara();
      const cells = (row) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && TABLE_ROW.test(lines[i])) {
        rows.push(cells(lines[i]));
        i++;
      }
      out.push(
        "<table><thead><tr>" +
          head.map((c) => `<th>${inline(c)}</th>`).join("") +
          "</tr></thead><tbody>" +
          rows
            .map((r) => "<tr>" + head.map((_, j) => `<td>${inline(r[j] ?? "")}</td>`).join("") + "</tr>")
            .join("") +
          "</tbody></table>",
      );
      continue;
    }

    // Lists (unordered / ordered, shared block while items keep matching).
    const ul = line.match(UL_ITEM);
    const ol = line.match(OL_ITEM);
    if (ul || ol) {
      flushPara();
      const ordered = Boolean(ol);
      const re = ordered ? OL_ITEM : UL_ITEM;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(re);
        if (m) {
          items.push({ indent: m[1].length, text: m[2] });
          i++;
        } else if (/^\s*$/.test(lines[i]) && i + 1 < lines.length && re.test(lines[i + 1])) {
          i++; // blank line between items stays inside the list
        } else if (/^\s{2,}\S/.test(lines[i]) && items.length) {
          items[items.length - 1].text += ` ${lines[i].trim()}`; // continuation line
          i++;
        } else {
          break;
        }
      }
      out.push(renderList(items, ordered, 0, 0).html);
      continue;
    }

    // Blank line ends the current paragraph.
    if (/^\s*$/.test(line)) {
      flushPara();
      i++;
      continue;
    }

    para.push(line);
    i++;
  }
  flushPara();
  return out.join("\n");
}
