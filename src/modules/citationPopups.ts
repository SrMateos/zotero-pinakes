/**
 * Experimental: in the PDF reader, hovering a numeric citation marker such
 * as "[23]" or "[4, 7–9]" shows a popup with the matching reference cards.
 *
 * The marker is read from PDF.js's text layer under the pointer. Numbers
 * are mapped to references through the paper's own bibliography (read from
 * the PDF, locally), because the order of API results does not always
 * follow the paper's numbering.
 */
import { config } from "../../package.json";
import { log } from "../utils/log";
import { getPref } from "../utils/prefs";
import { titleInEntry } from "./bibliography";
import { getCached } from "./cache";
import { markerAt } from "./citations";
import {
  checkTargetEditable,
  importReference,
  resolveTarget,
  type TargetMode,
} from "./importer";
import { findInLibrary, getPaperId } from "./library";
import { readBibliography } from "./pdf";
import { sourceLabel } from "./sources";
import type { Reference, ReferenceList } from "./types";

const STYLE_ID = "pinakes-citation-style";
const HOVER_DELAY_MS = 300;
const HIDE_DELAY_MS = 350;

/** What a cited number points to. */
interface Card {
  label: string;
  ref?: Reference;
  /** The entry as printed in the PDF, when known. */
  raw?: string;
}

interface Mapping {
  fetchedAt: string;
  source: ReferenceList["source"];
  cards: Map<number, Card>;
  /** True if numbers follow the API order, not the paper's bibliography. */
  approximate: boolean;
}

/** Number -> card mappings, by citing item ID. */
const mappings = new Map<number, Promise<Mapping | undefined>>();
const attachedDocs = new WeakSet<Document>();
/** The hover handler of each attached view document. */
const checkers = new WeakMap<
  Document,
  (x: number, y: number) => Promise<void>
>();
const cleanups = new Set<() => void>();

export function registerCitationPopups() {
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    onRenderToolbar,
    config.addonID,
  );
  for (const reader of (Zotero.Reader as any)._readers ?? []) {
    void attachReader(reader);
  }
}

export function unregisterCitationPopups() {
  Zotero.Reader.unregisterEventListener("renderToolbar", onRenderToolbar);
  for (const cleanup of cleanups) cleanup();
  cleanups.clear();
  mappings.clear();
}

/**
 * Test hook (used by test/zotero): run the hover logic at (x, y) in the
 * primary view of the reader in `tabID`, as a mouse pause there would.
 * Returns whether a popup is shown afterwards.
 */
export async function hoverForTest(tabID: string, x: number, y: number) {
  const reader: any = Zotero.Reader.getByTabID(tabID);
  const doc: Document | undefined =
    reader?._internalReader?._primaryView?._iframeWindow?.document;
  const check = doc && checkers.get(doc);
  if (!check) return false;
  await check(x, y);
  return !!doc.querySelector(".pinakes-citation-popup");
}

/** Called when a reader tab is selected, in case its view was recreated. */
export function attachReaderByTabID(tabID: string) {
  const reader = Zotero.Reader.getByTabID(tabID);
  if (reader) void attachReader(reader);
}

function onRenderToolbar(event: { reader: any }) {
  void attachReader(event.reader);
}

async function attachReader(reader: any) {
  try {
    if ((reader._type ?? reader.type ?? "pdf") !== "pdf") return;
    await reader._initPromise;
    // The PDF view iframe is created after the reader itself.
    for (let i = 0; i < 60; i++) {
      const internal = reader._internalReader;
      let found = false;
      for (const view of [internal?._primaryView, internal?._secondaryView]) {
        const win = view?._iframeWindow;
        const doc: Document | undefined = win?.document;
        // Wait for the PDF.js viewer itself, not the iframe's initial
        // about:blank document.
        if (
          doc?.getElementById("viewerContainer") &&
          win.PDFViewerApplication
        ) {
          attachDoc(reader, doc);
          found = true;
        }
      }
      if (found) return;
      await Zotero.Promise.delay(500);
    }
  } catch (e) {
    log("Could not attach citation popups to the reader", e);
  }
}

