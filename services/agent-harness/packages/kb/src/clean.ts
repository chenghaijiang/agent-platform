/**
 * Ingest-time text cleaning (design doc §5.2 pre-processing).
 *
 * Applied to the parsed document text *before* hashing and chunking, so a change in
 * cleaning options re-indexes the file (the hash covers the cleaned text) — and the
 * raw text is never stored, only the cleaned form.
 *
 * Every step is opt-in: with an empty CleanOptions the text passes through unchanged,
 * keeping byte-identical behavior with pre-cleaning indexes.
 */

/** Per-source cleaning knobs; all optional, all default off. */
export interface CleanOptions {
  /** Collapse runs of spaces/tabs, trim line ends, squeeze 3+ blank lines to one. */
  collapseWhitespace?: boolean;
  /** Drop HTML/script/style tags (inline documentation pasted from web pages). */
  stripHtml?: boolean;
  /** Remove fenced code blocks entirely (prose-only corpus; ``` and ~~~ both). */
  stripCodeFences?: boolean;
  /** Markdown links become their label; bare http(s) URLs are removed. */
  stripUrls?: boolean;
  /**
   * De-boilerplate: lines repeated ≥ 10 times (≥ 8 chars) are dropped wholesale
   * (page headers/footers), and runs of identical adjacent lines collapse to one.
   */
  dropDuplicateLines?: boolean;
}

/** markdown link [label](href) → label; bare URLs removed afterwards. */
const MD_LINK_PATTERN = /\[([^\]]*)\]\([^)]*\)/g;
const BARE_URL_PATTERN = /https?:\/\/\S+/g;

/** Apply the enabled cleaning steps in a fixed order; disabled steps are no-ops. */
export function cleanText(text: string, opts: CleanOptions | undefined): string {
  if (!opts) return text;
  let out = text;

  if (opts.stripHtml) {
    out = out
      .replace(/<script\b[\s\S]*?<\/script>/gi, "")
      .replace(/<style\b[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ");
  }

  if (opts.stripCodeFences) out = stripFences(out);

  if (opts.stripUrls) {
    out = out.replace(MD_LINK_PATTERN, "$1");
    out = out.replace(BARE_URL_PATTERN, "");
  }

  if (opts.dropDuplicateLines) out = dedupLines(out);

  if (opts.collapseWhitespace) {
    out = out
      .split("\n")
      .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  return out;
}

/** Remove fenced blocks (markers included), keeping everything outside them. */
function stripFences(text: string): string {
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) out.push(line);
  }
  return out.join("\n");
}

/** Boilerplate threshold: a line seen this many times is header/footer noise. */
const BOILERPLATE_MIN_REPEATS = 10;
/** Short lines repeat legitimately (e.g. "-") — only long ones count as boilerplate. */
const BOILERPLATE_MIN_CHARS = 8;

function dedupLines(text: string): string {
  const lines = text.split("\n");
  const counts = new Map<string, number>();
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length >= BOILERPLATE_MIN_CHARS) counts.set(line, (counts.get(line) ?? 0) + 1);
  }
  const boilerplate = new Set(
    [...counts].filter(([, n]) => n >= BOILERPLATE_MIN_REPEATS).map(([line]) => line),
  );

  const out: string[] = [];
  let previous = "";
  for (const raw of lines) {
    const line = raw.trim();
    if (boilerplate.has(line)) continue;
    if (line && line === previous) continue; // collapse adjacent duplicates
    out.push(raw);
    previous = line;
  }
  return out.join("\n");
}
