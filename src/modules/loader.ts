/**
 * Where a reference list comes from: the cache, the APIs (put in the
 * paper's order), or the PDF bibliography resolved through Crossref.
 * No UI here: the section decides how to show the outcome.
 */
import { log } from "../utils/log";
import { getPref } from "../utils/prefs";
import { getCached, setCached } from "./cache";
import { getPaperId } from "./library";
import { applyPaperOrder, referencesFromPdf } from "./pdf";
import { describe, fetchReferences, type StatusCallback } from "./sources";
import type { ReferenceList } from "./types";

export interface LoadOptions {
  /** Ignore the cache (Refresh). */
  force: boolean;
  /** Allow the PDF fallback, which sends one Crossref request per entry. */
  allowPdf: boolean;
  /** Wait this long before going to the network (library view debounce). */
  delayMs: number;
  onStatus: StatusCallback;
  /** True once the caller no longer wants the result. */
  isStale: () => boolean;
}

export type LoadResult =
  | { kind: "list"; list: ReferenceList }
  | {
      kind: "failed";
      severity: "info" | "error";
      message: string;
      /** Short text for the collapsed section header. */
      summary: string;
      /** The PDF fallback could still be tried on request. */
      canTryPdf: boolean;
    }
  | { kind: "stale" };

const NO_IDENTIFIER =
  "No identifier: this item has no DOI and no arXiv ID (checked the DOI, URL, Extra and Archive ID fields). Add one to see its references.";

export async function loadReferenceList(
  item: Zotero.Item,
  options: LoadOptions,
): Promise<LoadResult> {
  const paperId = getPaperId(item);
  if (!options.force) {
    const cached = await getCached(item, paperId);
    if (cached) {
      log(`Using cached references for ${describe(paperId)}`);
      return { kind: "list", list: cached };
    }
  }

  const pdfEnabled = getPref("pdfFallback") !== false;
  const usePdf = pdfEnabled && options.allowPdf;
  if (!paperId && !usePdf) {
    return {
      kind: "failed",
      severity: "info",
      message: NO_IDENTIFIER,
      summary: "No identifier",
      canTryPdf: pdfEnabled,
    };
  }

  if (options.delayMs) {
    await Zotero.Promise.delay(options.delayMs);
    if (options.isStale()) return { kind: "stale" };
  }

  const notes: string[] = [];
  if (paperId) {
    options.onStatus(`Fetching references for ${describe(paperId)}…`);
    try {
      const fetched = await fetchReferences(paperId, options.onStatus);
      if (options.isStale()) return { kind: "stale" };
      options.onStatus("Ordering as in the paper's bibliography…");
      return saved(item, await applyPaperOrder(item, fetched));
    } catch (e) {
      if (options.isStale()) return { kind: "stale" };
      const message = errorMessage(e);
      if (!usePdf) {
        return {
          kind: "failed",
          severity: "error",
          message: `Could not load references for ${describe(paperId)}.\n${message}`,
          summary: "Error",
          canTryPdf: pdfEnabled,
        };
      }
      notes.push(...message.split("\n"));
    }
  } else {
    notes.push("This item has no DOI or arXiv ID.");
  }

  try {
    const list = await referencesFromPdf(
      item,
      paperId,
      notes,
      options.onStatus,
      options.isStale,
    );
    return saved(item, list);
  } catch (e) {
    if (options.isStale()) return { kind: "stale" };
    return {
      kind: "failed",
      severity: "error",
      message: `${notes.join("\n")}\nReading the PDF bibliography failed: ${errorMessage(e)}`,
      summary: paperId ? "Error" : "No identifier",
      canTryPdf: false,
    };
  }
}

async function saved(item: Zotero.Item, list: ReferenceList) {
  await setCached(item, list);
  return { kind: "list" as const, list };
}

function errorMessage(e: unknown) {
  return e instanceof Error ? e.message : String(e);
}
