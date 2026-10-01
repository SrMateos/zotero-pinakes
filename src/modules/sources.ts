/**
 * Reference sources: Semantic Scholar Graph API (primary) and OpenAlex
 * (fallback). These are the only hosts this file talks to.
 */
import { log } from "../utils/log";
import { getPref } from "../utils/prefs";
import {
  abstractFromInvertedIndex,
  arxivFromDOI,
  arxivFromURL,
  normalizeDOI,
  parseArxivId,
} from "./identifiers";
import type {
  PaperId,
  RefKind,
  Reference,
  ReferenceList,
  SourceName,
} from "./types";

const S2_BASE = "https://api.semanticscholar.org/graph/v1";
const OPENALEX_BASE = "https://api.openalex.org";

const S2_FIELDS =
  "title,authors,year,venue,externalIds,abstract,publicationTypes";
const S2_PAGE_SIZE = 500;
const MAX_REFERENCES = 3000;
const OPENALEX_BATCH = 50;

const MAX_RETRIES = 4;
const MAX_RETRY_DELAY_MS = 60_000;

export type StatusCallback = (message: string) => void;

/** An error whose message is meant to be shown in the panel as-is. */
export class SourceError extends Error {
  constructor(
    message: string,
    public status?: number,
  ) {
    super(message);
    this.name = "SourceError";
  }
}

const SOURCE_LABEL: Record<SourceName, string> = {
  semanticscholar: "Semantic Scholar",
  openalex: "OpenAlex",
  pdf: "the PDF (Crossref)",
};

export function sourceLabel(source: SourceName) {
  return SOURCE_LABEL[source];
}

/**
 * Fetch the reference list of a paper. Tries the preferred source first
 * (preference "defaultSource", Semantic Scholar by default) and falls back
 * to the other one when it fails or has no references. Throws a
 * SourceError describing every failure if no source succeeds.
 */
export async function fetchReferences(
  paperId: PaperId,
  onStatus: StatusCallback,
): Promise<ReferenceList> {
  const notes: string[] = [];
  const attempts: Array<[SourceName, () => Promise<Reference[]>]> = [
    ["semanticscholar", () => fetchSemanticScholar(paperId, onStatus)],
    ["openalex", () => fetchOpenAlex(paperId, onStatus)],
  ];
  if (getPref("defaultSource") === "openalex") attempts.reverse();
  for (const [source, run] of attempts) {
    const label = SOURCE_LABEL[source];
    onStatus(`Fetching references from ${label}…`);
    try {
      const references = await run();
      if (references.length) {
        log(
          `${label}: ${references.length} references for ${describe(paperId)}`,
        );
        return {
          paperId,
          source,
          fetchedAt: new Date().toISOString(),
          references,
          notes,
        };
      }
      notes.push(`${label} has no references for this paper.`);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`${label} failed for ${describe(paperId)}`, e);
      notes.push(`${label}: ${message}`);
    }
  }
  throw new SourceError(notes.join("\n"));
}

export function describe(paperId: PaperId | undefined) {
  return paperId ? `${paperId.kind}:${paperId.value}` : "(no identifier)";
}

// ---------------------------------------------------------------------------
// HTTP with retry/backoff
// ---------------------------------------------------------------------------

/**
 * GET a JSON document. Retries on HTTP 429, 5xx and network errors with
 * exponential backoff (honouring Retry-After), reporting each wait through
 * onStatus. Returns null on 404.
 */
