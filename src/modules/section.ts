/**
 * The "Pinakes" item pane section: shows the reference list of the
 * selected item (or of the parent of the PDF open in the reader).
 */
import { config } from "../../package.json";
import { log } from "../utils/log";
import { getPref } from "../utils/prefs";
import { getCached, setCached } from "./cache";
import { normalizeForSearch } from "./identifiers";
import {
  checkTargetEditable,
  importReference,
  resolveTarget,
  sameTarget,
  type ImportTarget,
  type TargetMode,
} from "./importer";
import { findInLibrary, getPaperId } from "./library";
import { applyPaperOrder, referencesFromPdf } from "./pdf";
import { describe, fetchReferences, sourceLabel } from "./sources";
import type { PaperId, Reference, ReferenceList } from "./types";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICON = `chrome://${config.addonRef}/content/icons/pinakes.svg`;

/**
 * In the library view, wait this long before fetching an uncached list, so
 * that scrolling through items with the arrow keys does not fire a request
 * per item. The reader fetches immediately.
 */
const LIBRARY_FETCH_DELAY_MS = 600;

/** Per-section state, keyed by the section body element. */
interface SectionState {
  body: HTMLElement;
  doc: Document;
  item?: Zotero.Item;
  tabType?: string;
  paperId?: PaperId;
  list?: ReferenceList;
  loading: boolean;
  /** Set once loading has started for `item`. */
  started: boolean;
  /** Reference index -> Zotero item ID of the matching library item. */
  matches: Map<number, number>;
  target?: ImportTarget;
  /** Incremented on every load; stale async work checks it and bails out. */
  token: number;
  setSummary?: (summary: string) => void;
  /** Row elements by reference index. */
  rows: Map<number, HTMLElement>;
  /** Checked reference indexes. */
  selected: Set<number>;
  lastClicked?: number;
  filter: string[];
  batch?: { cancelled: boolean };
  /** Number of imports in progress, and when the last one ended. */
  importing: number;
  lastImportEnd: number;
}

const states = new Map<HTMLElement, SectionState>();
let paneID: string | false = false;

function newState(body: HTMLElement, doc: Document): SectionState {
  return {
    body,
    doc,
    loading: false,
    started: false,
    matches: new Map(),
    token: 0,
    rows: new Map(),
    selected: new Set(),
    filter: [],
    importing: 0,
    lastImportEnd: 0,
  };
}

/**
 * Zotero selects a newly saved item when it appears in the items list being
 * viewed (as "Add Item by Identifier" does), and Translate.Search offers no
 * way to prevent it. An item added in the last minute while an import is
 * running is taken to be one of ours.
 */
function isJustImported(item: Zotero.Item) {
  const added = Zotero.Date.sqlToDate(item.dateAdded, true) as Date | false;
  return !!added && Date.now() - added.getTime() < 60_000;
}

/**
 * After an import in the library view, select the citing item again so the
 * item pane goes back to its reference list.
 */
function restoreSelection(state: SectionState) {
  if (state.tabType !== "library" || !state.item) return;
  if (state.importing || state.batch) return;
  const pane = Zotero.getMainWindow()?.ZoteroPane;
  const selected = pane?.getSelectedItems() ?? [];
  if (
    selected.length === 1 &&
    selected[0].id !== state.item.id &&
    isJustImported(selected[0])
  ) {
    void pane!.selectItem(state.item.id);
  }
}

