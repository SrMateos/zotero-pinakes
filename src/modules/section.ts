/**
 * The "Pinakes" item pane section: shows the reference list of the
 * selected item (or of the parent of the PDF open in the reader).
 */
import { config } from "../../package.json";
import { log } from "../utils/log";
import { getCached, setCached } from "./cache";
import {
  checkTargetEditable,
  importReference,
  resolveTarget,
  type ImportTarget,
} from "./importer";
import { findInLibrary, getPaperId } from "./library";
import { describe, fetchReferences, sourceLabel } from "./sources";
import type { PaperId, Reference, ReferenceList } from "./types";

const HTML_NS = "http://www.w3.org/1999/xhtml";
const ICON = `chrome://${config.addonRef}/content/icons/pinakes.svg`;

/** Per-section state, keyed by the section body element. */
interface SectionState {
  body: HTMLElement;
  doc: Document;
  item?: Zotero.Item;
  paperId?: PaperId;
  list?: ReferenceList;
  /** Reference index -> Zotero item ID of the matching library item. */
  matches: Map<number, number>;
  target?: ImportTarget;
  /** Incremented on every load; stale async work checks it and bails out. */
  token: number;
  setSummary?: (summary: string) => void;
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
      states.set(body, { body, doc, matches: new Map(), token: 0 });
    },
    onDestroy: ({ body }) => {
      states.delete(body);
    },
    onItemChange: ({ item, setEnabled }) => {
      setEnabled(!!citingItem(item));
      return true;
    },
    onRender: ({ body, item }) => {
      const state = states.get(body);
      if (!state) return;
      const target = citingItem(item);
      // Re-rendering the same item (e.g. after an edit) keeps the list.
      if (state.item?.id === target?.id && state.list) return;
      state.item = target;
      state.list = undefined;
      state.matches = new Map();
      renderSkeleton(state);
    },
    onAsyncRender: async ({ body, setSectionSummary }) => {
      const state = states.get(body);
      if (!state) return;
      state.setSummary = setSectionSummary;
      if (!state.list) await load(state, false);
    },
  });
  log(`Registered item pane section: ${paneID}`);
}

export function unregisterSection() {
  if (paneID) Zotero.ItemPaneManager.unregisterSection(paneID);
  paneID = false;
  states.clear();
}

/** Re-check "in library" marks in every open section (after item changes). */
export async function refreshLibraryMarks() {
  for (const state of states.values()) {
    if (state.list) await markInLibrary(state, state.token);
  }
}

