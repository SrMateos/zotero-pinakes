/**
 * The collapsible "Insights" panel above the reference list: a summary
 * (years, venues, how many are in the library), the most cited authors,
 * Semantic Scholar's influence and intent tags, and the in-text citations
 * read locally from the PDF. Clicking an entry filters the list.
 */
import { log } from "../utils/log";
import { button, h } from "./dom";
import {
  hasAuthor,
  inTextCitations,
  intentCounts,
  intentLabel,
  selfCitations,
  topAuthors,
  topVenues,
  venueKey,
  yearSummary,
  type InTextCount,
} from "./insights";
import { readFullText } from "./pdf";
import type { Reference, ReferenceList } from "./types";

/** A filter set from the panel, shown as a removable chip. */
export interface Facet {
  label: string;
  test: (ref: Reference) => boolean;
}

/** What the panel needs from the section. */
export interface InsightsHost {
  readonly doc: Document;
  readonly item: Zotero.Item;
  readonly list: ReferenceList;
  /** Reference index -> ID of the matching library item. */
  readonly matches: Map<number, number>;
  /** In-text counts, once read from the PDF (kept by the section). */
  inText?: InTextResult;
  setFacet(facet: Facet): void;
  /** True once the section shows another list. */
  isStale(): boolean;
}

export type InTextResult =
  | { kind: "counts"; counts: Map<number, InTextCount> }
  | { kind: "unavailable"; reason: string };

/** Open or closed, remembered across items for this session. */
let panelOpen = false;

/** The empty panel, hidden until a list is shown. */
export function createInsightsPanel(doc: Document) {
  const details = h(doc, "details", "pinakes-insights");
  details.append(
    h(doc, "summary", "pinakes-insights-summary", "Insights"),
    h(doc, "div", "pinakes-insights-body"),
  );
  details.hidden = true;
  return details;
}

/** Fill the panel for the host's list, and read the PDF when opened. */
export function renderInsights(
  details: HTMLDetailsElement,
  host: InsightsHost,
) {
  const refs = host.list.references;
  details.hidden = !refs.length;
  details.open = panelOpen;
  details.ontoggle = () => {
    panelOpen = details.open;
    if (details.open) void loadInText(details, host);
  };
  const body = details.querySelector(".pinakes-insights-body")!;
  body.replaceChildren(
    summarySection(host),
    venuesSection(host),
    authorsSection(host),
    tagsSection(host),
    inTextSection(host),
  );
  if (details.open) void loadInText(details, host);
}

function citingNames(item: Zotero.Item) {
  return item
    .getCreators()
    .map((c) => [c.firstName, c.lastName].filter(Boolean).join(" "))
    .filter(Boolean);
}

function block(doc: Document, title: string, ...content: Node[]) {
  const div = h(doc, "div", "pinakes-insights-block");
  div.append(h(doc, "div", "pinakes-insights-title", title), ...content);
  return div;
}

/** A clickable chip "label (count)" that sets a facet. */
function chip(
  host: InsightsHost,
  label: string,
  count: number | undefined,
  facet: Facet,
  extraClass = "",
) {
  const text = count === undefined ? label : `${label} (${count})`;
  const el = button(
    host.doc,
    text,
    () => host.setFacet(facet),
    `pinakes-chip ${extraClass}`.trim(),
  );
  el.title = `Show only: ${facet.label}`;
  return el;
}

function chips(doc: Document, items: HTMLElement[]) {
  const div = h(doc, "div", "pinakes-chips");
  div.append(...items);
  return div;
}

// ---------------------------------------------------------------------------
// Summary: count, years, library, self-citations
// ---------------------------------------------------------------------------

