/**
 * Pure helpers to find the bibliography in a PDF's full text and split it
 * into entries. No Zotero globals here, so this is unit-tested in Node.
 *
 * Zotero.PDFWorker.getFullText() returns one paragraph per line, so most
 * entries are already on a line of their own. The work here is to find
 * where the bibliography starts and ends, drop page furniture (page
 * numbers, running headers), and re-join entries split across pages.
 */

export interface BibEntry {
  /** The label printed in the paper ("23" for "[23]" or "23."), if any. */
  label?: string;
  /** The entry text, on a single line. */
  text: string;
}

export type BibStyle = "bracket" | "numbered" | "author-year";

const HEADING =
  /^\s*(?:\d+\.?|[IVX]+\.)?\s*(references(?:\s+(?:cited|and\s+notes))?|bibliography|literature\s+cited|works\s+cited|cited\s+literature)\s*:?\s*$/i;

/** Headings that end the bibliography (appendices, acknowledgements…). */
const END_HEADING =
  /^\s*(?:[A-Z]\.?|\d+\.?)?\s*(appendix|appendices|supplementary\s+(?:material|information)|acknowledg(?:e)?ments?|author\s+contributions|about\s+the\s+authors?|biograph(?:y|ies))\b/i;

/** "A Additional details", "A.1 Illustration of …": appendix sections. */
const APPENDIX_SECTION = /^\s*[A-Z](?:\.\d+)*\s+[A-Z][a-z]+(?:\s+\S+){0,8}\s*$/;

const NUMBERED = /^\s*(\d{1,4})\.\s+(?=\S)/;

/** Lines repeated on many pages (running headers and footers). */
function furniture(lines: string[]) {
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.replace(/\d+/g, "#").trim();
    if (key.length > 3) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) return true;
    if (/^\d{1,4}$/.test(trimmed)) return true; // page number
    const key = line.replace(/\d+/g, "#").trim();
    return (counts.get(key) ?? 0) >= 3;
  };
}

/**
 * Return the lines of the bibliography: everything after the last
 * "References"-like heading, up to an appendix-like heading, without page
 * furniture. Returns undefined if no heading is found.
 */
function findBibliography(text: string): string[] | undefined {
  const lines = text.split(/\r?\n/);
  let start = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (HEADING.test(lines[i])) {
      start = i + 1;
      break;
    }
  }
  if (start < 0) {
    // Some PDFs glue the heading to the first entry: "References [1] …".
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^\s*(?:references|bibliography)\s+(\[1\].*)$/i);
      if (m) {
        lines[i] = m[1];
        start = i;
        break;
      }
    }
  }
  if (start < 0) return undefined;

  const isFurniture = furniture(lines);
  const result: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    // Only stop at an end heading once some entries were collected.
    if (result.length > 3 && END_HEADING.test(line)) break;
    if (isFurniture(line)) continue;
    result.push(line.trim());
  }
  return result;
}

function countMatches(lines: string[], re: RegExp) {
  return lines.filter((l) => re.test(l)).length;
}

/**
 * True if the numbered labels run 1, 2, 3, … for most lines (lines such as
 * "2019. Title" in between are tolerated).
 */
