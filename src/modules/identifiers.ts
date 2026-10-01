/**
 * Pure helpers for DOIs, arXiv IDs and titles.
 *
 * This file must not reference Zotero globals so it can be unit-tested
 * with plain Node (see test/identifiers.test.ts).
 */

const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"]+)/i;

// New-style arXiv IDs (since 2007), e.g. 2101.00001 or 0706.0001v2.
const ARXIV_NEW = /(\d{4}\.\d{4,5})(v\d+)?/;
// Old-style arXiv IDs, e.g. hep-th/9901001 or math.GT/0309136.
const ARXIV_OLD = /([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/;

// DataCite DOIs that arXiv assigns to every preprint.
const ARXIV_DOI = /^10\.48550\/arxiv\.(.+)$/i;

/**
 * Extract and normalise a DOI from arbitrary text (a field value, a URL,
 * "doi:10..." etc.). Returns a lower-cased DOI or undefined.
 */
export function normalizeDOI(text: string | null | undefined) {
  if (!text) return undefined;
  let decoded = text;
  try {
    decoded = decodeURIComponent(text);
  } catch {
    // Keep the raw text if it is not valid percent-encoding.
  }
  const match = decoded.match(DOI_PATTERN);
  if (!match) return undefined;
  // Strip punctuation that commonly trails a DOI in running text. Closing
  // brackets are kept when balanced, since some DOIs contain "(...)".
  let doi = match[1].replace(/[.,;:]+$/, "");
  while (/[)\]]$/.test(doi) && !isBalanced(doi)) {
    doi = doi.slice(0, -1).replace(/[.,;:]+$/, "");
  }
  return doi.toLowerCase();
}

function isBalanced(text: string) {
  const count = (c: string) => text.split(c).length - 1;
  return count("(") === count(")") && count("[") === count("]");
}

/** Find a "DOI: ..." line in an item's Extra field. */
export function doiFromExtra(extra: string | null | undefined) {
  if (!extra) return undefined;
  const line = extra.match(/^\s*DOI\s*:\s*(\S+)/im);
  return line ? normalizeDOI(line[1]) : undefined;
}

/** Strip a version suffix ("v2") from an arXiv ID. */
function stripVersion(id: string) {
  return id.replace(/v\d+$/, "");
}

/** Parse a bare arXiv ID, with or without an "arXiv:" prefix. */
export function parseArxivId(text: string | null | undefined) {
  if (!text) return undefined;
  const cleaned = text.trim().replace(/^arxiv\s*:\s*/i, "");
  const fromDoi = cleaned.match(ARXIV_DOI);
  const candidate = fromDoi ? fromDoi[1] : cleaned;
  const m =
    candidate.match(new RegExp(`^${ARXIV_NEW.source}$`)) ||
    candidate.match(new RegExp(`^${ARXIV_OLD.source}$`));
  return m ? stripVersion(m[1]) : undefined;
}

/** Extract an arXiv ID from an arxiv.org URL (abs, pdf or html). */
export function arxivFromURL(url: string | null | undefined) {
  if (!url) return undefined;
  const m = url.match(
    /arxiv\.org\/(?:abs|pdf|html)\/([a-z-]+(?:\.[A-Z]{2})?\/\d{7}|\d{4}\.\d{4,5})(v\d+)?/i,
  );
  return m ? stripVersion(m[1]) : undefined;
}

/** Extract an arXiv ID from an "arXiv: ..." line in the Extra field. */
export function arxivFromExtra(extra: string | null | undefined) {
  if (!extra) return undefined;
  const m = extra.match(/^\s*arXiv\s*(?:ID)?\s*:\s*(\S+)/im);
  return m ? parseArxivId(m[1]) : undefined;
}

/** If the DOI is an arXiv DataCite DOI, return the arXiv ID it encodes. */
export function arxivFromDOI(doi: string | null | undefined) {
  if (!doi) return undefined;
  const m = doi.match(ARXIV_DOI);
  return m ? parseArxivId(m[1]) : undefined;
}

/**
 * Normalise a title for fuzzy duplicate detection: lower case, strip
 * accents, punctuation and whitespace. Returns "" for very short titles so
 * they never match by accident.
 */
export function normalizeTitle(title: string | null | undefined) {
  if (!title) return "";
  const norm = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");
  return norm.length >= 12 ? norm : "";
}

/** Split a display name ("Ada M. Lovelace") into first and last name. */
export function splitName(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: "", lastName: parts[0] };
  const lastName = parts.pop() as string;
  return { firstName: parts.join(" "), lastName };
}

/** Rebuild an abstract from OpenAlex's inverted index representation. */
export function abstractFromInvertedIndex(
  index: Record<string, number[]> | null | undefined,
) {
  if (!index) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const pos of positions) words[pos] = word;
  }
  const text = words.filter((w) => w !== undefined).join(" ");
  return text || undefined;
}

/** Lower-case, accent-free text with punctuation turned into spaces. */
export function normalizeForSearch(text: string) {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}./]+/gu, " ")
    .trim();
}