function summarySection(host: InsightsHost) {
  const { doc, list } = host;
  const refs = list.references;
  const parts = [`${refs.length} references`];
  const years = yearSummary(refs);
  if (years) {
    parts.push(
      years.min === years.max
        ? `all from ${years.min}`
        : `${years.min}–${years.max}, median ${years.median}`,
    );
  }
  const inLibrary = refs.filter((r) => host.matches.has(r.index)).length;
  parts.push(`${inLibrary} of ${refs.length} already in your library`);
  const div = block(doc, "Summary", h(doc, "div", "", parts.join(" · ")));

  const selfRefs = selfCitations(
    refs,
    list.citingAuthorIds,
    citingNames(host.item),
  );
  const extra: HTMLElement[] = [];
  if (selfRefs.length) {
    const indexes = new Set(selfRefs.map((r) => r.index));
    extra.push(
      chip(
        host,
        "Self-citations",
        selfRefs.length,
        { label: "Self-citations", test: (r) => indexes.has(r.index) },
        "pinakes-chip-self",
      ),
    );
  }
  if (inLibrary < refs.length) {
    extra.push(
      chip(host, "Not in library", refs.length - inLibrary, {
        label: "Not in library",
        test: (r) => !host.matches.has(r.index),
      }),
    );
  }
  if (extra.length) div.append(chips(doc, extra));
  if (years && years.histogram.length > 1) div.append(histogram(host, years));
  return div;
}

/** One bar per year; clicking a bar filters to that year. */
function histogram(
  host: InsightsHost,
  years: NonNullable<ReturnType<typeof yearSummary>>,
) {
  const { doc } = host;
  const max = Math.max(...years.histogram.map(([, n]) => n));
  const div = h(doc, "div", "pinakes-histogram");
  for (const [year, count] of years.histogram) {
    const bar = h(doc, "div", "pinakes-bar");
    const fill = h(doc, "div", "pinakes-bar-fill");
    fill.style.height = `${Math.max((count / max) * 100, count ? 6 : 0)}%`;
    bar.append(fill);
    bar.title = `${year}: ${count} ${count === 1 ? "reference" : "references"}`;
    if (count) {
      bar.addEventListener("click", () =>
        host.setFacet({ label: `Year ${year}`, test: (r) => r.year === year }),
      );
    }
    div.append(bar);
  }
  const axis = h(doc, "div", "pinakes-histogram-axis");
  axis.append(
    h(doc, "span", "", String(years.min)),
    h(doc, "span", "", String(years.max)),
  );
  const wrap = h(doc, "div");
  wrap.append(div, axis);
  return wrap;
}

// ---------------------------------------------------------------------------
// Venues and authors
// ---------------------------------------------------------------------------

function venuesSection(host: InsightsHost) {
  const venues = topVenues(host.list.references);
  if (!venues.length) return h(host.doc, "div");
  return block(
    host.doc,
    "Top venues",
    chips(
      host.doc,
      venues.map((v) =>
        chip(host, v.name, v.count, {
          label: `Venue: ${v.name}`,
          test: (r) => !!r.venue && venueKey(r.venue) === v.key,
        }),
      ),
    ),
  );
}

function authorsSection(host: InsightsHost) {
  const { doc, list } = host;
  const authors = topAuthors(
    list.references,
    list.citingAuthorIds,
    citingNames(host.item),
  );
  const content = authors.length
    ? chips(
        doc,
        authors.map((a) =>
          chip(
            host,
            a.self ? `${a.name} (self)` : a.name,
            a.count,
            { label: `Author: ${a.name}`, test: (r) => hasAuthor(r, a.key) },
            a.self ? "pinakes-chip-self" : "",
          ),
        ),
      )
    : h(
        doc,
        "div",
        "pinakes-insights-note",
        "No author is cited more than once.",
      );
  const div = block(doc, "Most cited authors", content);
  div.classList.add("pinakes-authors");
  if (authors.length) {
    const how = list.references.some((r) => r.authorIds?.some(Boolean))
      ? "Authors are told apart by their ID in the source, so namesakes are not merged."
      : "Authors are matched by surname and first initial (the source gives no author IDs).";
    div.title = `${how} "self": also an author of this paper.`;
  }
  return div;
}

// ---------------------------------------------------------------------------
// Semantic Scholar tags
// ---------------------------------------------------------------------------