function citingItemOf(reader: any): Zotero.Item | undefined {
  const attachment = Zotero.Items.get(reader.itemID);
  return (attachment && attachment.parentItem) || undefined;
}

// ---------------------------------------------------------------------------
// Number -> reference mapping
// ---------------------------------------------------------------------------

async function getMapping(item: Zotero.Item) {
  const list = await getCached(item, getPaperId(item));
  if (!list) return undefined;
  const existing = await mappings.get(item.id);
  if (existing && existing.fetchedAt === list.fetchedAt) return existing;
  const mapping = buildMapping(item, list);
  mappings.set(item.id, mapping);
  return mapping;
}

async function buildMapping(
  item: Zotero.Item,
  list: ReferenceList,
): Promise<Mapping> {
  const cards = new Map<number, Card>();
  const base = { fetchedAt: list.fetchedAt, source: list.source, cards };

  if (list.source === "pdf") {
    for (const ref of list.references) {
      if (!ref.label) continue;
      cards.set(Number(ref.label), {
        label: ref.label,
        ref: ref.unresolved ? undefined : ref,
        raw: ref.raw,
      });
    }
    return { ...base, approximate: false };
  }

  try {
    const bibliography = await readBibliography(item);
    if (bibliography.style !== "author-year") {
      for (const entry of bibliography.entries) {
        if (!entry.label) continue;
        const ref = list.references.find((r) =>
          titleInEntry(r.title, entry.text),
        );
        cards.set(Number(entry.label), {
          label: entry.label,
          ref,
          raw: entry.text,
        });
      }
      log(`Citation popups: mapped ${cards.size} numbers via the PDF`);
      return { ...base, approximate: false };
    }
  } catch (e) {
    log("Citation popups: could not read the PDF bibliography", e);
  }

  for (const ref of list.references) {
    cards.set(ref.index, { label: String(ref.index), ref });
  }
  return { ...base, approximate: true };
}

// ---------------------------------------------------------------------------
// Hover detection
// ---------------------------------------------------------------------------

interface Hit {
  numbers: number[];
  key: string;
  rect: DOMRect;
}

/** The citation marker under (x, y) in a PDF.js text layer, if any. */
function markerAtPoint(doc: Document, x: number, y: number): Hit | undefined {
  const pos = (doc as any).caretPositionFromPoint?.(x, y);
  const node: Node | null | undefined = pos?.offsetNode;
  if (!node || node.nodeType !== 3) return undefined;
  const span = node.parentElement;
  if (!span || !span.closest(".textLayer")) return undefined;
  const rect = span.getBoundingClientRect();
  // caretPositionFromPoint snaps to the nearest text; require a real hit.
  if (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom) {
    return undefined;
  }

  // A marker may be split over neighbouring spans ("[4," / "7–9]").
  const context: Element[] = [span];
  for (let s = span.previousElementSibling, i = 0; s && i < 2; i++) {
    context.unshift(s);
    s = s.previousElementSibling;
  }
  for (let s = span.nextElementSibling, i = 0; s && i < 2; i++) {
    context.push(s);
    s = s.nextElementSibling;
  }
  let text = "";
  let offset = -1;
  for (const el of context) {
    if (el === span) offset = text.length + (pos.offset as number);
    text += el.textContent ?? "";
  }
  const marker = markerAt(text, offset);
  if (!marker) return undefined;
  return {
    numbers: marker.numbers,
    key: `${marker.numbers.join(",")}@${Math.round(rect.top)}:${Math.round(rect.left)}`,
    rect,
  };
}

// ---------------------------------------------------------------------------
// Popup
// ---------------------------------------------------------------------------

