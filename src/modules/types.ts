/** Where a reference list came from. */
export type SourceName = "semanticscholar" | "openalex" | "pdf";

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
  /** PDF fallback: the entry text as printed in the bibliography. */
  raw?: string;
  /** PDF fallback: the label printed in the paper ("23" for "[23]"). */
  label?: string;
  /** PDF fallback: Crossref found no match; only `raw` is meaningful. */
  unresolved?: boolean;
}

/** A fetched reference list, as stored in the cache. */
export interface ReferenceList {
  /** Undefined for lists extracted from the PDF of an item without ID. */
  paperId?: PaperId;
  source: SourceName;
  /**
   * "paper": in the order of the paper's bibliography, with its numbering
   * (labels); "source": in the order the API returned.
   */
  order?: "paper" | "source";
  fetchedAt: string;
  references: Reference[];
  /** Non-fatal problems, e.g. "Semantic Scholar: rate limited, used OpenAlex". */
  notes: string[];
}
