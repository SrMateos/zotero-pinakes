/**
 * Put an API reference list in the order of the paper's own bibliography
 * (read from the PDF), with the paper's numbering. No Zotero globals here,
 * so this is unit-tested in Node.
 */
import { entryYear, titleInEntry, type BibEntry } from "./bibliography";
import { arxivFromURL, normalizeDOI, parseArxivId } from "./identifiers";
import type { Reference } from "./types";

/** An arXiv ID mentioned in a bibliography entry, if any. */
export function arxivInText(text: string) {
  const m = text.match(
    /arxiv[:\s]*(?:preprint\s+)?(?:arxiv:)?\s*(\d{4}\.\d{4,5}|[a-z-]+\/\d{7})/i,
  );
  return (m ? parseArxivId(m[1]) : undefined) ?? arxivFromURL(text);
}

/**
 * A bibliography entry with no online record. If its text contains a DOI or
 * an arXiv ID it can still be imported; otherwise it is plain text.
 */
export function entryReference(entry: BibEntry, index: number): Reference {
  const doi = normalizeDOI(entry.text);
  const arxiv = arxivInText(entry.text);
  return {
    index,
    label: entry.label,
    raw: entry.text,
    title: entry.text,
    authors: [],
    year: entryYear(entry.text),
    doi,
    arxiv,
    kind: arxiv && !doi ? "preprint" : "other",
    unresolved: !doi && !arxiv,
  };
}

/** Does this API reference correspond to this bibliography entry? */
function sameWork(ref: Reference, entry: BibEntry) {
  if (titleInEntry(ref.title, entry.text)) return true;
  const text = entry.text.toLowerCase();
  if (ref.doi && text.includes(ref.doi)) return true;
  return !!ref.arxiv && arxivInText(entry.text) === ref.arxiv;
}

/**
 * Reorder `references` to follow `entries` (the paper's bibliography):
 *
 * - each entry takes the API reference that matches it (by title, else by
 *   DOI or arXiv ID in the entry) and the entry's label ("12" for "[12]");
 * - entries the API does not have are kept, from their text (see
 *   entryReference), so the list is the paper's full bibliography;
 * - API references that match no entry are appended at the end.
 *
 * Indexes are renumbered 1..n in the new order.
 */
export function orderByPaper(references: Reference[], entries: BibEntry[]) {
  const unused = new Set(references);
  const ordered: Reference[] = [];
  let matched = 0;
  for (const entry of entries) {
    // A paper may cite the same work twice under two numbers, so fall back
    // to references already taken by an earlier entry.
    const ref =
      [...unused].find((r) => sameWork(r, entry)) ??
      references.find((r) => !unused.has(r) && sameWork(r, entry));
    if (ref) {
      unused.delete(ref);
      matched++;
      ordered.push({ ...ref, label: entry.label, raw: entry.text });
    } else {
      ordered.push(entryReference(entry, 0));
    }
  }
  for (const ref of references) {
    if (unused.has(ref)) ordered.push({ ...ref, label: undefined });
  }
  return {
    references: ordered.map((ref, i) => ({ ...ref, index: i + 1 })),
    matched,
    extra: unused.size,
    complete: isComplete(entries),
  };
}

/**
 * True if the bibliography is numbered 1..N with no gaps, i.e. it was
 * extracted completely. API references missing from a complete
 * bibliography are not cited by the paper (often headings or captions
 * that the API's own PDF parser took for references).
 */
export function isComplete(entries: BibEntry[]) {
  if (!entries.length) return false;
  return entries.every((e, i) => e.label === String(i + 1));
}