const CSS = `
.pinakes-citation-popup {
  position: fixed; z-index: 100000; max-width: 380px; max-height: 60vh;
  overflow: auto; padding: 8px 10px; border-radius: 6px;
  font: 13px/1.35 system-ui, sans-serif;
  background: #fff; color: #222; border: 1px solid rgba(0,0,0,.2);
  box-shadow: 0 4px 16px rgba(0,0,0,.25);
}
@media (prefers-color-scheme: dark) {
  .pinakes-citation-popup { background: #2b2b2b; color: #eee; border-color: rgba(255,255,255,.2); }
}
.pinakes-citation-popup .pk-card + .pk-card { margin-top: 8px; padding-top: 8px; border-top: 1px solid rgba(128,128,128,.3); }
.pinakes-citation-popup .pk-title { font-weight: 600; }
.pinakes-citation-popup .pk-meta, .pinakes-citation-popup .pk-note { opacity: .75; font-size: 12px; }
.pinakes-citation-popup .pk-abstract { margin-top: 3px; font-size: 12px; }
.pinakes-citation-popup .pk-actions { margin-top: 4px; display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.pinakes-citation-popup button { font: inherit; font-size: 12px; padding: 1px 8px; cursor: pointer; }
`;

function attachDoc(reader: any, doc: Document) {
  if (attachedDocs.has(doc)) return;
  attachedDocs.add(doc);
  const win = doc.defaultView!;
  if (!doc.getElementById(STYLE_ID)) {
    const style = doc.createElement("style");
    style.id = STYLE_ID;
    style.textContent = CSS;
    (doc.head ?? doc.documentElement)?.append(style);
  }

  let popup: HTMLElement | undefined;
  let currentKey: string | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const hide = () => {
    popup?.remove();
    popup = undefined;
    currentKey = undefined;
  };
  const scheduleHide = () => {
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(hide, HIDE_DELAY_MS);
  };
  const keepOpen = () => {
    if (hideTimer) clearTimeout(hideTimer);
  };

  const check = async (x: number, y: number) => {
    const hit = markerAtPoint(doc, x, y);
    if (!hit) {
      if (popup) scheduleHide();
      return;
    }
    keepOpen();
    if (hit.key === currentKey) return;
    const item = citingItemOf(reader);
    if (!item) return;
    const mapping = await getMapping(item);
    if (!mapping) return;
    hide();
    currentKey = hit.key;
    popup = await renderPopup(doc, item, mapping, hit);
    if (currentKey !== hit.key) {
      popup.remove();
      return;
    }
    popup.addEventListener("mouseenter", keepOpen);
    popup.addEventListener("mouseleave", scheduleHide);
    doc.body?.append(popup);
    position(win, popup, hit.rect);
  };

  const onMove = (event: MouseEvent) => {
    if (!getPref("citationPopups")) return;
    if (popup && popup.contains(event.target as Node)) return;
    if (hoverTimer) clearTimeout(hoverTimer);
    const { clientX, clientY } = event;
    hoverTimer = setTimeout(() => {
      check(clientX, clientY).catch((e) => log("Citation popup failed", e));
    }, HOVER_DELAY_MS);
  };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") hide();
  };

  checkers.set(doc, check);
  doc.addEventListener("mousemove", onMove);
  doc.addEventListener("scroll", hide, true);
  doc.addEventListener("keydown", onKey);
  log("Citation popups attached to a reader view");

  const cleanup = () => {
    if (hoverTimer) clearTimeout(hoverTimer);
    if (hideTimer) clearTimeout(hideTimer);
    hide();
    try {
      doc.removeEventListener("mousemove", onMove);
      doc.removeEventListener("scroll", hide, true);
      doc.removeEventListener("keydown", onKey);
      doc.getElementById(STYLE_ID)?.remove();
    } catch {
      // The reader may already be closed.
    }
    attachedDocs.delete(doc);
  };
  cleanups.add(cleanup);
  win.addEventListener("unload", () => cleanups.delete(cleanup), {
    once: true,
  });
}

