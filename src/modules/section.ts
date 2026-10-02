/**
 * The "Pinakes" item pane section: shows the reference list of the
 * selected item (or of the parent of the PDF open in the reader), and
 * imports references one by one or in batches.
 */
import { config } from "../../package.json";
import { log } from "../utils/log";
import { getPref } from "../utils/prefs";
import { authorYear, button, copyButton, h, referenceUrl } from "./dom";
import { normalizeForSearch } from "./identifiers";
import {
  checkTargetEditable,
  importReference,
  resolveTarget,
  sameTarget,
  type ImportMethod,
  type ImportTarget,
  type TargetMode,
} from "./importer";
import { findInLibrary } from "./library";
import { loadReferenceList } from "./loader";
import { ImportSelectionGuard } from "./selectionGuard";
import { sourceLabel } from "./sources";
import type { Reference, ReferenceList } from "./types";

const ICON = `chrome://${config.addonRef}/content/icons/pinakes.svg`;

/**
 * In the library view, wait this long before fetching an uncached list, so
 * that moving through items with the arrow keys does not send a request
 * per item. The reader fetches immediately.
 */
const LIBRARY_FETCH_DELAY_MS = 600;

/** Per-section state, keyed by the section body element. */
interface SectionState {
  // Fixed for the lifetime of the section.
  readonly body: HTMLElement;
  readonly doc: Document;
  readonly guard: ImportSelectionGuard;
  // Updated on every render.
  tabType?: string;
  setSummary?: (summary: string) => void;
  // Reset whenever the section shows another item (see showItem).
  item?: Zotero.Item;
  list?: ReferenceList;
  /** Incremented on every load; stale async work checks it and bails out. */
  token: number;
  /** Reference index -> ID of the matching item in the target library. */
  matches: Map<number, number>;
  target?: ImportTarget;
  rows: Map<number, HTMLElement>;
  /** Checked reference indexes. */
  selected: Set<number>;
  lastClicked?: number;
  filter: string[];
  batch?: { cancelled: boolean };
}

const states = new Map<HTMLElement, SectionState>();
let paneID: string | false = false;

