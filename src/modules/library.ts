/**
 * Everything that reads the local Zotero library: the identifier of the
 * citing paper and the "already in library" index.
 */
import { log } from "../utils/log";
import {
  arxivFromDOI,
  arxivFromExtra,
  arxivFromURL,
  doiFromExtra,
  normalizeDOI,
  normalizeTitle,
  parseArxivId,
} from "./identifiers";
import type { PaperId, Reference } from "./types";

/** Safe getField: returns "" for fields that are not valid for the type. */
function field(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) ?? "");
  } catch {
    return "";
  }
}

/**
 * Identifier used to look up the references of an item: the DOI field
 * first, then an arXiv ID from the URL, Extra or Archive ID ("Loc. in
 * Archive") fields. arXiv's own DataCite DOIs are treated as arXiv IDs.
 */
export function getPaperId(item: Zotero.Item): PaperId | undefined {
  const extra = field(item, "extra");
  const doi = normalizeDOI(field(item, "DOI")) ?? doiFromExtra(extra);
  if (doi) {
    const fromDoi = arxivFromDOI(doi);
    return fromDoi
      ? { kind: "arXiv", value: fromDoi }
      : { kind: "DOI", value: doi };
  }
  const arxiv =
    arxivFromURL(field(item, "url")) ??
    arxivFromExtra(extra) ??
    parseArxivId(field(item, "archiveID")) ??
    parseArxivId(field(item, "number"));
  return arxiv ? { kind: "arXiv", value: arxiv } : undefined;
}

// ---------------------------------------------------------------------------
// "In library" index
// ---------------------------------------------------------------------------

interface LibraryIndex {
  doi: Map<string, number>;
  arxiv: Map<string, number>;
  title: Map<string, number>;
}

const indexes = new Map<number, Promise<LibraryIndex>>();

/** Drop cached indexes; called from the item notifier. */
export function invalidateLibraryIndex() {
  indexes.clear();
}

function getIndex(libraryID: number) {
  let index = indexes.get(libraryID);
  if (!index) {
    index = buildIndex(libraryID);
    indexes.set(libraryID, index);
    // Do not keep a failed build around.
    index.catch(() => indexes.delete(libraryID));
  }
  return index;
}

/**
 * Build the index from Zotero's in-memory item cache (all item data is
 * loaded at startup, so this does not touch the database). Trashed items,
 * notes and attachments are excluded.
 */
async function buildIndex(libraryID: number): Promise<LibraryIndex> {
  const started = Date.now();
  const items: Zotero.Item[] = await Zotero.Items.getAll(libraryID, true);
  const index: LibraryIndex = {
    doi: new Map(),
    arxiv: new Map(),
    title: new Map(),
  };
  const add = (
    map: Map<string, number>,
    key: string | undefined,
    id: number,
  ) => {
    if (key && !map.has(key)) map.set(key, id);
  };
  for (const item of items) {
    if (!item.isRegularItem() || item.deleted) continue;
    const id = item.id;
    const extra = field(item, "extra");
    const url = field(item, "url");
    const doi = normalizeDOI(field(item, "DOI"));
    add(index.doi, doi, id);
    add(index.doi, doiFromExtra(extra), id);
    if (/doi\.org\//i.test(url)) add(index.doi, normalizeDOI(url), id);
    add(index.arxiv, arxivFromDOI(doi), id);
    add(index.arxiv, arxivFromURL(url), id);
    add(index.arxiv, arxivFromExtra(extra), id);
    add(index.arxiv, parseArxivId(field(item, "archiveID")), id);
    add(index.title, normalizeTitle(field(item, "title")) || undefined, id);
  }
  log(
    `Indexed library ${libraryID}: ${index.doi.size} DOIs, ${index.arxiv.size} arXiv IDs, ${index.title.size} titles in ${Date.now() - started} ms`,
  );
  return index;
}

/**
 * For each reference, the ID of a matching item in the library (matched by
 * DOI, then arXiv ID, then normalised title), or undefined.
 */
export async function findInLibrary(
  libraryID: number,
  references: Reference[],
): Promise<Map<number, number>> {
  const index = await getIndex(libraryID);
  const matches = new Map<number, number>();
  for (const ref of references) {
    const itemID =
      (ref.doi && index.doi.get(ref.doi)) ||
      (ref.arxiv && index.arxiv.get(ref.arxiv)) ||
      index.title.get(normalizeTitle(ref.title));
    if (itemID) matches.set(ref.index, itemID);
  }
  return matches;
}
