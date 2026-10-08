/**
 * Pure helpers to find the published version of a preprint (or workshop
 * paper) in DBLP, through its SPARQL service. No Zotero globals here, so this is
 * unit-tested in Node.
 */
import {
  arxivFromURL,
  normalizeDOI,
  normalizeForSearch,
  normalizeTitle,
  parseArxivId,
} from "./identifiers";

/** The fields of a library item that matter for the search. */
export interface ItemInfo {
  itemType: string;
  title: string;
  /** Display names or surnames of the authors. */
  authors: string[];
  year?: number;
  /** Publication, proceedings or repository title; "" if none. */
  venue: string;
  doi?: string;
  arxiv?: string;
}

/** One DBLP record, normalised. */
export interface DblpPublication {
  key: string;
  title: string;
  authors: string[];
  venue: string;
  year?: number;
  /** DBLP's type: "Article", "Inproceedings", "Incollection", "Informal"… */
  type: string;
  volume?: string;
  number?: string;
  pages?: string;
  doi?: string;
  arxiv?: string;
  /** The record's page on dblp.org (also its IRI). */
  url: string;
  /** The electronic edition (publisher page), if any. */
  ee?: string;
}

export type DblpOutcome =
  /** A published version different from the item. */
  | { kind: "found"; match: DblpPublication; others: DblpPublication[] }
  /** The item already is the published version DBLP knows. */
  | { kind: "already"; match: DblpPublication }
  | { kind: "none"; reason: string };

/** DBLP types (dblp:Article…) of peer-reviewed publications. */
const PUBLISHED_TYPES = new Set(["Article", "Inproceedings", "Incollection"]);

/** How far the published version's year may be from the item's. */
const YEARS_BEFORE = 1;
const YEARS_AFTER = 4;

const PREPRINT_VENUE = /\b(arxiv|corr|biorxiv|medrxiv|ssrn|preprints?)\b/i;

/**
 * Should the item be checked when only preprints and items without a
 * venue are checked? True for preprints (item type, arXiv-like venue, or
 * an arXiv ID without a publisher DOI) and for items with no venue.
 */
export function isPreprintOrUnpublished(info: ItemInfo) {
  if (info.itemType === "preprint") return true;
  if (!info.venue.trim()) return true;
  if (PREPRINT_VENUE.test(info.venue)) return true;
  return !!info.arxiv && !info.doi;
}

/** Escape a string for a SPARQL string literal. */
function literal(text: string) {
  return `"${text.replace(/[\\"]/g, "\\$&").replace(/\s+/g, " ")}"`;
}

/** A DOI as the IRI DBLP uses, in the given case. */
function doiIRI(doi: string) {
  return `<https://doi.org/${encodeURI(doi)}>`;
}

/**
 * The SPARQL query for the item: DBLP records whose title is the item's
 * title (DBLP titles end with a period), plus every record sharing the
 * title of the record with the item's arXiv DOI or DOI. The second part
 * finds the published version even when the item's title differs in case
 * or punctuation from DBLP's. DOIs are matched as stored by DBLP, which
 * keeps the registrant's case, so both cases are tried.
 */
export function sparqlQuery(info: ItemInfo) {
  const title = info.title.trim().replace(/\s+/g, " ").replace(/\.$/, "");
  const ids = new Set<string>();
  const addDOI = (doi: string) => {
    for (const variant of [doi, doi.toUpperCase(), doi.toLowerCase()]) {
      ids.add(doiIRI(variant));
    }
  };
  if (info.arxiv) addDOI(`10.48550/arxiv.${info.arxiv}`);
  if (info.doi) addDOI(info.doi);
  const byId = ids.size
    ? `
      UNION
      { VALUES ?id { ${[...ids].join(" ")} }
        ?same dblp:doi ?id ; dblp:title ?sameTitle .
        ?pub dblp:title ?sameTitle . }`
    : "";
  return `PREFIX dblp: <https://dblp.org/rdf/schema#>
SELECT ?pub ?title ?type ?year ?venue ?volume ?number ?pages ?doi ?ee ?ord ?name WHERE {
  {
    SELECT DISTINCT ?pub WHERE {
      { VALUES ?t { ${literal(title)} ${literal(`${title}.`)} }
        ?pub dblp:title ?t . }${byId}
    }
  }
  ?pub dblp:title ?title ; a ?type .
  FILTER(?type != dblp:Publication)
  OPTIONAL { ?pub dblp:yearOfPublication ?year }
  OPTIONAL { ?pub dblp:publishedIn ?venue }
  OPTIONAL { ?pub dblp:publishedInJournalVolume ?volume }
  OPTIONAL { ?pub dblp:publishedInJournalVolumeIssue ?number }
  OPTIONAL { ?pub dblp:pagination ?pages }
  OPTIONAL { ?pub dblp:doi ?doi }
  OPTIONAL { ?pub dblp:primaryDocumentPage ?ee }
  OPTIONAL {
    ?pub dblp:hasSignature ?sig .
    ?sig dblp:signatureOrdinal ?ord ; dblp:signatureDblpName ?name .
  }
}
LIMIT 2000`;
}

// ---------------------------------------------------------------------------
// Parsing SPARQL results
// ---------------------------------------------------------------------------

type Binding = Record<string, { value?: string } | undefined>;

export interface SparqlResponse {
  results?: { bindings?: Binding[] };
}