export async function getJSON(
  url: string,
  label: string,
  onStatus: StatusCallback,
  headers: Record<string, string> = {},
): Promise<any | null> {
  for (let attempt = 0; ; attempt++) {
    let xhr: XMLHttpRequest | undefined;
    let failure = "network error";
    try {
      xhr = await Zotero.HTTP.request("GET", url, {
        headers: { Accept: "application/json", ...headers },
        responseType: "json",
        // Handle every status ourselves; disable Zotero's own retries, which
        // can silently wait for up to an hour.
        successCodes: false,
        errorDelayMax: 0,
        noRetryOnThrottle: true,
        timeout: 30_000,
        // Refresh must really re-fetch; our own cache handles reuse.
        noCache: true,
        // Not in zotero-types yet, hence the cast.
      } as Parameters<typeof Zotero.HTTP.request>[2]);
    } catch (e) {
      failure = `network error (${e instanceof Error ? e.message : e})`;
    }

    if (xhr) {
      const status = xhr.status;
      if (status >= 200 && status < 300) {
        if (xhr.response === null) {
          throw new SourceError(`${label} returned an invalid JSON response.`);
        }
        return xhr.response;
      }
      if (status === 404) return null;
      if (status === 401 || status === 403) {
        throw new SourceError(
          `${label} rejected the request (HTTP ${status}). If you set a Semantic Scholar API key, check it in Settings > Pinakes.`,
          status,
        );
      }
      if (status !== 429 && status < 500) {
        const detail = errorDetail(xhr.response);
        throw new SourceError(
          `${label} returned HTTP ${status}${detail ? `: ${detail}` : ""}.`,
          status,
        );
      }
      failure = status === 429 ? "rate limited (HTTP 429)" : `HTTP ${status}`;
    }

    if (attempt >= MAX_RETRIES) {
      throw new SourceError(
        `${label}: ${failure}, gave up after ${MAX_RETRIES + 1} attempts.`,
        xhr?.status,
      );
    }
    const delay = retryDelay(xhr, attempt);
    const seconds = Math.ceil(delay / 1000);
    log(`${label}: ${failure}, retrying in ${seconds}s (${url})`);
    onStatus(
      `${label}: ${failure}. Retrying in ${seconds} s (attempt ${attempt + 2} of ${MAX_RETRIES + 1})…`,
    );
    await Zotero.Promise.delay(delay);
  }
}

function retryDelay(xhr: XMLHttpRequest | undefined, attempt: number) {
  const header = xhr?.getResponseHeader("Retry-After");
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
    }
    const date = Date.parse(header);
    if (!Number.isNaN(date)) {
      return Math.min(Math.max(date - Date.now(), 1000), MAX_RETRY_DELAY_MS);
    }
  }
  // 2 s, 4 s, 8 s, 16 s, plus up to 1 s of jitter.
  return Math.min(
    2000 * 2 ** attempt + Math.random() * 1000,
    MAX_RETRY_DELAY_MS,
  );
}

function errorDetail(response: any): string {
  if (!response || typeof response !== "object") return "";
  const detail = response.error || response.message || response.detail;
  return typeof detail === "string" ? detail : "";
}

// ---------------------------------------------------------------------------
// Semantic Scholar
// ---------------------------------------------------------------------------

function s2PaperPath(paperId: PaperId) {
  // DOIs contain "/", which Semantic Scholar expects unescaped.
  const value = encodeURIComponent(paperId.value).replace(/%2F/gi, "/");
  return paperId.kind === "DOI" ? `DOI:${value}` : `ARXIV:${value}`;
}

async function fetchSemanticScholar(
  paperId: PaperId,
  onStatus: StatusCallback,
): Promise<Reference[]> {
  const label = SOURCE_LABEL.semanticscholar;
  const key = (getPref("s2ApiKey") || "").trim();
  const headers: Record<string, string> = key ? { "x-api-key": key } : {};
  const references: Reference[] = [];

  let offset = 0;
  while (offset < MAX_REFERENCES) {
    const url =
      `${S2_BASE}/paper/${s2PaperPath(paperId)}/references` +
      `?fields=${S2_FIELDS}&offset=${offset}&limit=${S2_PAGE_SIZE}`;
    const page = await getJSON(url, label, onStatus, headers);
    if (page === null) {
      throw new SourceError(
        `${label} does not know this paper (HTTP 404).`,
        404,
      );
    }
    for (const entry of page.data ?? []) {
      const ref = fromSemanticScholar(entry?.citedPaper, references.length + 1);
      if (ref) references.push(ref);
    }
    if (typeof page.next !== "number" || page.next <= offset) break;
    offset = page.next;
  }
  return references;
}