function tagsSection(host: InsightsHost) {
  const refs = host.list.references;
  const items: HTMLElement[] = [];
  const influential = refs.filter((r) => r.influential).length;
  if (influential) {
    items.push(
      chip(host, "Influential", influential, {
        label: "Influential",
        test: (r) => !!r.influential,
      }),
    );
  }
  for (const [intent, count] of intentCounts(refs)) {
    const label = intentLabel(intent);
    items.push(
      chip(host, label, count, {
        label: `Cited for: ${label}`,
        test: (r) => !!r.intents?.includes(intent),
      }),
    );
  }
  if (!items.length) return h(host.doc, "div");
  const div = block(host.doc, "Semantic Scholar tags", chips(host.doc, items));
  div.title =
    "Semantic Scholar's classification of how this paper cites each reference: influentially, and as background, for its method or to compare results.";
  return div;
}

// ---------------------------------------------------------------------------
// In-text citations (local only)
// ---------------------------------------------------------------------------

const IN_TEXT_SHOWN = 10;

function inTextSection(host: InsightsHost) {
  const div = block(host.doc, "In-text citations");
  div.classList.add("pinakes-intext");
  fillInText(div, host);
  return div;
}

function fillInText(div: HTMLElement, host: InsightsHost) {
  const { doc, list } = host;
  const content = h(doc, "div", "pinakes-intext-content");
  const result = host.inText;
  if (!result) {
    content.textContent = "Reading the PDF…";
  } else if (result.kind === "unavailable") {
    content.textContent = result.reason;
  } else {
    const byLabel = new Map<string, Reference>();
    for (const ref of list.references) {
      if (ref.label) byLabel.set(ref.label, ref);
    }
    const ranked = [...result.counts.entries()].sort(
      (a, b) => b[1].count - a[1].count || a[0] - b[0],
    );
    const total = ranked.reduce((n, [, c]) => n + c.count, 0);
    const uncited = [...byLabel.keys()].filter(
      (label) => !result.counts.has(Number(label)),
    );
    content.append(
      h(
        doc,
        "div",
        "",
        `${total} citation markers for ${ranked.length} references` +
          (uncited.length
            ? `; never cited in the text: ${uncited.map((l) => `[${l}]`).join(", ")}`
            : ""),
      ),
    );
    const ol = h(doc, "ol", "pinakes-intext-list");
    for (const [n, count] of ranked.slice(0, IN_TEXT_SHOWN)) {
      const ref = byLabel.get(String(n));
      const li = h(doc, "li", "pinakes-intext-row");
      li.append(
        h(doc, "span", "pinakes-num", `[${n}]`),
        h(doc, "span", "pinakes-intext-count", `${count.count}×`),
        h(
          doc,
          "span",
          "pinakes-intext-text",
          [ref?.unresolved ? ref.raw : ref?.title, count.sections.join(", ")]
            .filter(Boolean)
            .join(" · "),
        ),
      );
      li.title = `Cited ${count.count} ${count.count === 1 ? "time" : "times"} in: ${count.sections.join(", ")}`;
      if (ref) {
        li.classList.add("pinakes-clickable");
        li.addEventListener("click", () =>
          host.setFacet({
            label: `Reference [${n}]`,
            test: (r) => r.label === String(n),
          }),
        );
      }
      ol.append(li);
    }
    content.append(ol);
    if (!byLabel.size) {
      content.append(
        h(
          doc,
          "div",
          "pinakes-insights-note",
          "The list is not in the paper's order, so numbers are not linked to references.",
        ),
      );
    }
  }
  div.querySelector(".pinakes-intext-content")?.remove();
  div.append(content);
}

/** Count the in-text citations once per list, when the panel is open. */
async function loadInText(details: HTMLDetailsElement, host: InsightsHost) {
  if (host.inText) return;
  let result: InTextResult;
  try {
    const { text } = await readFullText(host.item);
    const counts = inTextCitations(text);
    result = counts.size
      ? { kind: "counts", counts }
      : {
          kind: "unavailable",
          reason:
            "No numeric citation markers such as [12] found in the PDF (author-year papers are not supported).",
        };
  } catch (e) {
    log("Insights: could not read the PDF", e);
    result = {
      kind: "unavailable",
      reason: `Not available: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (host.isStale()) return;
  host.inText = result;
  const div = details.querySelector<HTMLElement>(".pinakes-intext");
  if (div) fillInText(div, host);
}
