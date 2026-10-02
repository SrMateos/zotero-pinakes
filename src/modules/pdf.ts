/**
 * PDF fallback: when no API has references (or the item has no DOI/arXiv
 * ID), read the bibliography from the PDF's text and resolve each entry
 * through Crossref's bibliographic search.
 */
import { log } from "../utils/log";
import {
  entryYear,
  extractBibliography,
  titleInEntry,
  type BibEntry,
} from "./bibliography";
import { normalizeDOI } from "./identifiers";
import { arxivInText, entryReference, orderByPaper } from "./ordering";
import {
  getJSON,
  SourceError,
  sourceLabel,
  type StatusCallback,
} from "./sources";
import type { PaperId, RefKind, Reference, ReferenceList } from "./types";

const CROSSREF_BASE = "https://api.crossref.org";
/** Entries longer than this are cut before querying Crossref. */
const MAX_QUERY_LENGTH = 400;
/** Minimum time between Crossref requests (its public pool rate-limits). */
const CROSSREF_SPACING_MS = 600;

/** The PDF attachment to read: the best attachment, else the first PDF. */
async function findPdf(item: Zotero.Item) {
  const best = await item.getBestAttachment();
  if (best && best.isPDFAttachment()) return best;
  for (const id of item.getAttachments()) {
    const attachment = Zotero.Items.get(id);
    if (attachment && attachment.isPDFAttachment()) return attachment;
  }
  return undefined;
}

/** Bibliography entries of the item's PDF, or a SourceError explaining why not. */
export async function readBibliography(item: Zotero.Item) {
  const pdf = await findPdf(item);
  if (!pdf) throw new SourceError("This item has no PDF attachment.");
  if (!(await pdf.fileExists())) {
    throw new SourceError("The PDF file is not available locally.");
  }
  let text: string;
  try {
    const result = await Zotero.PDFWorker.getFullText(pdf.id, null, true);
    text = result?.text ?? "";
  } catch (e) {
    throw new SourceError(
      `Could not read the PDF text: ${e instanceof Error ? e.message : e}`,
    );
  }
  const bibliography = extractBibliography(text);
  if (!bibliography) {
    throw new SourceError(
      'Could not find a "References" or "Bibliography" section in the PDF.',
    );
  }
  log(
    `PDF ${pdf.id}: ${bibliography.entries.length} ${bibliography.style} entries`,
  );
  return bibliography;
}

/**
 * Build a reference list from the item's PDF: extract the bibliography,
 * then resolve each entry via Crossref (one request at a time, as the
 * Crossref public pool asks). Unresolved entries are kept as plain text.
 */
export async function referencesFromPdf(
  item: Zotero.Item,
  paperId: PaperId | undefined,
  notes: string[],
  onStatus: StatusCallback,
  isCancelled: () => boolean,
): Promise<ReferenceList> {
  onStatus("Reading the bibliography from the PDF…");
  const { entries } = await readBibliography(item);

  const references: Reference[] = [];
  let resolved = 0;
  let crossrefError: string | undefined;
  for (const [i, entry] of entries.entries()) {
    if (isCancelled()) throw new SourceError("Cancelled.");
    onStatus(
      `Resolving PDF references via Crossref: ${i + 1} of ${entries.length}…`,
    );
    let ref: Reference | undefined;
    if (!crossrefError) {
      const started = Date.now();
      try {
        ref = await resolveEntry(entry, i + 1, onStatus);
      } catch (e) {
        // Stop querying after a hard failure; keep the rest as text.
        crossrefError = e instanceof Error ? e.message : String(e);
        log("Crossref failed", e);
      }
      const wait = CROSSREF_SPACING_MS - (Date.now() - started);
      if (wait > 0) await Zotero.Promise.delay(wait);
    }
    ref ??= entryReference(entry, i + 1);
    if (!ref.unresolved) resolved++;
    references.push(ref);
  }

  notes.push(
    `Extracted ${entries.length} references from the PDF; ${resolved} resolved via Crossref.`,
  );
  if (crossrefError) notes.push(`Crossref: ${crossrefError}`);
  return {
    paperId,
    source: "pdf",
    order: "paper",
    fetchedAt: new Date().toISOString(),
    references,
    notes,
  };
}

const CROSSREF_KIND: Record<string, RefKind> = {
  "journal-article": "journal",
  "proceedings-article": "conference",
  "posted-content": "preprint",
};

/** Query Crossref for one entry; undefined if nothing matches its title. */
async function resolveEntry(
  entry: BibEntry,
  index: number,
  onStatus: StatusCallback,
): Promise<Reference | undefined> {
  const query = encodeURIComponent(entry.text.slice(0, MAX_QUERY_LENGTH));
  const url =
    `${CROSSREF_BASE}/works?query.bibliographic=${query}&rows=3` +
    `&select=DOI,title,author,issued,container-title,type,abstract`;
  const data = await getJSON(url, "Crossref", onStatus);
  for (const work of data?.message?.items ?? []) {
    const title = Array.isArray(work.title) ? work.title[0] : work.title;
    if (!title || !titleInEntry(title, entry.text)) continue;
    const doi = normalizeDOI(work.DOI);
    return {
      index,
      label: entry.label,
      raw: entry.text,
      title,
      authors: (work.author ?? [])
        .map(
          (a: any) => [a.given, a.family].filter(Boolean).join(" ") || a.name,
        )
        .filter(Boolean),
      year: work.issued?.["date-parts"]?.[0]?.[0] ?? entryYear(entry.text),
      venue: work["container-title"]?.[0] || undefined,
      doi,
      arxiv: arxivInText(entry.text),
      abstract: work.abstract
        ? String(work.abstract)
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
        : undefined,
      kind: CROSSREF_KIND[work.type] ?? "other",
    };
  }
  return undefined;
}

/**
 * Put an API list in the order of the paper's bibliography, read locally
 * from the PDF (no network). If the PDF or its bibliography is unavailable,
 * or too few entries match (probably a different PDF or a parsing
 * problem), the API order is kept and a note says why.
 */
export async function applyPaperOrder(
  item: Zotero.Item,
  list: ReferenceList,
): Promise<ReferenceList> {
  const label = sourceLabel(list.source);
  let entries;
  try {
    ({ entries } = await readBibliography(item));
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return {
      ...list,
      order: "source",
      notes: [
        ...list.notes,
        `In ${label}'s order, which may differ from the paper's: ${reason}`,
      ],
    };
  }
  const result = orderByPaper(list.references, entries);
  const enough = Math.max(
    3,
    Math.min(entries.length, list.references.length) * 0.3,
  );
  if (result.matched < enough) {
    log(
      `Paper order: only ${result.matched} of ${entries.length} entries matched`,
    );
    return {
      ...list,
      order: "source",
      notes: [
        ...list.notes,
        `In ${label}'s order: the PDF bibliography (${entries.length} entries) does not match this list well enough to reorder it.`,
      ],
    };
  }
  log(
    `Paper order: ${result.matched} of ${entries.length} entries matched, ${result.extra} extra`,
  );
  const notes = [...list.notes];
  const missing = entries.length - result.matched;
  if (missing) {
    notes.push(
      `${missing} of the paper's ${entries.length} references are not in ${label}; they are shown from the PDF text.`,
    );
  }
  if (result.extra) {
    notes.push(
      `${result.extra} references from ${label} were not found in the PDF bibliography; they are listed at the end.`,
    );
  }
  return { ...list, references: result.references, order: "paper", notes };
}
