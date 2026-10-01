/**
 * Importing references into Zotero.
 *
 * Items are always created directly in the library that owns the target
 * collection: libraryID and collections are passed together to
 * Zotero.Translate.Search#translate(), exactly like Zotero's own "Add Item
 * by Identifier". Creating the item in one library and then adding it to a
 * collection of another library would violate the
 * fki_collectionItems_libraryID constraint.
 */
import { log } from "../utils/log";
import { arxivFromDOI, splitName } from "./identifiers";
import type { RefKind, Reference } from "./types";

export interface ImportTarget {
  libraryID: number;
  collectionID?: number;
  /** Human-readable "Library › Collection" label. */
  label: string;
}

export type ImportMethod = "DOI" | "arXiv" | "metadata";

export interface ImportResult {
  item: Zotero.Item;
  method: ImportMethod;
}

/** How the import target is chosen (preference "targetMode"). */
export type TargetMode = "selected" | "parent" | "root";

/**
 * Where imported references go, for references cited by `citing`:
 *
 * - "selected" (default): the collection selected in the main window; if no
 *   collection is selected, the root of the citing item's library.
 * - "parent": the first collection that contains the citing item; if it is
 *   in none, the root of its library.
 * - "root": always the root of the citing item's library.
 */
export function resolveTarget(
  citing: Zotero.Item,
  mode: TargetMode = "selected",
): ImportTarget {
  let collection: Zotero.Collection | undefined | false;
  if (mode === "selected") {
    try {
      const pane = Zotero.getMainWindow()?.ZoteroPane;
      collection = pane?.getSelectedCollections()?.[0];
    } catch (e) {
      log("Could not read the selected collection", e);
    }
  } else if (mode === "parent") {
    const first = citing.getCollections()[0];
    collection = first ? Zotero.Collections.get(first) : undefined;
  }
  if (collection) {
    return {
      libraryID: collection.libraryID,
      collectionID: collection.id,
      label: `${libraryName(collection.libraryID)} › ${collection.name}`,
    };
  }
  return {
    libraryID: citing.libraryID,
    label: libraryName(citing.libraryID),
  };
}

export function sameTarget(a?: ImportTarget, b?: ImportTarget) {
  return a?.libraryID === b?.libraryID && a?.collectionID === b?.collectionID;
}

function libraryName(libraryID: number) {
  const library = Zotero.Libraries.get(libraryID);
  return library ? library.name : `Library ${libraryID}`;
}

/** Throws a user-facing error if the target library is read-only. */
export function checkTargetEditable(target: ImportTarget) {
  const library = Zotero.Libraries.get(target.libraryID);
  if (!library) throw new Error(`Library ${target.libraryID} does not exist.`);
  if (!library.editable) {
    throw new Error(`"${library.name}" is read-only; cannot import into it.`);
  }
}

/**
 * Import one reference into the target: by DOI, then by arXiv ID, then
 * from the API metadata if neither identifier resolves.
 */
export async function importReference(
  ref: Reference,
  target: ImportTarget,
): Promise<ImportResult> {
  checkTargetEditable(target);
  // arXiv's DataCite DOIs translate better through the arXiv translator.
  const doi = ref.doi && !arxivFromDOI(ref.doi) ? ref.doi : undefined;
  const arxiv = ref.arxiv ?? arxivFromDOI(ref.doi);

  const attempts: Array<[ImportMethod, { DOI?: string; arXiv?: string }]> = [];
  if (doi) attempts.push(["DOI", { DOI: doi }]);
  if (arxiv) attempts.push(["arXiv", { arXiv: arxiv }]);

  for (const [method, identifier] of attempts) {
    try {
      const items = await translateIdentifier(identifier, target);
      if (items.length) return { item: items[0], method };
      log(`No item returned for ${method} ${Object.values(identifier)[0]}`);
    } catch (e) {
      log(
        `Translation failed for ${method} ${Object.values(identifier)[0]}`,
        e,
      );
    }
  }
  return { item: await createFromMetadata(ref, target), method: "metadata" };
}

async function translateIdentifier(
  identifier: { DOI?: string; arXiv?: string },
  target: ImportTarget,
): Promise<Zotero.Item[]> {
  const translate = new Zotero.Translate.Search();
  translate.setIdentifier(identifier);
  // Be lenient about translators, as Zotero's lookup does.
  const translators = await translate.getTranslators();
  if (!translators.length) throw new Error("no translator available");
  translate.setTranslator(translators);

  const collections = target.collectionID ? [target.collectionID] : false;
  log(
    `Translating ${JSON.stringify(identifier)} into libraryID=${target.libraryID} collections=${JSON.stringify(collections)}`,
  );
  const items: Zotero.Item[] = await translate.translate({
    libraryID: target.libraryID,
    collections,
    saveAttachments: true,
  });
  for (const item of items) {
    if (item.libraryID !== target.libraryID) {
      // Should never happen; logged loudly so it is caught in testing.
      log(
        `WARNING: item ${item.id} was saved in library ${item.libraryID}, expected ${target.libraryID}`,
      );
    }
  }
  return items;
}

const ITEM_TYPE: Record<RefKind, string> = {
  journal: "journalArticle",
  conference: "conferencePaper",
  preprint: "preprint",
  other: "journalArticle",
};

const VENUE_FIELD: Record<string, string> = {
  journalArticle: "publicationTitle",
  conferencePaper: "proceedingsTitle",
  preprint: "repository",
};

/** Create an item from API metadata when no identifier can be resolved. */
async function createFromMetadata(
  ref: Reference,
  target: ImportTarget,
): Promise<Zotero.Item> {
  const itemType = ITEM_TYPE[ref.kind];
  const item = new Zotero.Item(itemType as any);
  item.libraryID = target.libraryID;
  const extra: string[] = [];

  const set = (name: string, value: string | undefined) => {
    if (!value) return false;
    const fieldID = Zotero.ItemFields.getID(name);
    if (
      !fieldID ||
      !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)
    ) {
      return false;
    }
    item.setField(name as any, value);
    return true;
  };

  set("title", ref.title);
  set("date", ref.year ? String(ref.year) : undefined);
  set(VENUE_FIELD[itemType], ref.venue);
  set("abstractNote", ref.abstract);
  if (ref.doi && !set("DOI", ref.doi)) extra.push(`DOI: ${ref.doi}`);
  if (ref.arxiv) {
    set("url", `https://arxiv.org/abs/${ref.arxiv}`);
    if (!set("archiveID", `arXiv:${ref.arxiv}`))
      extra.push(`arXiv: ${ref.arxiv}`);
  }
  if (extra.length) set("extra", extra.join("\n"));

  item.setCreators(
    ref.authors.slice(0, 100).map((name) => ({
      ...splitName(name),
      creatorType: "author",
    })) as any,
  );
  if (target.collectionID) item.setCollections([target.collectionID]);

  log(
    `Creating ${itemType} from metadata in libraryID=${target.libraryID} collection=${target.collectionID ?? "none"}: ${ref.title}`,
  );
  await item.saveTx({ skipSelect: true });
  return item;
}