export function registerSection() {
  paneID = Zotero.ItemPaneManager.registerSection({
    paneID: "references",
    pluginID: config.addonID,
    header: { l10nID: `${config.addonRef}-section-header`, icon: ICON },
    sidenav: { l10nID: `${config.addonRef}-section-sidenav`, icon: ICON },
    onInit: ({ body, doc }) => {
      states.set(body, newState(body, doc));
    },
    onDestroy: ({ body }) => {
      const state = states.get(body);
      if (state?.batch) state.batch.cancelled = true;
      states.delete(body);
    },
    onItemChange: ({ item, setEnabled }) => {
      setEnabled(!!citingItem(item));
      return true;
    },
    // Everything happens in onRender (not onAsyncRender, which Zotero only
    // calls once the section is scrolled into view), so the list is ready
    // by the time the section is opened from the side navigation.
    onRender: ({ body, item, tabType, setSectionSummary }) => {
      const state = states.get(body);
      if (!state) return;
      state.setSummary = setSectionSummary;
      state.tabType = tabType;
      const citing = citingItem(item);
      // Zotero moved the selection to an item we are importing: keep the
      // list (restoreSelection() selects the citing item again afterwards).
      const importing =
        state.importing ||
        state.batch ||
        Date.now() - state.lastImportEnd < 3000;
      if (importing && citing && isJustImported(citing)) {
        setTimeout(() => restoreSelection(state), 0);
        return;
      }
      // Re-rendering the same item (e.g. after an edit, or after
      // setSectionSummary) keeps what is shown; only Refresh reloads it.
      // Reloading here would loop: load -> setSummary -> render -> load.
      if (state.started && state.item?.id === citing?.id) return;
      // A running batch import keeps going in the background (it holds its
      // own list and target) and reports through a progress window.
      Object.assign(state, newState(body, state.doc), {
        item: citing,
        tabType,
        setSummary: setSectionSummary,
        started: true,
      });
      renderSkeleton(state);
      void load(state, false);
    },
  });
  log(`Registered item pane section: ${paneID}`);
}

export function unregisterSection() {
  for (const state of states.values()) {
    if (state.batch) state.batch.cancelled = true;
  }
  if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
  paneID = false;
  states.clear();
}

/** Re-check "in library" marks in every open section (after item changes). */
export async function refreshLibraryMarks() {
  for (const state of states.values()) {
    if (state.list && !state.batch) await markInLibrary(state, state.token);
  }
}

/** The regular item whose references we show, if any. */
function citingItem(item: Zotero.Item | undefined | null) {
  if (!item) return undefined;
  if (item.isAttachment() && item.parentItem) return item.parentItem;
  return item.isRegularItem() ? item : undefined;
}

/** Can this reference be imported (resolved, and not in the library)? */
function importable(state: SectionState, ref: Reference) {
  return !ref.unresolved && !state.matches.has(ref.index);
}

