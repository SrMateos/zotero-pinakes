/**
 * Pure computations behind the "Insights" panel: most cited authors,
 * in-text citations per reference and section, years and venues. No
 * Zotero globals here, so this is unit-tested in Node.
 */
import { bodyLines } from "./bibliography";
import { findMarkers } from "./citations";
import { normalizeForSearch } from "./identifiers";
import type { Reference } from "./types";

// ---------------------------------------------------------------------------
// Authors
// ---------------------------------------------------------------------------

export interface AuthorCount {
  /** "id:<source ID>", or "name:<normalised name>" without an ID. */
  key: string;
  name: string;
  /** Number of references in the list by this author. */
  count: number;
  /** The author is also an author of the citing paper. */
  self: boolean;
}

/**
 * "ada lovelace" and "A. Lovelace" both give "lovelace a": surname and
 * first initial. Used only when there is no author ID.
 */
export function nameKey(name: string) {
  const parts = normalizeForSearch(name).replace(/\./g, " ").split(/\s+/);
  const surname = parts.pop() ?? "";
  return `${surname} ${parts[0]?.[0] ?? ""}`.trim();
}

/** The key of the i-th author of a reference. */
export function authorKey(ref: Reference, i: number) {
  const id = ref.authorIds?.[i];
  return id ? `id:${id}` : `name:${nameKey(ref.authors[i])}`;
}

/** Does the reference have an author with this key? */
export function hasAuthor(ref: Reference, key: string) {
  return ref.authors.some((_, i) => authorKey(ref, i) === key);
}

/**
 * Authors by number of references in the list, most cited first. Authors
 * are counted by their source ID when there is one, so that two people
 * with the same name are not merged. An author is marked `self` when
 * their ID is among `citingIds` or, without IDs, their name matches one
 * of `citingNames` (surname and first initial).
 */