/** "Wei Wang 0001" (DBLP's homonym number) gives "Wei Wang". */
export function stripHomonymNumber(name: string) {
  return name.replace(/\s+\d{4}$/, "");
}

/** The local name of a DBLP IRI: "Inproceedings" for …/schema#Inproceedings. */
function localName(iri: string) {
  return iri.split(/[#/]/).pop() ?? "";
}

/**
 * Records in a SPARQL response: one row per record and author, grouped
 * here into one publication per record with its authors in order.
 */
export function parseSparql(response: SparqlResponse | null | undefined) {
  const byKey = new Map<string, DblpPublication>();
  const authors = new Map<string, Map<number, string>>();
  for (const row of response?.results?.bindings ?? []) {
    const value = (name: string) => row[name]?.value || undefined;
    const iri = value("pub");
    const title = value("title");
    if (!iri || !title) continue;
    const key = iri.replace(/^https:\/\/dblp\.org\/rec\//, "");
    let pub = byKey.get(key);
    if (!pub) {
      const year = Number(value("year"));
      const ee = value("ee");
      const volume = value("volume");
      pub = {
        key,
        title: title.replace(/\.$/, ""),
        authors: [],
        venue: value("venue") ?? "",
        year: Number.isInteger(year) ? year : undefined,
        type: localName(value("type") ?? ""),
        volume,
        number: value("number"),
        pages: value("pages"),
        doi: normalizeDOI(value("doi")),
        arxiv:
          arxivFromURL(ee) ??
          (volume?.startsWith("abs/")
            ? parseArxivId(volume.slice(4))
            : undefined),
        url: iri,
        ee,
      };
      byKey.set(key, pub);
      authors.set(key, new Map());
    }
    const ord = Number(value("ord"));
    const name = value("name");
    if (name && Number.isInteger(ord)) {
      authors.get(key)!.set(ord, stripHomonymNumber(name));
    }
  }
  for (const [key, pub] of byKey) {
    pub.authors = [...authors.get(key)!.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([, name]) => name);
  }
  return [...byKey.values()];
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** Lower-case surname without accents: the last word of a name. */
export function surname(name: string) {
  const words = normalizeForSearch(stripHomonymNumber(name))
    .replace(/\./g, " ")
    .split(/\s+/)
    .filter(Boolean);
  return words[words.length - 1] ?? "";
}

/** At least half of the item's authors (and at least one) are in `pub`. */
function sameAuthors(item: ItemInfo, pub: DblpPublication) {
  const mine = [...new Set(item.authors.map(surname).filter(Boolean))];
  if (!mine.length) return false;
  const theirs = new Set(pub.authors.map(surname));
  const shared = mine.filter((s) => theirs.has(s)).length;
  return shared >= 1 && shared >= mine.length / 2;
}

function plausibleYear(item: ItemInfo, pub: DblpPublication) {
  if (item.year === undefined || pub.year === undefined) return true;
  return (
    pub.year >= item.year - YEARS_BEFORE && pub.year <= item.year + YEARS_AFTER
  );
}

/** Is this record the item itself (same DOI, or same venue and year)? */
function isSameVersion(item: ItemInfo, pub: DblpPublication) {
  if (item.doi && pub.doi && item.doi === pub.doi) return true;
  return (
    !!item.venue &&
    normalizeForSearch(item.venue) === normalizeForSearch(pub.venue) &&
    item.year === pub.year
  );
}

/**
 * Find the published version of `item` among DBLP records. Only clear
 * matches are accepted: the same title (ignoring case and punctuation), a
 * plausible year, and shared authors. Preprint records (CoRR) are never a
 * published version. With several candidates, the earliest is chosen and
 * the others are reported.
 */
export function findPublishedVersion(
  item: ItemInfo,
  publications: DblpPublication[],
): DblpOutcome {
  const title = normalizeTitle(item.title);
  if (!title) return { kind: "none", reason: "Title too short to match." };
  const sameTitle = publications.filter(
    (p) => normalizeTitle(p.title) === title,
  );
  if (!sameTitle.length) return { kind: "none", reason: "Not found in DBLP." };
  if (!item.authors.length) {
    return { kind: "none", reason: "The item has no authors to compare." };
  }

  const published = sameTitle.filter(
    (p) =>
      PUBLISHED_TYPES.has(p.type) &&
      !PREPRINT_VENUE.test(p.venue) &&
      sameAuthors(item, p) &&
      plausibleYear(item, p),
  );
  const self = published.find((p) => isSameVersion(item, p));
  const others = published
    .filter((p) => p !== self && !isSameVersion(item, p))
    .sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
  if (others.length) {
    return { kind: "found", match: others[0], others: others.slice(1) };
  }
  if (self) return { kind: "already", match: self };
  return {
    kind: "none",
    reason: sameTitle.some((p) => PUBLISHED_TYPES.has(p.type))
      ? "DBLP has a publication with this title, but its authors or year do not match."
      : "DBLP lists only the preprint.",
  };
}

/** "KDD 2019", "J. Mach. Learn. Res. 21(4), 2020". */
export function describePublication(pub: DblpPublication) {
  let venue = pub.venue;
  if (pub.volume && !pub.volume.startsWith("abs/")) {
    venue += ` ${pub.volume}${pub.number ? `(${pub.number})` : ""}`;
  }
  return [venue, pub.year].filter(Boolean).join(pub.volume ? ", " : " ");
}