/** The regular item whose references we show, if any. */
function citingItem(item: Zotero.Item | undefined | null) {
  if (!item) return undefined;
  if (item.isAttachment() && item.parentItem) return item.parentItem;
  return item.isRegularItem() ? item : undefined;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function load(state: SectionState, force: boolean) {
  const token = ++state.token;
  const item = state.item;
  if (!item) return;

  const paperId = getPaperId(item);
  state.paperId = paperId;
  if (!paperId) {
    setStatus(
      state,
      "info",
      "No identifier: this item has no DOI and no arXiv ID (checked the DOI, URL, Extra and Archive ID fields). Add one to see its references.",
    );
    state.setSummary?.("No identifier");
    return;
  }

  let list = force ? undefined : await getCached(item, paperId);
  if (list) {
    log(`Using cached references for ${describe(paperId)}`);
  } else {
    setStatus(state, "busy", `Fetching references for ${describe(paperId)}…`);
    try {
      list = await fetchReferences(paperId, (message) => {
        if (state.token === token) setStatus(state, "busy", message);
      });
      await setCached(item, list);
    } catch (e) {
      if (state.token !== token) return;
      const message = e instanceof Error ? e.message : String(e);
      setStatus(
        state,
        "error",
        `Could not load references for ${describe(paperId)}.\n${message}`,
      );
      state.setSummary?.("Error");
      return;
    }
  }
  if (state.token !== token) return;
  state.list = list;
  renderList(state);
  await markInLibrary(state, token);
}

/** Update the import target and the "In library" marks. */
async function markInLibrary(state: SectionState, token: number) {
  if (!state.item || !state.list) return;
  const target = resolveTarget(state.item.libraryID);
  state.target = target;
  renderTarget(state);
  try {
    const matches = await findInLibrary(
      target.libraryID,
      state.list.references,
    );
    if (state.token !== token) return;
    state.matches = matches;
    for (const ref of state.list.references) updateRowActions(state, ref);
  } catch (e) {
    log("Could not check which references are in the library", e);
  }
}

// ---------------------------------------------------------------------------
// Rendering
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

function renderSkeleton(state: SectionState) {
  const { doc, body } = state;
  body.replaceChildren();
  const root = h(doc, "div", "pinakes-root");

  const toolbar = h(doc, "div", "pinakes-toolbar");
  toolbar.append(
    h(doc, "span", "pinakes-target"),
    h(doc, "span", "pinakes-source"),
    button(doc, "Refresh", () => {
      state.list = undefined;
      renderSkeleton(state);
      void load(state, true);
    }),
  );
  root.append(
    toolbar,
    h(doc, "div", "pinakes-status"),
    h(doc, "ol", "pinakes-list"),
  );

  // The selected collection can change while the reader is open; re-check
  // the target when the pointer enters the section.
  root.addEventListener("mouseenter", () => {
    if (!state.item || !state.list) return;
    const target = resolveTarget(state.item.libraryID);
    if (
      target.libraryID !== state.target?.libraryID ||
      target.collectionID !== state.target?.collectionID
    ) {
      void markInLibrary(state, state.token);
    }
  });

  body.append(root);
  setStatus(state, "busy", "Loading…");
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

function renderTarget(state: SectionState) {
  const el = query(state, ".pinakes-target");
  if (!el || !state.target) return;
  el.textContent = `Import to: ${state.target.label}`;
  el.title =
    "The collection selected in the main window, or the library of this item if no collection is selected.";
}

function renderList(state: SectionState) {
  const list = state.list!;
  const ol = query(state, ".pinakes-list");
  if (!ol) return;
  ol.replaceChildren(...list.references.map((ref) => renderRow(state, ref)));

  const source = query(state, ".pinakes-source");
  if (source) {
    source.textContent = `${list.references.length} from ${sourceLabel(list.source)}`;
    source.title = `Fetched ${new Date(list.fetchedAt).toLocaleString()}`;
  }
  // Fallback notes (e.g. Semantic Scholar was rate limited) stay visible.
  if (list.notes.length) setStatus(state, "info", list.notes.join("\n"));
  else setStatus(state, "none");
  state.setSummary?.(`${list.references.length} references`);
}

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

  const main = h(doc, "div", "pinakes-row-main");
  main.title = ref.abstract
    ? ref.abstract.length > 600
      ? `${ref.abstract.slice(0, 600)}…`
      : ref.abstract
    : "No abstract available. Click to expand.";
  main.append(
    h(doc, "span", "pinakes-num", `${ref.index}`),
    (() => {
      const text = h(doc, "div", "pinakes-text");
      text.append(h(doc, "div", "pinakes-title", ref.title));
      const meta = [authorYear(ref), ref.venue].filter(Boolean).join(" · ");
      text.append(h(doc, "div", "pinakes-meta", meta));
      return text;
    })(),
  );
  main.addEventListener("click", () => li.classList.toggle("pinakes-expanded"));

  const abstract = h(
    doc,
    "div",
    "pinakes-abstract",
    ref.abstract ?? "No abstract available.",
  );
  const actions = h(doc, "div", "pinakes-actions");
  li.append(main, abstract, actions);
  fillActions(state, ref, actions);
  return li;
}

function updateRowActions(state: SectionState, ref: Reference) {
  const actions = query(
    state,
    `.pinakes-row[data-index="${ref.index}"] .pinakes-actions`,
  );
  if (actions && !actions.dataset.busy) fillActions(state, ref, actions);
}

function fillActions(
  state: SectionState,
  ref: Reference,
  actions: HTMLElement,
) {
  const { doc } = state;
  actions.replaceChildren();
  const itemID = state.matches.get(ref.index);

  if (itemID) {
    const inLib = button(doc, "In library", () => {
      Zotero.getMainWindow()?.ZoteroPane?.selectItem(itemID);
    });
    inLib.classList.add("pinakes-in-library");
    inLib.title = "Already in the target library. Click to show it.";
    actions.append(inLib);
  } else {
    const importBtn = button(
      doc,
      "Import",
      () => void onImport(state, ref, actions),
    );
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

async function onImport(
  state: SectionState,
  ref: Reference,
  actions: HTMLElement,
) {
  if (!state.item) return;
  const target = resolveTarget(state.item.libraryID);
  const targetChanged =
    target.libraryID !== state.target?.libraryID ||
    target.collectionID !== state.target?.collectionID;
  state.target = target;
  renderTarget(state);

  actions.dataset.busy = "1";
  const importBtn = actions.querySelector("button");
  if (importBtn) {
    importBtn.disabled = true;
    importBtn.textContent = "Importing…";
  }
  actions.querySelector(".pinakes-row-error")?.remove();

  try {
    checkTargetEditable(target);
    const { item, method } = await importReference(ref, target);
    log(
      `Imported reference ${ref.index} via ${method} as item ${item.id} (library ${item.libraryID})`,
    );
    state.matches.set(ref.index, item.id);
    delete actions.dataset.busy;
    fillActions(state, ref, actions);
    if (method === "metadata") {
      actions.append(
        h(state.doc, "span", "pinakes-row-note", "Created from API metadata"),
      );
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    log(`Import of reference ${ref.index} failed`, e);
    delete actions.dataset.busy;
    fillActions(state, ref, actions);
    actions.append(
      h(state.doc, "span", "pinakes-row-error", `Import failed: ${message}`),
    );
  }
  if (targetChanged) void markInLibrary(state, state.token);
}