export function topAuthors(
  refs: Reference[],
  citingIds: string[] = [],
  citingNames: string[] = [],
  limit = 10,
): AuthorCount[] {
  const ids = new Set(citingIds);
  const names = new Set(citingNames.map(nameKey));
  const byKey = new Map<string, AuthorCount>();
  for (const ref of refs) {
    if (ref.unresolved) continue;
    const seen = new Set<string>();
    ref.authors.forEach((name, i) => {
      const key = authorKey(ref, i);
      if (seen.has(key)) return;
      seen.add(key);
      const id = ref.authorIds?.[i];
      const self = id ? ids.has(id) : names.has(nameKey(name));
      const entry = byKey.get(key);
      if (entry) {
        entry.count++;
        entry.self ||= self;
      } else {
        byKey.set(key, { key, name, count: 1, self });
      }
    });
  }
  return [...byKey.values()]
    .filter((a) => a.count > 1)
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

/** References by an author of the citing paper. */
export function selfCitations(
  refs: Reference[],
  citingIds: string[] = [],
  citingNames: string[] = [],
) {
  const ids = new Set(citingIds);
  const names = new Set(citingNames.map(nameKey));
  return refs.filter(
    (ref) =>
      !ref.unresolved &&
      ref.authors.some((name, i) => {
        const id = ref.authorIds?.[i];
        return id ? ids.has(id) : names.has(nameKey(name));
      }),
  );
}

// ---------------------------------------------------------------------------
// Years and venues
// ---------------------------------------------------------------------------

export interface YearSummary {
  min: number;
  max: number;
  median: number;
  /** Year -> number of references, every year from min to max. */
  histogram: Array<[year: number, count: number]>;
  /** References with a year. */
  dated: number;
}

export function yearSummary(refs: Reference[]): YearSummary | undefined {
  const years = refs
    .map((r) => r.year)
    .filter((y): y is number => typeof y === "number")
    .sort((a, b) => a - b);
  if (!years.length) return undefined;
  const min = years[0];
  const max = years[years.length - 1];
  const counts = new Map<number, number>();
  for (const y of years) counts.set(y, (counts.get(y) ?? 0) + 1);
  const histogram: Array<[number, number]> = [];
  for (let y = min; y <= max; y++) histogram.push([y, counts.get(y) ?? 0]);
  return {
    min,
    max,
    median: years[Math.floor((years.length - 1) / 2)],
    histogram,
    dated: years.length,
  };
}

/** A venue name for grouping: case, punctuation and years ignored. */
export function venueKey(venue: string) {
  return normalizeForSearch(venue)
    .replace(/\b(19|20)\d\d\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export interface VenueCount {
  key: string;
  /** The most frequent spelling. */
  name: string;
  count: number;
}

export function topVenues(refs: Reference[], limit = 5): VenueCount[] {
  const groups = new Map<string, Map<string, number>>();
  for (const ref of refs) {
    if (!ref.venue || ref.unresolved) continue;
    const key = venueKey(ref.venue);
    if (!key) continue;
    const spellings = groups.get(key) ?? new Map<string, number>();
    spellings.set(ref.venue, (spellings.get(ref.venue) ?? 0) + 1);
    groups.set(key, spellings);
  }
  return [...groups.entries()]
    .map(([key, spellings]) => {
      const sorted = [...spellings.entries()].sort((a, b) => b[1] - a[1]);
      const count = sorted.reduce((n, [, c]) => n + c, 0);
      return { key, name: sorted[0][0], count };
    })
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Semantic Scholar influence and intents
// ---------------------------------------------------------------------------

export const INTENT_LABEL: Record<string, string> = {
  background: "Background",
  methodology: "Methodology",
  result: "Result comparison",
};

export function intentLabel(intent: string) {
  return INTENT_LABEL[intent] ?? intent;
}

/** Number of references per intent, in INTENT_LABEL's order first. */
export function intentCounts(refs: Reference[]) {
  const counts = new Map<string, number>();
  for (const intent of Object.keys(INTENT_LABEL)) counts.set(intent, 0);
  for (const ref of refs) {
    for (const intent of ref.intents ?? []) {
      counts.set(intent, (counts.get(intent) ?? 0) + 1);
    }
  }
  return [...counts.entries()].filter(([, n]) => n > 0);
}

// ---------------------------------------------------------------------------
// In-text citations
// ---------------------------------------------------------------------------

export interface InTextCount {
  /** Times the number appears in a citation marker. */
  count: number;
  /** Sections it is cited in, in order of first appearance. */
  sections: string[];
}

/** Section names recognised without a number. */
const NAMED_SECTION =
  /^(abstract|introduction|background|related\s+work|preliminaries|methods?|methodology|approach|experiments?|experimental\s+(?:setup|results)|evaluation|results(?:\s+and\s+discussion)?|discussion|limitations|conclusions?(?:\s+and\s+future\s+work)?|future\s+work)$/i;

const ROMAN = ["I", "II", "III", "IV", "V", "VI", "VII", "VIII", "IX", "X"];

/** "Related Work" for "RELATED WORK". */
function titleCase(text: string) {
  if (text !== text.toUpperCase()) return text;
  return text
    .toLowerCase()
    .replace(/(^|\s)(\p{L})/gu, (_, space, c) => space + c.toUpperCase());
}

/**
 * If `line` is a top-level section heading, its title. Numbered headings
 * ("3 Method", "3. Method", "III. METHOD") must follow the previous
 * number, which rules out most numbered lines in tables and affiliations.
 * Subsection headings ("3.1 …") are not section headings.
 */
export function sectionHeading(
  line: string,
  previous: number,
): { title: string; number?: number } | undefined {
  const text = line.trim();
  if (text.length > 60 || /[.:,;]$/.test(text)) return undefined;
  const numbered = text.match(
    /^(\d{1,2}|[IVX]{1,4})\.?\s+(\p{Lu}[\p{L}'’-]*(?:\s+[\p{L}'’&-]+){0,7})$/u,
  );
  if (numbered) {
    const n = /^\d/.test(numbered[1])
      ? Number(numbered[1])
      : ROMAN.indexOf(numbered[1]) + 1;
    if (n === previous + 1) {
      return { title: titleCase(numbered[2]), number: n };
    }
    return undefined;
  }
  if (NAMED_SECTION.test(text)) return { title: titleCase(text) };
  return undefined;
}

/**
 * Count the numeric citation markers ("[12]", "[4, 7–9]") in the body of a
 * document's full text, per cited number, with the sections they appear
 * in. Text before the first recognised heading is attributed to
 * "Front matter".
 */
export function inTextCitations(fullText: string): Map<number, InTextCount> {
  const counts = new Map<number, InTextCount>();
  let section = "Front matter";
  let number = 0;
  for (const line of bodyLines(fullText)) {
    const heading = sectionHeading(line, number);
    if (heading) {
      section = heading.title;
      if (heading.number) number = heading.number;
      continue;
    }
    for (const marker of findMarkers(line)) {
      for (const n of marker.numbers) {
        const entry = counts.get(n) ?? { count: 0, sections: [] };
        entry.count++;
        if (!entry.sections.includes(section)) entry.sections.push(section);
        counts.set(n, entry);
      }
    }
  }
  return counts;
}