function isSequential(lines: string[], re: RegExp) {
  const labels = lines
    .map((l) => l.match(re)?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
  let expected = 1;
  for (const label of labels) {
    if (label === expected) expected++;
  }
  const inSequence = expected - 1;
  return inSequence >= 3 && inSequence >= labels.length * 0.6;
}

/** Detect the numbering style used by the bibliography lines. */
function detectStyle(lines: string[]): BibStyle {
  // Count "[n] Author" labels anywhere in a line: several entries can
  // share one paragraph of extracted text.
  const bracket = lines.reduce(
    (n, l) => n + (l.match(/(?:^|\s)\[\d{1,4}\]\s*\p{Lu}/gu)?.length ?? 0),
    0,
  );
  const numbered = countMatches(lines, NUMBERED);
  if (bracket >= 3 && bracket >= numbered) return "bracket";
  if (isSequential(lines, NUMBERED)) return "numbered";
  return "author-year";
}

/** Append a line to an entry, repairing words hyphenated at the break. */
function appendText(entry: string, line: string) {
  if (!entry) return line;
  if (/[a-z]-$/.test(entry) && /^[a-z]/.test(line)) {
    return entry.slice(0, -1) + line;
  }
  return `${entry} ${line}`;
}

/** How far ahead to look for the next label when one is missing. */
const MAX_LABEL_GAP = 3;

/**
 * Split "[1] … [2] …" entries. Labels are searched in sequence over the
 * whole text rather than at line starts, because the PDF text often has
 * several entries in one paragraph ("… ICSE, 2025. [12] C. S. Xia …"). At
 * each step the nearest of [n], [n+1] … [n+3] is taken, so a label lost
 * in extraction does not stop the split.
 */
function splitBracketed(lines: string[]): BibEntry[] {
  const text = lines.reduce(appendText, "");
  const first = text.match(/\[(\d{1,4})\]/);
  if (!first) return [];
  const starts: Array<{ label: number; at: number; end: number }> = [];
  let expected = Number(first[1]);
  let pos = first.index!;
  for (;;) {
    let best: { label: number; at: number; end: number } | undefined;
    for (let k = expected; k <= expected + MAX_LABEL_GAP; k++) {
      const re = new RegExp(String.raw`(^|\s)\[${k}\]\s*`, "g");
      re.lastIndex = pos;
      const m = re.exec(text);
      if (!m) continue;
      const at = m.index + m[1].length;
      if (!best || at < best.at)
        best = { label: k, at, end: m.index + m[0].length };
    }
    if (!best) break;
    starts.push(best);
    expected = best.label + 1;
    pos = best.end;
  }
  return starts.map((start, i) => ({
    label: String(start.label),
    text: text.slice(start.end, starts[i + 1]?.at ?? text.length).trim(),
  }));
}

/** Does this line look like the start of a new author-year entry? */
function startsAuthorYearEntry(line: string, previous: string) {
  if (!previous) return true;
  // A continuation starts in lower case ("configuration. In LION …") or
  // follows an entry that has not ended yet.
  if (!/^(?:\p{Lu}|(?:van|von|de|der|den|di|da|del|la|le)\s)/u.test(line)) {
    return false;
  }
  return /[.)\]?!]\s*$|\b(19|20)\d{2}[a-z]?\s*$/.test(previous);
}

/**
 * Split bibliography lines into entries. Numeric styles split on their
 * labels; author-year entries are one paragraph each, with continuation
 * lines (after a page break) joined to the previous entry.
 */
function splitEntries(lines: string[]): {
  style: BibStyle;
  entries: BibEntry[];
} {
  const style = detectStyle(lines);
  const raw: BibEntry[] = [];

  if (style === "bracket") {
    raw.push(...splitBracketed(lines));
  } else if (style === "numbered") {
    const re = NUMBERED;
    let expected = 1;
    let current: BibEntry | undefined;
    for (const line of lines) {
      const m = line.match(re);
      // For "1." numbering, only accept the next number, so that lines such
      // as "2019. Some title" inside an entry do not split it.
      if (m && Number(m[1]) === expected) {
        current = { label: m[1], text: line.slice(m[0].length).trim() };
        raw.push(current);
        expected = Number(m[1]) + 1;
      } else if (current) {
        current.text = appendText(current.text, line);
      }
    }
  } else {
    let current: BibEntry | undefined;
    let ended = 0;
    for (const line of lines) {
      if (raw.length > 3 && APPENDIX_SECTION.test(line)) ended++;
      if (ended) break;
      if (!current || startsAuthorYearEntry(line, current.text)) {
        current = { text: line };
        raw.push(current);
      } else {
        current.text = appendText(current.text, line);
      }
    }
  }

  const entries = raw
    .map((e) => ({ ...e, text: e.text.replace(/\s+/g, " ").trim() }))
    .filter((e) => e.text.length >= 20);
  return { style, entries };
}

/** Find and split the bibliography of a document's full text. */
export function extractBibliography(text: string) {
  const lines = findBibliography(text);
  if (!lines) return undefined;
  const result = splitEntries(lines);
  return result.entries.length ? result : undefined;
}

/** Guess the year of an entry: the last plausible year in it. */
export function entryYear(text: string) {
  const years = [...text.matchAll(/\b(19[5-9]\d|20[0-4]\d)[a-z]?\b/g)].map(
    (m) => Number(m[1]),
  );
  return years.length ? years[years.length - 1] : undefined;
}

/**
 * Does `title` (from Crossref or an API) appear in the entry text? Used to
 * accept a Crossref match only when its title is really in the entry.
 */
export function titleInEntry(title: string, entry: string) {
  const norm = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/<[^>]+>/g, "")
      .replace(/[^\p{L}\p{N}]+/gu, "");
  const t = norm(title);
  return t.length >= 10 && norm(entry).includes(t);
}