export function registerSection() {
  paneID = Zotero.ItemPaneManager.registerSection({
    paneID: "references",
    pluginID: config.addonID,
    header: { l10nID: `${config.addonRef}-section-header`, icon: ICON },
    sidenav: { l10nID: `${config.addonRef}-section-sidenav`, icon: ICON },
    onInit: ({ body, doc }) => {
      states.set(body, {
        body,
        doc,
        guard: new ImportSelectionGuard(),
        token: 0,
        matches: new Map(),
        rows: new Map(),
        selected: new Set(),
        filter: [],
      });
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
      state.tabType = tabType;
      state.setSummary = setSectionSummary;
      const citing = citingItem(item);
      if (citing && state.guard.isImportSelection(citing)) {
        // Keep the list; the citing item is selected again afterwards.
        setTimeout(() => restoreSelection(state), 0);
        return;
      }
      // Re-rendering the same item (after an edit, or after
      // setSectionSummary) keeps what is shown; only Refresh reloads it.
      // Reloading here would loop: load -> setSummary -> render -> load.
      if (state.item && state.item.id === citing?.id) return;
      showItem(state, citing, false);
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

function restoreSelection(state: SectionState) {
  if (state.tabType === "library" && state.item) {
    state.guard.restore(state.item);
  }
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Reset the section for `item` and load its list. A batch import that is
 * still running keeps going in the background with its own list and target.
 */
function showItem(
  state: SectionState,
  item: Zotero.Item | undefined,
  force: boolean,
  allowPdf = state.tabType === "reader",
) {
  state.token++;
  state.item = item;
  state.list = undefined;
  state.matches = new Map();
  state.target = undefined;
  state.rows = new Map();
  state.selected = new Set();
  state.lastClicked = undefined;
  state.filter = [];
  state.batch = undefined;
  renderSkeleton(state);
  if (item) void load(state, force, allowPdf);
}

async function load(state: SectionState, force: boolean, allowPdf: boolean) {
  const token = state.token;
  const isStale = () => state.token !== token;
  const result = await loadReferenceList(state.item!, {
    force,
    allowPdf,
    delayMs: state.tabType === "reader" ? 0 : LIBRARY_FETCH_DELAY_MS,
    onStatus: (message) => {
      if (!isStale()) setStatus(state, "busy", message);
    },
    isStale,
  });
  if (isStale() || result.kind === "stale") return;
  if (result.kind === "failed") {
    setStatus(state, result.severity, result.message);
    if (result.canTryPdf) offerPdf(state);
    state.setSummary?.(result.summary);
    return;
  }
  state.list = result.list;
  renderList(state);
  await markInLibrary(state, token);
}

/**
 * In the library view the PDF fallback is not automatic (it reads the PDF
 * and sends one Crossref request per entry); offer it as a button.
 */
function offerPdf(state: SectionState) {
  query(state, ".pinakes-status")?.append(
    h(state.doc, "br"),
    button(state.doc, "Read the bibliography from the PDF", () => {
      showItem(state, state.item, true, true);
      setStatus(state, "busy", "Reading the bibliography from the PDF…");
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
    updateAllRows(state);
  } catch (e) {
    log("Could not check which references are in the library", e);
  }
}

// ---------------------------------------------------------------------------
// Skeleton: toolbar, filter, batch bar, progress, status, list
// ---------------------------------------------------------------------------

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

function renderSkeleton(state: SectionState) {
  const { doc, body } = state;
  const root = h(doc, "div", "pinakes-root");

  const toolbar = h(doc, "div", "pinakes-toolbar");
  toolbar.append(
    h(doc, "span", "pinakes-target"),
    h(doc, "span", "pinakes-source"),
    button(doc, "Refresh", () => {
      if (!state.batch) showItem(state, state.item, true);
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
    for (const ref of importableShown(state)) {
      if (selectAll.checked) state.selected.add(ref.index);
      else state.selected.delete(ref.index);
    }
    updateAllRows(state);
  });
  batchBar.append(
    selectAll,
    button(
      doc,
      "Import selected",
      () =>
        void runBatch(
          state,
          importableShown(state).filter((r) => state.selected.has(r.index)),
        ),
      "pinakes-button pinakes-import-selected",
    ),
    button(
      doc,
      "Import all not in library",
      () => void runBatch(state, importableShown(state)),
      "pinakes-button pinakes-import-all",
    ),
  );
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
    if (!state.list || state.batch) return;
    if (!sameTarget(currentTarget(state), state.target)) {
      void markInLibrary(state, state.token);
    }
  });

  body.replaceChildren(root);
  setStatus(state, "busy", "Loading…");
}

const TARGET_HELP: Record<TargetMode, string> = {
  selected:
    "The collection selected in the main window, or the library of this item if no collection is selected.",
  parent: "The first collection containing this item (or its library root).",
  root: "The library of this item.",
};

function renderTarget(state: SectionState) {
  const el = query(state, ".pinakes-target");
  if (!el || !state.target) return;
  el.textContent = `Import to: ${state.target.label}`;
  const mode = getPref("targetMode") as TargetMode;
  el.title = `${TARGET_HELP[mode] ?? TARGET_HELP.selected} Change in Settings > Pinakes.`;
}

function renderList(state: SectionState) {
  const list = state.list!;
  state.rows = new Map(
    list.references.map((ref) => [ref.index, renderRow(state, ref)]),
  );
  query(state, ".pinakes-list")?.replaceChildren(...state.rows.values());

  const source = query(state, ".pinakes-source");
  if (source) {
    const paperOrder = list.order === "paper" && list.source !== "pdf";
    source.textContent =
      `${list.references.length} from ${sourceLabel(list.source)}` +
      (paperOrder ? ", paper order" : "");
    source.title = `Fetched ${new Date(list.fetchedAt).toLocaleString()}`;
  }
  const hasRefs = list.references.length > 0;
  query(state, ".pinakes-filterbar")!.hidden = !hasRefs;
  query(state, ".pinakes-batchbar")!.hidden = !hasRefs;
  // Notes (fallbacks, hidden entries, ordering) stay visible.
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
    const fields = [ref.title, ref.authors.join(" "), ref.venue, ref.year];
    fields.push(ref.doi, ref.arxiv, ref.raw);
    text = normalizeForSearch(fields.filter(Boolean).join(" "));
    searchText.set(ref, text);
  }
  return text;
}

function isShown(state: SectionState, ref: Reference) {
  const text = state.filter.length ? haystack(ref) : "";
  return state.filter.every((token) => text.includes(token));
}

function shownRefs(state: SectionState) {
  return (state.list?.references ?? []).filter((r) => isShown(state, r));
}

function importableShown(state: SectionState) {
  return shownRefs(state).filter((r) => importable(state, r));
}

function applyFilter(state: SectionState) {
  if (!state.list) return;
  let shown = 0;
  for (const ref of state.list.references) {
    const visible = isShown(state, ref);
    state.rows.get(ref.index)!.hidden = !visible;
    if (visible) shown++;
  }
  query(state, ".pinakes-count")!.textContent = state.filter.length
    ? `${shown} of ${state.list.references.length}`
    : "";
  updateBatchBar(state);
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

function abstractTooltip(ref: Reference) {
  if (ref.unresolved)
    return "No online record matches this entry from the PDF.";
  if (!ref.abstract) return "No abstract available. Click to expand.";
  return ref.abstract.length > 600
    ? `${ref.abstract.slice(0, 600)}…`
    : ref.abstract;
}

function renderRow(state: SectionState, ref: Reference) {
  const { doc } = state;
  const li = h(doc, "li", "pinakes-row");
  li.dataset.index = String(ref.index);
  if (ref.unresolved) li.classList.add("pinakes-unresolved");

  const check = h(doc, "input", "pinakes-check");
  check.type = "checkbox";
  check.addEventListener("click", (e) => onCheck(state, ref, e as MouseEvent));

  const text = h(doc, "div", "pinakes-text");
  if (ref.unresolved) {
    text.append(
      h(doc, "div", "pinakes-raw", ref.raw ?? ref.title),
      h(doc, "div", "pinakes-meta", "From the PDF, no online record found"),
    );
  } else {
    const who = authorYear(ref) ?? "Unknown author";
    text.append(
      h(doc, "div", "pinakes-title", ref.title),
      h(
        doc,
        "div",
        "pinakes-meta",
        [who, ref.venue].filter(Boolean).join(" · "),
      ),
    );
  }

  const main = h(doc, "div", "pinakes-row-main");
  main.title = abstractTooltip(ref);
  // Lists in the paper's order show the paper's own numbers.
  main.append(
    check,
    h(doc, "span", "pinakes-num", ref.label ?? `${ref.index}`),
    text,
  );
  main.addEventListener("click", () => li.classList.toggle("pinakes-expanded"));

  const abstract = ref.unresolved
    ? ""
    : (ref.abstract ?? "No abstract available.") +
      (ref.raw ? `\n\nAs printed in the PDF: ${ref.raw}` : "");
  li.append(
    main,
    h(doc, "div", "pinakes-abstract", abstract),
    h(doc, "div", "pinakes-actions"),
  );
  updateRow(state, ref, li);
  return li;
}

function onCheck(state: SectionState, ref: Reference, event: MouseEvent) {
  event.stopPropagation();
  const checked = (event.target as HTMLInputElement).checked;
  let range = [ref];
  // Shift-click selects the range of shown rows since the last click.
  if (event.shiftKey && state.lastClicked !== undefined) {
    const shown = shownRefs(state);
    const a = shown.findIndex((r) => r.index === state.lastClicked);
    const b = shown.indexOf(ref);
    if (a >= 0 && b >= 0) {
      range = shown.slice(Math.min(a, b), Math.max(a, b) + 1);
    }
  }
  state.lastClicked = ref.index;
  for (const r of range) {
    if (!importable(state, r)) continue;
    if (checked) state.selected.add(r.index);
    else state.selected.delete(r.index);
  }
  updateAllRows(state);
}

function updateAllRows(state: SectionState) {
  for (const ref of state.list?.references ?? []) updateRow(state, ref);
  updateBatchBar(state);
}

/** Refresh a row's checkbox and actions from the state (unless busy). */
function updateRow(
  state: SectionState,
  ref: Reference,
  row = state.rows.get(ref.index),
) {
  const check = row?.querySelector(".pinakes-check") as HTMLInputElement;
  const actions = row?.querySelector(".pinakes-actions") as HTMLElement;
  if (!row || actions.dataset.busy) return;

  const can = importable(state, ref);
  check.disabled = !can || !!state.batch;
  check.checked = can && state.selected.has(ref.index);
  check.style.visibility = can ? "" : "hidden";

  actions.replaceChildren(...rowActions(state, ref));
}

function rowActions(state: SectionState, ref: Reference): HTMLElement[] {
  const { doc } = state;
  if (ref.unresolved) {
    const copy = copyButton(doc, "Copy", ref.raw ?? ref.title);
    copy.title = "Copy the entry text, e.g. to search for it.";
    return [copy];
  }

  let primary: HTMLButtonElement;
  const itemID = state.matches.get(ref.index);
  if (itemID) {
    primary = button(
      doc,
      "In library",
      () => void Zotero.getMainWindow()?.ZoteroPane?.selectItem(itemID),
      "pinakes-button pinakes-in-library",
    );
    primary.title = "Already in the target library. Click to show it.";
  } else {
    primary = button(
      doc,
      "Import",
      () => void importOne(state, ref, currentTarget(state), state.list!),
      "pinakes-button pinakes-import",
    );
    primary.disabled = !!state.batch;
    primary.title = ref.doi
      ? `Import by DOI ${ref.doi}`
      : ref.arxiv
        ? `Import by arXiv ID ${ref.arxiv}`
        : "No DOI or arXiv ID: the item will be created from the API metadata.";
  }

  const copy = copyButton(doc, "Copy DOI", ref.doi ?? "");
  copy.disabled = !ref.doi;
  if (!ref.doi) copy.title = "This reference has no DOI.";

  const url = referenceUrl(ref);
  const open = button(doc, "Open", () => url && Zotero.launchURL(url));
  open.disabled = !url;
  open.title = url ?? "This reference has no DOI or arXiv ID.";

  return [primary, copy, open];
}

// ---------------------------------------------------------------------------
// Importing
// ---------------------------------------------------------------------------

/**
 * Import one reference of `list` and, if the section still shows that
 * list, update its row. Returns the import method, or undefined if the
 * import failed (the reason is shown in the row).
 */
async function importOne(
  state: SectionState,
  ref: Reference,
  target: ImportTarget,
  list: ReferenceList,
): Promise<ImportMethod | undefined> {
  // The section may switch to another item while a batch is running; the
  // import still happens, but only the list it belongs to is updated.
  const live = () => state.list === list;
  const actions = live()
    ? (state.rows.get(ref.index)?.querySelector(".pinakes-actions") as
        HTMLElement | undefined)
    : undefined;
  if (actions) {
    actions.dataset.busy = "1";
    const importBtn =
      actions.querySelector<HTMLButtonElement>(".pinakes-import");
    if (importBtn) {
      importBtn.disabled = true;
      importBtn.textContent = "Importing…";
    }
  }
  const targetChanged = !sameTarget(target, state.target);
  if (live()) {
    state.target = target;
    renderTarget(state);
  }

  let method: ImportMethod | undefined;
  let note: HTMLElement | undefined;
  try {
    checkTargetEditable(target);
    const result = await state.guard.track(() => importReference(ref, target));
    method = result.method;
    log(
      `Imported reference ${ref.index} via ${method} as item ${result.item.id} (library ${result.item.libraryID})`,
    );
    if (live()) {
      state.matches.set(ref.index, result.item.id);
      state.selected.delete(ref.index);
    }
    if (method === "metadata") {
      note = h(
        state.doc,
        "span",
        "pinakes-row-note",
        "Created from API metadata",
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`Import of reference ${ref.index} failed`, e);
    note = h(
      state.doc,
      "span",
      "pinakes-row-error",
      `Import failed: ${message}`,
    );
  }
  restoreSelection(state);

  if (actions && live()) {
    delete actions.dataset.busy;
    updateRow(state, ref);
    if (note) actions.append(note);
    updateBatchBar(state);
    if (targetChanged && !state.batch) void markInLibrary(state, state.token);
  }
  return method;
}

function updateBatchBar(state: SectionState) {
  const candidates = importableShown(state);
  const selected = candidates.filter((r) => state.selected.has(r.index));
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
    const shown = state.filter.length ? "shown " : "";
    importAll.textContent = `Import all ${shown}not in library (${candidates.length})`;
    importAll.disabled = busy || !candidates.length;
  }
  const selectAll = query<HTMLInputElement>(state, ".pinakes-select-all");
  if (selectAll) {
    selectAll.disabled = busy || !candidates.length;
    selectAll.checked =
      candidates.length > 0 && selected.length === candidates.length;
    selectAll.indeterminate =
      selected.length > 0 && selected.length < candidates.length;
  }
}

function setProgress(state: SectionState, done: number, total: number) {
  const progress = query(state, ".pinakes-progress")!;
  progress.hidden = false;
  const bar = progress.querySelector("progress")!;
  bar.max = total;
  bar.value = done;
  progress.querySelector(".pinakes-progress-text")!.textContent =
    `Importing ${Math.min(done + 1, total)} of ${total}…`;
}

/** Import references one after another, with progress and cancel. */
async function runBatch(state: SectionState, refs: Reference[]) {
  if (state.batch || !state.list || !refs.length) return;
  const target = currentTarget(state);
  try {
    checkTargetEditable(target);
  } catch (e) {
    setStatus(state, "error", e instanceof Error ? e.message : String(e));
    return;
  }
  const batch = { cancelled: false };
  const list = state.list;
  const live = () => state.list === list;
  state.batch = batch;
  updateAllRows(state);
  log(`Batch import of ${refs.length} references into ${target.label}`);

  const counts = { imported: 0, fromMetadata: 0, failed: 0, existing: 0 };
  let done = 0;
  await state.guard.track(async () => {
    for (const ref of refs) {
      if (batch.cancelled) break;
      if (live()) setProgress(state, done, refs.length);
      done++;
      // Imported earlier in this batch, e.g. a work the paper cites under
      // two numbers.
      const existing = (await findInLibrary(target.libraryID, [ref])).get(
        ref.index,
      );
      if (existing) {
        counts.existing++;
        if (live()) {
          state.matches.set(ref.index, existing);
          updateRow(state, ref);
        }
        continue;
      }
      const method = await importOne(state, ref, target, list);
      if (!method) counts.failed++;
      else counts.imported++;
      if (method === "metadata") counts.fromMetadata++;
    }
  });

  const parts = [
    `Imported ${counts.imported} of ${refs.length} into ${target.label}`,
  ];
  if (counts.fromMetadata) {
    parts.push(`${counts.fromMetadata} created from metadata`);
  }
  if (counts.existing) parts.push(`${counts.existing} already in library`);
  if (counts.failed) parts.push(`${counts.failed} failed`);
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
  updateAllRows(state);
  setStatus(
    state,
    counts.failed ? "error" : "info",
    counts.failed ? `${summary} Failed rows show the reason in red.` : summary,
  );
}