function fromSemanticScholar(paper: any, index: number): Reference | null {
  if (!paper || !paper.title) return null;
  const ids = paper.externalIds ?? {};
  const doi = normalizeDOI(ids.DOI);
  const arxiv = parseArxivId(ids.ArXiv) ?? arxivFromDOI(doi);
  const venue: string | undefined = paper.venue || undefined;
  const types: string[] = paper.publicationTypes ?? [];

  let kind: RefKind = "other";
  if (types.includes("Conference")) kind = "conference";
  else if (types.includes("JournalArticle")) kind = "journal";
  if ((venue && /arxiv/i.test(venue)) || (arxiv && !doi)) kind = "preprint";

  return {
    index,
    title: paper.title,
    authors: (paper.authors ?? [])
      .map((a: any) => a?.name)
      .filter((n: unknown): n is string => typeof n === "string" && !!n),
    year: typeof paper.year === "number" ? paper.year : undefined,
    venue,
    doi,
    arxiv,
    abstract: paper.abstract || undefined,
    kind,
  };
}

// ---------------------------------------------------------------------------
// OpenAlex
// ---------------------------------------------------------------------------

function openAlexWorkPath(paperId: PaperId) {
  // arXiv preprints are indexed under their DataCite DOI.
  const doi =
    paperId.kind === "DOI" ? paperId.value : `10.48550/arxiv.${paperId.value}`;
  return `works/doi:${encodeURIComponent(doi).replace(/%2F/gi, "/")}`;
}

async function fetchOpenAlex(
  paperId: PaperId,
  onStatus: StatusCallback,
): Promise<Reference[]> {
  const label = SOURCE_LABEL.openalex;
  const work = await getJSON(
    `${OPENALEX_BASE}/${openAlexWorkPath(paperId)}?select=id,referenced_works`,
    label,
    onStatus,
  );
  if (work === null) {
    throw new SourceError(`${label} does not know this paper (HTTP 404).`, 404);
  }
  const workIds: string[] = (work.referenced_works ?? [])
    .map((url: string) => url.split("/").pop())
    .filter(Boolean)
    .slice(0, MAX_REFERENCES);

  const byId = new Map<string, any>();
  for (let i = 0; i < workIds.length; i += OPENALEX_BATCH) {
    const batch = workIds.slice(i, i + OPENALEX_BATCH);
    onStatus(
      `Fetching reference details from ${label} (${i + batch.length} of ${workIds.length})…`,
    );
    const url =
      `${OPENALEX_BASE}/works?filter=ids.openalex:${batch.join("|")}` +
      `&per-page=${OPENALEX_BATCH}` +
      `&select=id,doi,display_name,publication_year,authorships,primary_location,locations,type,abstract_inverted_index`;
    const page = await getJSON(url, label, onStatus);
    for (const result of page?.results ?? []) {
      byId.set(String(result.id).split("/").pop()!, result);
    }
  }

  const references: Reference[] = [];
  for (const id of workIds) {
    const ref = fromOpenAlex(byId.get(id), references.length + 1);
    if (ref) references.push(ref);
  }
  return references;
}

function fromOpenAlex(work: any, index: number): Reference | null {
  if (!work || !work.display_name) return null;
  const doi = normalizeDOI(work.doi);
  let arxiv = arxivFromDOI(doi);
  for (const loc of work.locations ?? []) {
    arxiv ??= arxivFromURL(loc?.landing_page_url) ?? arxivFromURL(loc?.pdf_url);
  }
  const source = work.primary_location?.source;
  const venue: string | undefined = source?.display_name || undefined;

  let kind: RefKind = "other";
  if (work.type === "preprint" || source?.type === "repository")
    kind = "preprint";
  else if (work.type === "conference-paper" || source?.type === "conference")
    kind = "conference";
  else if (source?.type === "journal") kind = "journal";

  return {
    index,
    title: work.display_name,
    authors: (work.authorships ?? [])
      .map((a: any) => a?.author?.display_name)
      .filter((n: unknown): n is string => typeof n === "string" && !!n),
    year:
      typeof work.publication_year === "number"
        ? work.publication_year
        : undefined,
    venue,
    doi,
    arxiv,
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    kind,
  };
}
