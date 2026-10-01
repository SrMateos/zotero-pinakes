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
 * Build the index with a single SQL query instead of loading every item,
 * so it stays fast in large libraries. Trashed items, notes and attachments
 * are excluded.
 */
async function buildIndex(libraryID: number): Promise<LibraryIndex> {
  const started = Date.now();
  const names = ["DOI", "title", "url", "extra", "archiveID"];
  const fieldIDs = new Map<number, string>();
  for (const name of names) {
    const id = Zotero.ItemFields.getID(name);
    if (id) fieldIDs.set(id as number, name);
  }
  const placeholders = [...fieldIDs.keys()].map(() => "?").join(",");
  // The SQL must start with "SELECT": Zotero.DB.queryAsync() only returns
  // rows when the statement text begins with it (no leading whitespace).
  const sql = `SELECT ID.itemID AS itemID, ID.fieldID AS fieldID, V.value AS value
    FROM items I
    JOIN itemData ID ON ID.itemID = I.itemID
    JOIN itemDataValues V ON V.valueID = ID.valueID
    WHERE I.libraryID = ?
      AND ID.fieldID IN (${placeholders})
      AND I.itemID NOT IN (SELECT itemID FROM deletedItems)
      AND I.itemID NOT IN (SELECT itemID FROM itemAttachments)
      AND I.itemID NOT IN (SELECT itemID FROM itemNotes)`;
  const rows: any[] =
    (await Zotero.DB.queryAsync(sql, [libraryID, ...fieldIDs.keys()])) ?? [];

  const index: LibraryIndex = {
    doi: new Map(),
    arxiv: new Map(),
    title: new Map(),
  };
  for (const row of rows) {
    const itemID = row.itemID as number;
    const value = String(row.value ?? "");
    switch (fieldIDs.get(row.fieldID)) {
      case "DOI": {
        const doi = normalizeDOI(value);
        if (doi) index.doi.set(doi, itemID);
        const arxiv = arxivFromDOI(doi);
        if (arxiv) index.arxiv.set(arxiv, itemID);
        break;
      }
      case "title": {
        const title = normalizeTitle(value);
        if (title) index.title.set(title, itemID);
        break;
      }
      case "url": {
        const arxiv = arxivFromURL(value);
        if (arxiv) index.arxiv.set(arxiv, itemID);
        const doi = /doi\.org\//i.test(value) ? normalizeDOI(value) : undefined;
        if (doi) index.doi.set(doi, itemID);
        break;
      }
      case "extra": {
        const doi = doiFromExtra(value);
        if (doi) index.doi.set(doi, itemID);
        const arxiv = arxivFromExtra(value);
        if (arxiv) index.arxiv.set(arxiv, itemID);
        break;
      }
      case "archiveID": {
        const arxiv = parseArxivId(value);
        if (arxiv) index.arxiv.set(arxiv, itemID);
        break;
      }
    }
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
