/**
 * Pure helpers for citation counts: the row badge, its tooltip and the
 * "Most cited" order. No Zotero globals here, so this is unit-tested in
 * Node.
 */
import type { CountSource, Reference } from "./types";

const COUNT_SOURCE_LABEL: Record<CountSource, string> = {
  semanticscholar: "Semantic Scholar",
  openalex: "OpenAlex",
  crossref: "Crossref",
};

/** "950", "1.2k", "12k", "3.4M". */
export function formatCount(n: number) {
  const short = (value: number, unit: string) => {
    const digits = value < 10 ? 1 : 0;
    // 9.96k would round to "10.0k": show it as "10k".
    const text = value.toFixed(digits).replace(/\.0$/, "");
    return `${text}${unit}`;
  };
  if (n < 1000) return String(n);
  if (n < 999_500) return short(n / 1000, "k");
  return short(n / 1_000_000, "M");
}

/** "1 citation", "1.2k citations". */
export function citationBadge(n: number) {
  return `${formatCount(n)} ${n === 1 ? "citation" : "citations"}`;
}

/**
 * "Cited 1,234 times according to OpenAlex (fetched …). Counts differ
 * between sources."
 */
export function citationTooltip(ref: Reference, fetched: string) {
  if (ref.citedBy === undefined || !ref.citedBySource) return "";
  const times =
    ref.citedBy === 1 ? "once" : `${ref.citedBy.toLocaleString("en-US")} times`;
  return `Cited ${times} according to ${COUNT_SOURCE_LABEL[ref.citedBySource]} (fetched ${fetched}). Counts differ between sources.`;
}

/**
 * The references from most to least cited. References without a count go
 * last; ties keep the list's order.
 */
export function sortByCitations(refs: Reference[]) {
  const key = (ref: Reference) => ref.citedBy ?? -1;
  return refs
    .map((ref, i) => ({ ref, i }))
    .sort((a, b) => key(b.ref) - key(a.ref) || a.i - b.i)
    .map(({ ref }) => ref);
}
