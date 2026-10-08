/**
 * "Find published versions": look up items of a collection in DBLP and,
 * only when the user confirms, record or apply the published version.
 * DBLP (dblp.org) is the only host this file talks to; importing a
 * published version goes through Zotero's translators, as elsewhere.
 */
import { log } from "../utils/log";
import {
  findPublishedVersion,
  isPreprintOrUnpublished,
  parseSparql,
  sparqlQuery,
  type DblpOutcome,
  type DblpPublication,
  type SparqlResponse,
  type ItemInfo,
} from "./dblp";
import { arxivFromDOI, normalizeDOI, splitName } from "./identifiers";
import { importReference, type ImportTarget } from "./importer";
import { findInLibrary, getPaperId } from "./library";
import { getJSON, type StatusCallback } from "./sources";
import type { RefKind, Reference } from "./types";

/**
 * DBLP's SPARQL service. Its search API (dblp.org/search/publ/api) now
 * answers programs with a bot check instead of JSON; this service does
 * not.
 */
const DBLP_SPARQL = "https://sparql.dblp.org/sparql";
/** Minimum time between DBLP requests: DBLP asks to be used gently. */
export const DBLP_SPACING_MS = 700;

/** The tag added by "Add a note and tag". */
export const PUBLISHED_TAG = "Published version available";

/** Which items of the collection to check. */
export type CheckScope = "preprints" | "all";

/** Safe getField: "" for fields that are not valid for the type. */
function field(item: Zotero.Item, name: string): string {
  try {
    return String(item.getField(name as any) ?? "");
  } catch {
    return "";
  }
}

const VENUE_FIELDS = [
  "publicationTitle",
  "proceedingsTitle",
  "conferenceName",
  "bookTitle",
  "repository",
  "university",
  "institution",
];

export function itemInfo(item: Zotero.Item): ItemInfo {
  const paperId = getPaperId(item);
  const doi = normalizeDOI(field(item, "DOI"));
  const year = Number(Zotero.Date.strToDate(field(item, "date")).year);
  const author = Zotero.CreatorTypes.getPrimaryIDForType(item.itemTypeID);
  return {
    itemType: Zotero.ItemTypes.getName(item.itemTypeID),
    title: field(item, "title"),
    authors: item
      .getCreators()
      .filter((c) => c.creatorTypeID === author)
      .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" ")),
    year: Number.isInteger(year) && year > 0 ? year : undefined,
    venue: VENUE_FIELDS.map((name) => field(item, name)).find(Boolean) ?? "",
    doi: doi && !arxivFromDOI(doi) ? doi : undefined,
    arxiv: paperId?.kind === "arXiv" ? paperId.value : undefined,
  };
}

/** The regular items of a collection to check, in title order. */
export function itemsToCheck(collection: Zotero.Collection, scope: CheckScope) {
  return collection
    .getChildItems(false, false)
    .filter((item) => item.isRegularItem() && !item.deleted)
    .filter(
      (item) => scope === "all" || isPreprintOrUnpublished(itemInfo(item)),
    )
    .sort((a, b) => field(a, "title").localeCompare(field(b, "title")));
}

/** Search DBLP for the item's title and pick the published version. */
export async function searchPublishedVersion(
  item: Zotero.Item,
  onStatus: StatusCallback,
): Promise<DblpOutcome> {
  const info = itemInfo(item);
  if (!info.title.trim()) {
    return { kind: "none", reason: "The item has no title." };
  }
  const url = `${DBLP_SPARQL}?query=${encodeURIComponent(sparqlQuery(info))}`;
  const response = await getJSON<SparqlResponse>(url, "DBLP", onStatus, {
    Accept: "application/sparql-results+json",
  });
  return findPublishedVersion(info, parseSparql(response));
}

// ---------------------------------------------------------------------------
// Actions, applied only after the user confirms
// ---------------------------------------------------------------------------

export type PublishedAction = "note" | "related" | "update";

function escape(text: string) {
  return Zotero.Utilities.htmlSpecialChars(text);
}

function link(url: string, text = url) {
  return `<a href="${escape(url)}">${escape(text)}</a>`;
}

