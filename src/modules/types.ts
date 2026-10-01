/** Where a reference list came from. */
export type SourceName = "semanticscholar" | "openalex";

/** Identifier of the citing paper, used to query the APIs. */
export type PaperId =
  { kind: "DOI"; value: string } | { kind: "arXiv"; value: string };

/** Coarse item type, used when an item has to be created from metadata. */
export type RefKind = "journal" | "conference" | "preprint" | "other";

/** One cited work, normalised across sources. */
export interface Reference {
  /** 1-based position in the list as returned by the source. */
  index: number;
  title: string;
  authors: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxiv?: string;
  abstract?: string;
  kind: RefKind;
}

/** A fetched reference list, as stored in the cache. */
export interface ReferenceList {
  paperId: PaperId;
  source: SourceName;
  fetchedAt: string;
  references: Reference[];
  /** Non-fatal problems, e.g. "Semantic Scholar: rate limited, used OpenAlex". */
  notes: string[];
}