function position(win: Window, popup: HTMLElement, rect: DOMRect) {
  const width = popup.offsetWidth;
  const height = popup.offsetHeight;
  const left = Math.max(4, Math.min(rect.left, win.innerWidth - width - 8));
  let top = rect.bottom + 6;
  if (top + height > win.innerHeight - 4) {
    top = Math.max(4, rect.top - height - 6);
  }
  popup.style.left = `${left}px`;
  popup.style.top = `${top}px`;
}

function authorYear(ref: Reference) {
  const surname = ref.authors[0]?.trim().split(/\s+/).pop();
  const who = surname
    ? ref.authors.length > 1
      ? `${surname} et al.`
      : surname
    : undefined;
  return [who, ref.year].filter(Boolean).join(", ");
}

async function renderPopup(
  doc: Document,
  item: Zotero.Item,
  mapping: Mapping,
  hit: Hit,
) {
  const el = (tag: string, className?: string, text?: string) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const popup = el("div", "pinakes-citation-popup");

  const target = resolveTarget(item, getPref("targetMode") as TargetMode);
  const refs = hit.numbers
    .map((n) => mapping.cards.get(n)?.ref)
    .filter((r): r is Reference => !!r);
  let matches = new Map<number, number>();
  try {
    matches = await findInLibrary(target.libraryID, refs);
  } catch (e) {
    log("Citation popup: library check failed", e);
  }

  for (const n of hit.numbers) {
    const card = mapping.cards.get(n);
    const box = el("div", "pk-card");
    const ref = card?.ref;
    if (!card) {
      box.append(el("div", "pk-note", `[${n}] Not in the reference list.`));
    } else if (!ref) {
      box.append(
        el("div", "pk-title", `[${n}]`),
        el("div", "pk-abstract", card.raw ?? ""),
        el("div", "pk-note", "Not matched to an online record."),
      );
    } else {
      box.append(el("div", "pk-title", `[${n}] ${ref.title}`));
      const meta = [authorYear(ref), ref.venue].filter(Boolean).join(" · ");
      if (meta) box.append(el("div", "pk-meta", meta));
      if (ref.abstract) {
        const text =
          ref.abstract.length > 320
            ? `${ref.abstract.slice(0, 320)}…`
            : ref.abstract;
        box.append(el("div", "pk-abstract", text));
      }
      box.append(renderActions(el, ref, target, matches));
    }
    popup.append(box);
  }
  if (mapping.approximate) {
    popup.append(
      el(
        "div",
        "pk-note",
        `Numbers follow ${sourceLabel(mapping.source)}'s order and may not match the paper.`,
      ),
    );
  }
  return popup;
}

function renderActions(
  el: (tag: string, className?: string, text?: string) => HTMLElement,
  ref: Reference,
  target: ReturnType<typeof resolveTarget>,
  matches: Map<number, number>,
) {
  const actions = el("div", "pk-actions");
  const url = ref.doi
    ? `https://doi.org/${ref.doi}`
    : ref.arxiv
      ? `https://arxiv.org/abs/${ref.arxiv}`
      : undefined;
  if (url) {
    const open = el("button", undefined, "Open");
    open.addEventListener("click", () => Zotero.launchURL(url));
    actions.append(open);
  }
  const inLibrary = matches.get(ref.index);
  if (inLibrary) {
    actions.append(el("span", "pk-note", "In library"));
  } else {
    const importBtn = el("button", undefined, "Import") as HTMLButtonElement;
    importBtn.title = `Import to ${target.label}`;
    importBtn.addEventListener("click", async () => {
      importBtn.disabled = true;
      importBtn.textContent = "Importing…";
      try {
        checkTargetEditable(target);
        const { method } = await importReference(ref, target);
        importBtn.replaceWith(
          el(
            "span",
            "pk-note",
            method === "metadata"
              ? "Imported (from metadata)"
              : `Imported to ${target.label}`,
          ),
        );
      } catch (e) {
        importBtn.textContent = "Import";
        importBtn.disabled = false;
        actions.append(
          el(
            "span",
            "pk-note",
            `Import failed: ${e instanceof Error ? e.message : e}`,
          ),
        );
      }
    });
    actions.append(importBtn);
  }
  return actions;
}