function publicationHTML(pub: DblpPublication) {
  const parts = [
    `${escape(pub.title)}.`,
    `${escape(pub.authors.join(", "))}.`,
    `<i>${escape(pub.venue)}</i>${pub.year ? ` ${pub.year}` : ""}.`,
  ];
  if (pub.doi)
    parts.push(`DOI: ${link(`https://doi.org/${pub.doi}`, pub.doi)}.`);
  parts.push(`DBLP: ${link(pub.url, pub.key)}.`);
  return parts.join(" ");
}

async function addNote(item: Zotero.Item, html: string) {
  const note = new Zotero.Item("note");
  note.libraryID = item.libraryID;
  note.parentID = item.id;
  note.setNote(html);
  await note.saveTx();
  return note;
}

/** Add a child note describing the published version, and a tag. */
export async function addNoteAndTag(item: Zotero.Item, pub: DblpPublication) {
  if (item.hasTag(PUBLISHED_TAG)) return;
  await addNote(
    item,
    `<h2>Published version</h2><p>${publicationHTML(pub)}</p><p>Found in DBLP by Pinakes.</p>`,
  );
  item.addTag(PUBLISHED_TAG);
  await item.saveTx();
}

const DBLP_KIND: Record<string, RefKind> = {
  Article: "journal",
  Inproceedings: "conference",
};

/** The published version as a Reference, for importReference(). */
function asReference(pub: DblpPublication): Reference {
  return {
    index: 0,
    title: pub.title,
    authors: pub.authors,
    year: pub.year,
    venue: pub.venue,
    doi: pub.doi,
    kind: DBLP_KIND[pub.type] ?? "other",
  };
}

/**
 * Import the published version next to the item (or reuse it if it is in
 * the library already, by DOI) and make the two related items.
 */
export async function addAsRelated(
  item: Zotero.Item,
  pub: DblpPublication,
  collectionID?: number,
) {
  let published: Zotero.Item | undefined;
  if (pub.doi) {
    // Match by DOI only: by title, the item itself would match.
    const found = await findInLibrary(item.libraryID, [
      { ...asReference(pub), title: "" },
    ]);
    const id = found.get(0);
    if (id && id !== item.id) published = Zotero.Items.get(id) || undefined;
  }
  if (!published) {
    const target: ImportTarget = {
      libraryID: item.libraryID,
      collectionID,
      label: "",
    };
    published = (await importReference(asReference(pub), target)).item;
  }
  item.addRelatedItem(published);
  published.addRelatedItem(item);
  await Zotero.DB.executeTransaction(async () => {
    await item.save();
    await published.save();
  });
  return published;
}

/** Fields never copied from the published version's metadata. */
const SKIPPED_FIELDS = new Set([
  "itemType",
  "creators",
  "tags",
  "notes",
  "attachments",
  "seeAlso",
  "collections",
  "relations",
  "key",
  "version",
  "extra",
  "accessDate",
  "libraryCatalog",
]);

/** Item JSON for the published version: by DOI, else from DBLP's record. */
async function publishedJSON(
  pub: DblpPublication,
): Promise<Record<string, any>> {
  if (pub.doi) {
    try {
      const translate = new Zotero.Translate.Search();
      translate.setIdentifier({ DOI: pub.doi });
      const translators = await translate.getTranslators();
      if (translators.length) {
        translate.setTranslator(translators);
        // libraryID false: return the metadata without saving an item.
        const items = await translate.translate({
          libraryID: false,
          saveAttachments: false,
        } as any);
        if (items?.[0]) return items[0] as Record<string, any>;
      }
    } catch (e) {
      log(`Could not translate DOI ${pub.doi}; using DBLP's metadata`, e);
    }
  }
  const itemType =
    pub.type === "Article"
      ? "journalArticle"
      : pub.type === "Incollection"
        ? "bookSection"
        : "conferencePaper";
  const venueField =
    itemType === "journalArticle"
      ? "publicationTitle"
      : itemType === "bookSection"
        ? "bookTitle"
        : "proceedingsTitle";
  return {
    itemType,
    title: pub.title,
    creators: pub.authors.map((name) => ({
      ...splitName(name),
      creatorType: "author",
    })),
    date: pub.year ? String(pub.year) : "",
    [venueField]: pub.venue,
    volume: pub.volume ?? "",
    issue: pub.number ?? "",
    pages: pub.pages ?? "",
    DOI: pub.doi ?? "",
    url: pub.ee ?? pub.url,
  };
}

/**
 * Turn the item into its published version: item type, fields and
 * authors come from the published metadata. Attachments, notes, tags,
 * collections and related items are kept; the arXiv ID is kept in Extra,
 * and a note records the previous metadata.
 */
export async function updateToPublished(
  item: Zotero.Item,
  pub: DblpPublication,
) {
  const json = await publishedJSON(pub);
  const before = itemInfo(item);
  const previous = [
    Zotero.ItemTypes.getLocalizedString(item.itemTypeID),
    before.venue,
    before.year,
    before.doi
      ? `DOI ${before.doi}`
      : before.arxiv
        ? `arXiv:${before.arxiv}`
        : "",
    field(item, "url"),
  ].filter(Boolean);

  const typeID = Zotero.ItemTypes.getID(json.itemType);
  if (typeID && typeID !== item.itemTypeID) item.setType(typeID);
  for (const [name, value] of Object.entries(json)) {
    if (SKIPPED_FIELDS.has(name) || typeof value !== "string") continue;
    const fieldID = Zotero.ItemFields.getID(name);
    if (
      !fieldID ||
      !Zotero.ItemFields.isValidForType(fieldID, item.itemTypeID)
    ) {
      continue;
    }
    // Keep what the item has when the published metadata lacks a field.
    if (value) item.setField(name as any, value);
  }
  // Never keep the preprint's DOI (arXiv's DataCite DOI) on the published
  // version; the arXiv ID goes to Extra below.
  if (
    Zotero.ItemFields.isValidForType(
      Zotero.ItemFields.getID("DOI") as number,
      item.itemTypeID,
    )
  ) {
    item.setField("DOI", typeof json.DOI === "string" ? json.DOI : "");
  }
  if (Array.isArray(json.creators) && json.creators.length) {
    item.setCreators(json.creators);
  }
  const extra = field(item, "extra")
    .split("\n")
    .filter((line) => line.trim());
  if (before.arxiv && !extra.some((line) => /^arxiv\s*:/i.test(line))) {
    extra.push(`arXiv: ${before.arxiv}`);
  }
  item.setField("extra", extra.join("\n"));
  await item.saveTx();

  await addNote(
    item,
    `<h2>Updated to the published version</h2><p>${publicationHTML(pub)}</p>` +
      `<p>Before: ${escape(previous.join(", "))}.</p><p>Found in DBLP by Pinakes.</p>`,
  );
  log(`Updated item ${item.id} to its published version ${pub.key}`);
}
