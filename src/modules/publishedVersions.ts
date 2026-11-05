/**
 * "Find published versions": look up the selected items in DBLP and, only
 * when the user confirms, update them to the published version. Searches
 * go to dblp.org; the published full text is fetched with Zotero's own
 * "Find Full Text" resolvers, as that command would.
 */
import { log } from "../utils/log";
import {
  findPublishedVersion,
  parseSparql,
  sparqlQuery,
  type DblpOutcome,
  type DblpPublication,
  type SparqlResponse,
  type ItemInfo,
} from "./dblp";
import { arxivFromDOI, normalizeDOI, splitName } from "./identifiers";
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

/**
 * The regular items to check, in title order. Attachments, notes and
 * annotations stand for their parent item, and repeats are dropped: the
 * selection may contain both a paper and its PDF.
 */
export function checkableItems(items: Zotero.Item[]) {
  const chosen = new Map<number, Zotero.Item>();
  for (const item of items) {
    let current: Zotero.Item | undefined = item;
    while (current && !current.isRegularItem()) {
      current =
        (current.parentID && Zotero.Items.get(current.parentID)) || undefined;
    }
    if (current && !current.deleted) chosen.set(current.id, current);
  }
  return [...chosen.values()].sort((a, b) =>
    field(a, "title").localeCompare(field(b, "title")),
  );
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
// The action, applied only after the user confirms
// ---------------------------------------------------------------------------

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

const DBLP_KIND: Record<string, RefKind> = {
  Article: "journal",
  Inproceedings: "conference",
};

/** The published version as a Reference, to look it up by DOI. */
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
 * The published version already in the library, if any. Match by DOI only:
 * by title, the item itself would match.
 */
async function existingVersion(item: Zotero.Item, pub: DblpPublication) {
  if (!pub.doi) return undefined;
  const found = await findInLibrary(item.libraryID, [
    { ...asReference(pub), title: "" },
  ]);
  const id = found.get(0);
  return id && id !== item.id ? Zotero.Items.get(id) || undefined : undefined;
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
 * and a note records the previous metadata. If the published version is
 * already in the library, the duplicate is merged into the item, so no
 * two copies of the same paper are left. Returns whether it merged one.
 */
export async function updateToPublished(
  item: Zotero.Item,
  pub: DblpPublication,
) {
  const duplicate = await existingVersion(item, pub);
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
  if (duplicate) {
    // The published version was in the library already: keep this item
    // (it has the attachments, notes and collections) and move the
    // duplicate's own children, tags and collections into it.
    await Zotero.Items.merge(item, [duplicate]);
    log(`Merged duplicate item ${duplicate.id} into ${item.id} (${pub.key})`);
  }
  log(`Updated item ${item.id} to its published version ${pub.key}`);
  return !!duplicate;
}

// ---------------------------------------------------------------------------
// The published full text
// ---------------------------------------------------------------------------

/** What happened to the published full text. */
export type FullTextOutcome = "added" | "replaced" | "same" | "kept" | "none";

/** The PDFs attached to the item, trashed ones aside. */
function attachedPDFs(item: Zotero.Item) {
  return item
    .getAttachments()
    .map((id) => Zotero.Items.get(id))
    .filter((a): a is Zotero.Item => !!a && a.isPDFAttachment() && !a.deleted);
}

/**
 * Zotero's "same document" check for PDFs: a hash of the most common words
 * in the text. In Zotero 8+ it lives in mergeItems.mjs; Zotero 7 keeps it
 * on Items. Either way, a PDF without text (a scan) is not comparable.
 */
async function textHash(attachment: Zotero.Item): Promise<string | null> {
  try {
    const { hashAttachmentText } = ChromeUtils.importESModule(
      "chrome://zotero/content/mergeItems.mjs",
    ) as { hashAttachmentText?: (a: Zotero.Item) => Promise<string | null> };
    if (hashAttachmentText) return await hashAttachmentText(attachment);
  } catch {
    // Not this Zotero version.
  }
  const legacy = (Zotero.Items as any)._hashAttachmentText;
  if (typeof legacy === "function") {
    try {
      return await legacy.call(Zotero.Items, attachment);
    } catch {
      // Same as above: no text to compare.
    }
  }
  return null;
}

async function sameFile(a: Zotero.Item, b: Zotero.Item) {
  try {
    const [left, right] = [await a.attachmentHash, await b.attachmentHash];
    // A missing file has no hash: two of those are not the same file.
    return !!left && left === right;
  } catch {
    return false;
  }
}

async function sameDocument(a: Zotero.Item, b: Zotero.Item) {
  const [left, right] = [await textHash(a), await textHash(b)];
  return !!left && left === right;
}

/**
 * The rest of the checks Zotero's item merge makes before combining two
 * PDFs: different link modes stay apart, and a file with annotations
 * embedded in the PDF is never trashed in favour of another one.
 */
async function safeToMerge(old: Zotero.Item, file: Zotero.Item) {
  if (old.isImportedAttachment() !== file.isImportedAttachment()) return false;
  if (old.isLinkedFileAttachment() !== file.isLinkedFileAttachment())
    return false;
  try {
    return !(await old.hasEmbeddedAnnotations());
  } catch {
    // Could not tell: be safe and keep both.
    return false;
  }
}

/**
 * Look for the published full text, as Zotero's "Find Full Text" does
 * (the DOI page, the item's URL, open-access copies, the user's own
 * resolvers), and adopt it without losing anything:
 *
 * - the very same file: it is dropped and the attachment already there is
 *   kept, annotations included;
 * - a different file with the same text: the entry replaces the old PDF,
 *   which is trashed after its annotations move to the new one;
 * - a different document: it is added next to the old PDF, which keeps
 *   its annotations.
 *
 * Never throws: a failed lookup or download must not undo the update.
 */
export async function addPublishedFullText(
  item: Zotero.Item,
): Promise<FullTextOutcome> {
  const before = attachedPDFs(item);
  let added: Zotero.Item | false;
  try {
    // Find Full Text: addAvailableFile() on Zotero 8+, the alias
    // addAvailablePDF() on Zotero 7.
    const attachments = Zotero.Attachments as any;
    const download =
      attachments.addAvailableFile ?? attachments.addAvailablePDF;
    if (!download) return "none";
    added = await download.call(attachments, item);
  } catch (error) {
    log(`Full-text lookup failed for item ${item.id}`, error);
    return "none";
  }
  if (!added) return "none";
  const file = added;

  for (const old of before) {
    if (await sameFile(old, file)) {
      await Zotero.DB.executeTransaction(async () => {
        file.deleted = true;
        await file.save();
      });
      return "same";
    }
  }
  for (const old of before) {
    if (!(await sameDocument(old, file))) continue;
    if (!(await safeToMerge(old, file))) continue;
    // Same text, so the annotations stay on the right pages.
    await Zotero.DB.executeTransaction(async () => {
      // Zotero 10 takes options here; Zotero 7 a boolean.
      await (Zotero.Items.moveChildItems as any)(old, file, {
        includeTrashed: true,
      });
      old.deleted = true;
      await old.save();
    });
    log(`Replaced the PDF of item ${item.id} with the published full text`);
    return "replaced";
  }
  return before.length ? "kept" : "added";
}