function currentTarget(state: SectionState) {
  return resolveTarget(state.item!, getPref("targetMode") as TargetMode);
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load and show the list. `allowPdf` enables the PDF fallback; it is
 * automatic in the reader, and on request (a button) in the library view.
 */
async function load(
  state: SectionState,
  force: boolean,
  allowPdf = state.tabType === "reader",
) {
  const token = ++state.token;
  const item = state.item;
  if (!item) return;
  state.loading = true;
  try {
    const list = await loadList(state, item, force, token, allowPdf);
    if (!list || state.token !== token) return;
    state.list = list;
    renderList(state);
    await markInLibrary(state, token);
  } finally {
    if (state.token === token) state.loading = false;
  }
}

async function loadList(
  state: SectionState,
  item: Zotero.Item,
  force: boolean,
  token: number,
  allowPdf: boolean,
): Promise<ReferenceList | undefined> {
  const paperId = getPaperId(item);
  state.paperId = paperId;

  const cached = force ? undefined : await getCached(item, paperId);
  if (cached) {
    log(`Using cached references for ${describe(paperId)}`);
    return cached;
  }

  const pdfEnabled = getPref("pdfFallback") !== false;
  if (!paperId && !(pdfEnabled && allowPdf)) {
    setStatus(state, "info", NO_IDENTIFIER);
    if (pdfEnabled) offerPdf(state);
    state.setSummary?.("No identifier");
    return undefined;
  }

  if (state.tabType !== "reader") {
    await Zotero.Promise.delay(LIBRARY_FETCH_DELAY_MS);
    if (state.token !== token) return undefined;
  }
  const onStatus = (message: string) => {
    if (state.token === token) setStatus(state, "busy", message);
  };

  const notes: string[] = [];
  if (paperId) {
    onStatus(`Fetching references for ${describe(paperId)}…`);
    try {
      const fetched = await fetchReferences(paperId, onStatus);
      if (state.token !== token) return undefined;
      onStatus("Ordering as in the paper's bibliography…");
      const list = await applyPaperOrder(item, fetched);
      await setCached(item, list);
      return list;
    } catch (e) {
      if (state.token !== token) return undefined;
      const message = e instanceof Error ? e.message : String(e);
      if (!(pdfEnabled && allowPdf)) {
        setStatus(
          state,
          "error",
          `Could not load references for ${describe(paperId)}.\n${message}`,
        );
        if (pdfEnabled) offerPdf(state);
        state.setSummary?.("Error");
        return undefined;
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
      onStatus,
      () => state.token !== token,
    );
    await setCached(item, list);
    return list;
  } catch (e) {
    if (state.token !== token) return undefined;
    const message = e instanceof Error ? e.message : String(e);
    setStatus(
      state,
      "error",
      `${notes.join("\n")}\nReading the PDF bibliography failed: ${message}`,
    );
    state.setSummary?.(paperId ? "Error" : "No identifier");
    return undefined;
  }
}

const NO_IDENTIFIER =
  "No identifier: this item has no DOI and no arXiv ID (checked the DOI, URL, Extra and Archive ID fields). Add one to see its references.";

/**
 * In the library view the PDF fallback is not automatic (it reads the PDF
 * and sends one Crossref request per entry); offer it as a button.
 */
function offerPdf(state: SectionState) {
  const status = query(state, ".pinakes-status");
  if (!status || !state.item) return;
  status.append(
    state.doc.createElementNS(HTML_NS, "br"),
    button(state.doc, "Read the bibliography from the PDF", () => {
      setStatus(state, "busy", "Reading the bibliography from the PDF…");
      void load(state, true, true);
    }),
  );
}

/** Update the import target and the "In library" marks. */
async function markInLibrary(state: SectionState, token: number) {
  if (!state.item || !state.list) return;
  const target = currentTarget(state);
  state.target = target;
  renderTarget(state);
  try {
    const matches = await findInLibrary(
      target.libraryID,
      state.list.references,
    );
    if (state.token !== token) return;
    state.matches = matches;
    for (const index of matches.keys()) state.selected.delete(index);
    for (const ref of state.list.references) updateRow(state, ref);
    updateBatchBar(state);
  } catch (e) {
    log("Could not check which references are in the library", e);
  }
}

// ---------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------

function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const el = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function button(doc: Document, label: string, onClick: (e: Event) => void) {
  const el = h(doc, "button", "pinakes-button", label);
  el.addEventListener("click", (e) => {
    e.stopPropagation();
    onClick(e);
  });
  return el;
}

function query<T extends Element = HTMLElement>(
  state: SectionState,
  sel: string,
) {
  return state.body.querySelector(sel) as T | null;
}

function setStatus(
  state: SectionState,
  kind: "busy" | "info" | "error" | "none",
  message = "",
) {
  const status = query(state, ".pinakes-status");
  if (!status) return;
  status.className = `pinakes-status pinakes-status-${kind}`;
  status.textContent = message;
  status.hidden = kind === "none";
}

// ---------------------------------------------------------------------------
// Skeleton: toolbar, filter, batch bar, progress, status, list
// ---------------------------------------------------------------------------

function renderSkeleton(state: SectionState) {
  const { doc, body } = state;
  body.replaceChildren();
  const root = h(doc, "div", "pinakes-root");

  const toolbar = h(doc, "div", "pinakes-toolbar");
  toolbar.append(
    h(doc, "span", "pinakes-target"),
    h(doc, "span", "pinakes-source"),
    button(doc, "Refresh", () => {
      if (state.batch) return;
      const { item, tabType, setSummary } = state;
      Object.assign(state, newState(state.body, state.doc), {
        item,
        tabType,
        setSummary,
        started: true,
      });
      renderSkeleton(state);
      void load(state, true);
    }),
  );

  const filterBar = h(doc, "div", "pinakes-filterbar");
  const filter = h(doc, "input", "pinakes-filter");
  filter.type = "search";
  filter.placeholder = "Filter by title, author, venue, year…";
  filter.addEventListener("input", () => {
    state.filter = normalizeForSearch(filter.value)
      .split(/\s+/)
      .filter(Boolean);
    applyFilter(state);
  });
  filterBar.append(filter, h(doc, "span", "pinakes-count"));
  filterBar.hidden = true;

  const batchBar = h(doc, "div", "pinakes-batchbar");
  const selectAll = h(doc, "input", "pinakes-select-all");
  selectAll.type = "checkbox";
  selectAll.title = "Select all shown references that are not in the library";
  selectAll.addEventListener("change", () => {
    for (const ref of shownRefs(state)) {
      if (!importable(state, ref)) continue;
      if (selectAll.checked) state.selected.add(ref.index);
      else state.selected.delete(ref.index);
      updateRow(state, ref);
    }
    updateBatchBar(state);
  });
  const importSelected = button(doc, "Import selected", () => {
    const refs = shownRefs(state).filter(
      (r) => state.selected.has(r.index) && importable(state, r),
    );
    void runBatch(state, refs);
  });
  importSelected.classList.add("pinakes-import-selected");
  const importAll = button(doc, "Import all not in library", () => {
    const refs = shownRefs(state).filter((r) => importable(state, r));
    void runBatch(state, refs);
  });
  importAll.classList.add("pinakes-import-all");
  batchBar.append(selectAll, importSelected, importAll);
  batchBar.hidden = true;

  const progress = h(doc, "div", "pinakes-progress");
  progress.append(
    h(doc, "progress", "pinakes-progress-bar"),
    h(doc, "span", "pinakes-progress-text"),
    button(doc, "Cancel", () => {
      if (state.batch) state.batch.cancelled = true;
    }),
  );
  progress.hidden = true;

  root.append(
    toolbar,
    filterBar,
    batchBar,
    progress,
    h(doc, "div", "pinakes-status"),
    h(doc, "ol", "pinakes-list"),
  );

  // The selected collection can change while the reader is open; re-check
  // the target when the pointer enters the section.
  root.addEventListener("mouseenter", () => {
    if (!state.item || !state.list || state.batch) return;
    if (!sameTarget(currentTarget(state), state.target)) {
      void markInLibrary(state, state.token);
    }
  });

  body.append(root);
  setStatus(state, "busy", "Loading…");
}

function renderTarget(state: SectionState) {
  const el = query(state, ".pinakes-target");
  if (!el || !state.target) return;
  el.textContent = `Import to: ${state.target.label}`;
  const mode = getPref("targetMode") as TargetMode;
  el.title =
    mode === "parent"
      ? "The first collection containing this item (or its library root). Change in Settings > Pinakes."
      : mode === "root"
        ? "The library of this item. Change in Settings > Pinakes."
        : "The collection selected in the main window, or the library of this item if no collection is selected. Change in Settings > Pinakes.";
}

function renderList(state: SectionState) {
  const list = state.list!;
  const ol = query(state, ".pinakes-list");
  if (!ol) return;
  state.rows.clear();
  ol.replaceChildren(
    ...list.references.map((ref) => {
      const row = renderRow(state, ref);
      state.rows.set(ref.index, row);
      return row;
    }),
  );

  const source = query(state, ".pinakes-source");
  if (source) {
    source.textContent =
      `${list.references.length} from ${sourceLabel(list.source)}` +
      (list.order === "paper" && list.source !== "pdf" ? ", paper order" : "");
    source.title = `Fetched ${new Date(list.fetchedAt).toLocaleString()}`;
  }
  const hasRefs = list.references.length > 0;
  query(state, ".pinakes-filterbar")!.hidden = !hasRefs;
  query(state, ".pinakes-batchbar")!.hidden = !hasRefs;
  // Fallback notes (e.g. Semantic Scholar was rate limited) stay visible.
  if (list.notes.length) setStatus(state, "info", list.notes.join("\n"));
  else setStatus(state, "none");
  state.setSummary?.(`${list.references.length} references`);
  applyFilter(state);
}

// ---------------------------------------------------------------------------
// Filter
// ---------------------------------------------------------------------------

const searchText = new WeakMap<Reference, string>();

function haystack(ref: Reference) {
  let text = searchText.get(ref);
  if (text === undefined) {
    text = normalizeForSearch(
      [
        ref.title,
        ref.authors.join(" "),
        ref.venue,
        ref.year,
        ref.doi,
        ref.arxiv,
        ref.raw,
      ]
        .filter(Boolean)
        .join(" "),
    );
    searchText.set(ref, text);
  }
  return text;
}

function isShown(state: SectionState, ref: Reference) {
  if (!state.filter.length) return true;
  const text = haystack(ref);
  return state.filter.every((token) => text.includes(token));
}

function shownRefs(state: SectionState) {
  return (state.list?.references ?? []).filter((r) => isShown(state, r));
}

function applyFilter(state: SectionState) {
  if (!state.list) return;
  let shown = 0;
  for (const ref of state.list.references) {
    const visible = isShown(state, ref);
    const row = state.rows.get(ref.index);
    if (row) row.hidden = !visible;
    if (visible) shown++;
  }
  const count = query(state, ".pinakes-count");
  if (count) {
    count.textContent = state.filter.length
      ? `${shown} of ${state.list.references.length}`
      : "";
  }
  updateBatchBar(state);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function authorYear(ref: Reference) {
  const first = ref.authors[0];
  const surname = first ? first.trim().split(/\s+/).pop() : undefined;
  const who = surname
    ? ref.authors.length > 1
      ? `${surname} et al.`
      : surname
    : "Unknown author";
  return ref.year ? `${who}, ${ref.year}` : who;
}

function renderRow(state: SectionState, ref: Reference) {
  const { doc } = state;
  const li = h(doc, "li", "pinakes-row");
  li.dataset.index = String(ref.index);
  if (ref.unresolved) li.classList.add("pinakes-unresolved");

  const check = h(doc, "input", "pinakes-check");
  check.type = "checkbox";
  check.addEventListener("click", (e) => onCheck(state, ref, e as MouseEvent));

  const main = h(doc, "div", "pinakes-row-main");
  main.title = ref.unresolved
    ? "Crossref found no match for this entry from the PDF."
    : ref.abstract
      ? ref.abstract.length > 600
        ? `${ref.abstract.slice(0, 600)}…`
        : ref.abstract
      : "No abstract available. Click to expand.";
  const text = h(doc, "div", "pinakes-text");
  if (ref.unresolved) {
    text.append(
      h(doc, "div", "pinakes-raw", ref.raw ?? ref.title),
      h(doc, "div", "pinakes-meta", "From the PDF, not found in Crossref"),
    );
  } else {
    text.append(h(doc, "div", "pinakes-title", ref.title));
    const meta = [authorYear(ref), ref.venue].filter(Boolean).join(" · ");
    text.append(h(doc, "div", "pinakes-meta", meta));
  }
  // Lists read from the PDF keep the paper's own numbering.
  const number = ref.label ?? String(ref.index);
  main.append(check, h(doc, "span", "pinakes-num", number), text);
  main.addEventListener("click", () => li.classList.toggle("pinakes-expanded"));

  const abstract = h(
    doc,
    "div",
    "pinakes-abstract",
    ref.unresolved
      ? ""
      : (ref.abstract ?? "No abstract available.") +
          (ref.raw ? `\n\nAs printed in the PDF: ${ref.raw}` : ""),
  );
  const actions = h(doc, "div", "pinakes-actions");
  li.append(main, abstract, actions);
  fillActions(state, ref, actions);
  updateCheck(state, ref, check);
  return li;
}

function updateCheck(
  state: SectionState,
  ref: Reference,
  check: HTMLInputElement,
) {
  const can = importable(state, ref);
  check.disabled = !can || !!state.batch;
  check.checked = can && state.selected.has(ref.index);
  check.style.visibility = can ? "" : "hidden";
}

function onCheck(state: SectionState, ref: Reference, event: MouseEvent) {
  event.stopPropagation();
  const checked = (event.target as HTMLInputElement).checked;
  const indexes = [ref.index];
  // Shift-click selects the range of shown rows since the last click.
  if (event.shiftKey && state.lastClicked !== undefined) {
    const shown = shownRefs(state).map((r) => r.index);
    const a = shown.indexOf(state.lastClicked);
    const b = shown.indexOf(ref.index);
    if (a >= 0 && b >= 0) {
      indexes.push(...shown.slice(Math.min(a, b), Math.max(a, b) + 1));
    }
  }
  state.lastClicked = ref.index;
  const byIndex = new Map(state.list!.references.map((r) => [r.index, r]));
  for (const index of indexes) {
    if (!importable(state, byIndex.get(index)!)) continue;
    if (checked) state.selected.add(index);
    else state.selected.delete(index);
  }
  for (const r of state.list!.references) {
    if (indexes.includes(r.index)) updateRow(state, r);
  }
  updateBatchBar(state);
}

function updateRow(state: SectionState, ref: Reference) {
  const row = state.rows.get(ref.index);
  if (!row) return;
  const actions = row.querySelector(".pinakes-actions") as HTMLElement | null;
  if (actions && !actions.dataset.busy) fillActions(state, ref, actions);
  const check = row.querySelector(".pinakes-check") as HTMLInputElement | null;
  if (check) updateCheck(state, ref, check);
}

function fillActions(
  state: SectionState,
  ref: Reference,
  actions: HTMLElement,
) {
  const { doc } = state;
  actions.replaceChildren();
  if (ref.unresolved) {
    const copy = button(doc, "Copy", () => {
      Zotero.Utilities.Internal.copyTextToClipboard(ref.raw ?? ref.title);
      copy.textContent = "Copied";
      setTimeout(() => (copy.textContent = "Copy"), 1500);
    });
    copy.title = "Copy the entry text, e.g. to search for it.";
    actions.append(copy);
    return;
  }
  const itemID = state.matches.get(ref.index);

  if (itemID) {
    const inLib = button(doc, "In library", () => {
      Zotero.getMainWindow()?.ZoteroPane?.selectItem(itemID);
    });
    inLib.classList.add("pinakes-in-library");
    inLib.title = "Already in the target library. Click to show it.";
    actions.append(inLib);
  } else {
    const importBtn = button(doc, "Import", () => {
      void importOne(state, ref, currentTarget(state));
    });
    importBtn.classList.add("pinakes-import");
    importBtn.disabled = !!state.batch;
    importBtn.title = ref.doi
      ? `Import by DOI ${ref.doi}`
      : ref.arxiv
        ? `Import by arXiv ID ${ref.arxiv}`
        : "No DOI or arXiv ID: the item will be created from the API metadata.";
    actions.append(importBtn);
  }

  const copy = button(doc, "Copy DOI", () => {
    Zotero.Utilities.Internal.copyTextToClipboard(ref.doi!);
    copy.textContent = "Copied";
    setTimeout(() => (copy.textContent = "Copy DOI"), 1500);
  });
  copy.disabled = !ref.doi;
  if (!ref.doi) copy.title = "This reference has no DOI.";

  const url = ref.doi
    ? `https://doi.org/${ref.doi}`
    : ref.arxiv
      ? `https://arxiv.org/abs/${ref.arxiv}`
      : undefined;
  const open = button(doc, "Open", () => url && Zotero.launchURL(url));
  open.disabled = !url;
  open.title = url ?? "This reference has no DOI or arXiv ID.";

  actions.append(copy, open);
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/**
 * Import one reference and update its row. Returns the import method, or
 * undefined if it failed (the error is shown in the row).
 */
async function importOne(
  state: SectionState,
  ref: Reference,
  target: ImportTarget,
  list = state.list,
) {
  if (!list) return undefined;
  // The section may switch to another item while a batch is running; the
  // import still happens, but only the list it belongs to is updated.
  const live = () => state.list === list;
  const targetChanged = !sameTarget(target, state.target);
  if (live()) {
    state.target = target;
    renderTarget(state);
  }

  const actions = (live() &&
    state.rows
      .get(ref.index)
      ?.querySelector(".pinakes-actions")) as HTMLElement | null;
  if (actions) actions.dataset.busy = "1";
  const importBtn = actions?.querySelector(
    ".pinakes-import",
  ) as HTMLButtonElement | null;
  if (importBtn) {
    importBtn.disabled = true;
    importBtn.textContent = "Importing…";
  }

  let result: Awaited<ReturnType<typeof importReference>> | undefined;
  let error: string | undefined;
  state.importing++;
  try {
    checkTargetEditable(target);
    result = await importReference(ref, target);
    log(
      `Imported reference ${ref.index} via ${result.method} as item ${result.item.id} (library ${result.item.libraryID})`,
    );
    if (live()) {
      state.matches.set(ref.index, result.item.id);
      state.selected.delete(ref.index);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    log(`Import of reference ${ref.index} failed`, e);
  } finally {
    state.importing--;
    state.lastImportEnd = Date.now();
  }
  if (!state.batch) restoreSelection(state);
  if (!actions || !live()) return result?.method;
  delete actions.dataset.busy;
  updateRow(state, ref);
  if (result?.method === "metadata") {
    actions.append(
      h(state.doc, "span", "pinakes-row-note", "Created from API metadata"),
    );
  }
  if (error) {
    actions.append(
      h(state.doc, "span", "pinakes-row-error", `Import failed: ${error}`),
    );
  }
  updateBatchBar(state);
  if (targetChanged && !state.batch) void markInLibrary(state, state.token);
  return result?.method;
}

function updateBatchBar(state: SectionState) {
  const shown = shownRefs(state);
  const notInLibrary = shown.filter((r) => importable(state, r));
  const selected = notInLibrary.filter((r) => state.selected.has(r.index));
  const busy = !!state.batch;

  const importSelected = query<HTMLButtonElement>(
    state,
    ".pinakes-import-selected",
  );
  if (importSelected) {
    importSelected.textContent = `Import selected (${selected.length})`;
    importSelected.disabled = busy || !selected.length;
  }
  const importAll = query<HTMLButtonElement>(state, ".pinakes-import-all");
  if (importAll) {
    importAll.textContent = state.filter.length
      ? `Import all shown not in library (${notInLibrary.length})`
      : `Import all not in library (${notInLibrary.length})`;
    importAll.disabled = busy || !notInLibrary.length;
  }
  const selectAll = query<HTMLInputElement>(state, ".pinakes-select-all");
  if (selectAll) {
    selectAll.disabled = busy || !notInLibrary.length;
    selectAll.checked =
      notInLibrary.length > 0 && selected.length === notInLibrary.length;
    selectAll.indeterminate =
      selected.length > 0 && selected.length < notInLibrary.length;
  }
}

function setProgress(state: SectionState, done: number, total: number) {
  const progress = query(state, ".pinakes-progress");
  if (!progress) return;
  progress.hidden = false;
  const bar = progress.querySelector("progress") as HTMLProgressElement;
  bar.max = total;
  bar.value = done;
  progress.querySelector(".pinakes-progress-text")!.textContent =
    `Importing ${Math.min(done + 1, total)} of ${total}…`;
}

/** Import references one after another, with progress and cancel. */
async function runBatch(state: SectionState, refs: Reference[]) {
  if (state.batch || !state.item || !refs.length) return;
  const target = currentTarget(state);
  try {
    checkTargetEditable(target);
  } catch (e) {
    setStatus(state, "error", e instanceof Error ? e.message : String(e));
    return;
  }
  const batch = { cancelled: false };
  const list = state.list!;
  const live = () => state.list === list;
  state.batch = batch;
  for (const ref of state.list!.references) updateRow(state, ref);
  updateBatchBar(state);
  log(`Batch import of ${refs.length} references into ${target.label}`);

  let imported = 0;
  let fromMetadata = 0;
  let failed = 0;
  let done = 0;
  for (const ref of refs) {
    if (batch.cancelled) break;
    if (live()) setProgress(state, done, refs.length);
    if (!live() || !state.matches.has(ref.index)) {
      const method = await importOne(state, ref, target, list);
      if (!method) failed++;
      else {
        imported++;
        if (method === "metadata") fromMetadata++;
      }
    }
    done++;
  }

  const parts = [`Imported ${imported} of ${refs.length} into ${target.label}`];
  if (fromMetadata) parts.push(`${fromMetadata} created from metadata`);
  if (failed) parts.push(`${failed} failed`);
  if (batch.cancelled) parts.push(`cancelled after ${done}`);
  const summary = `${parts.join("; ")}.`;
  log(summary);

  if (!live()) {
    // The section now shows another item: report in a progress window.
    const win = new Zotero.ProgressWindow({ closeOnClick: true });
    win.changeHeadline(config.addonName);
    win.addDescription(summary);
    win.show();
    win.startCloseTimer(8000);
    return;
  }
  state.batch = undefined;
  restoreSelection(state);
  query(state, ".pinakes-progress")!.hidden = true;
  for (const ref of list.references) updateRow(state, ref);
  updateBatchBar(state);
  setStatus(
    state,
    failed ? "error" : "info",
    failed ? `${summary} Failed rows show the reason in red.` : summary,
  );
}

/** Test hook: the state of the section showing `itemID`, if any. */
export function _stateForItem(itemID: number) {
  return [...states.values()].find((s) => s.item?.id === itemID);
}
