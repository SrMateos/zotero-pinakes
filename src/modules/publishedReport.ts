/**
 * The "Pinakes: find published versions" entry of the collection context
 * menu, and its report window: check the collection's items in DBLP one
 * at a time, list what was found, and apply an action to the selected
 * items only after the user confirms.
 */
import { config } from "../../package.json";
import { log } from "../utils/log";
import { button, h } from "./dom";
import { describePublication, type DblpOutcome } from "./dblp";
import {
  addAsRelated,
  addNoteAndTag,
  DBLP_SPACING_MS,
  itemsToCheck,
  PUBLISHED_TAG,
  searchPublishedVersion,
  updateToPublished,
  type CheckScope,
  type PublishedAction,
} from "./publishedVersions";

const MENU_ID = `${config.addonRef}-find-published`;
const REPORT_URL = `chrome://${config.addonRef}/content/published.xhtml`;

/** Add the menu entry to a main window's collection context menu. */
export function registerCollectionMenu(win: _ZoteroTypes.MainWindow) {
  const doc = win.document;
  const menu = doc.getElementById("zotero-collectionmenu");
  if (!menu || doc.getElementById(MENU_ID)) return;
  const item = doc.createXULElement("menuitem");
  item.id = MENU_ID;
  item.setAttribute("label", "Pinakes: find published versions…");
  item.addEventListener("command", () => {
    const collection = win.ZoteroPane.getSelectedCollection();
    if (collection) void openReport(win, collection);
  });
  // Only for collections, not libraries, feeds or saved searches.
  menu.addEventListener("popupshowing", onPopupShowing);
  menu.append(item);
}

function onPopupShowing(event: Event) {
  const menu = event.currentTarget as Element;
  if (event.target !== menu) return;
  const doc = menu.ownerDocument!;
  const win = doc.defaultView as unknown as _ZoteroTypes.MainWindow;
  const item = doc.getElementById(MENU_ID) as XULElement | null;
  if (item) item.hidden = !win.ZoteroPane.getSelectedCollection();
}

export function unregisterCollectionMenu(win: Window) {
  const doc = win.document;
  doc.getElementById(MENU_ID)?.remove();
  doc
    .getElementById("zotero-collectionmenu")
    ?.removeEventListener("popupshowing", onPopupShowing);
}

// ---------------------------------------------------------------------------
// Report window
// ---------------------------------------------------------------------------

interface Row {
  item: Zotero.Item;
  outcome?: DblpOutcome;
  el: HTMLElement;
}

interface Report {
  win: Window;
  doc: Document;
  collection: Zotero.Collection;
  rows: Row[];
  /** Set while checking; cancelled when the window closes. */
  run?: { cancelled: boolean };
  applying: boolean;
}

const ACTIONS: Array<[PublishedAction, string]> = [
  ["note", `Add a note and the tag "${PUBLISHED_TAG}"`],
  ["related", "Import the published version as a related item"],
  [
    "update",
    "Update the item to the published version (keeps attachments and notes)",
  ],
];

const CONFIRM: Record<PublishedAction, string> = {
  note: `Add a note and the tag "${PUBLISHED_TAG}" to {n}?`,
  related:
    "Import the published version of {n} into this collection and relate it to the original? Versions already in the library (same DOI) are reused.",
  update:
    "Update {n} to the published version? The item type, fields and authors are replaced with the published metadata. Attachments, notes, tags and collections are kept, the arXiv ID is kept in Extra, and a note records the previous metadata.",
};

/** Open the report for a collection; resolves once it is shown. */
export async function openReport(
  mainWin: Window,
  collection: Zotero.Collection,
) {
  const win = (mainWin as any).openDialog(
    REPORT_URL,
    "",
    "chrome,dialog=no,centerscreen,resizable,width=900,height=640",
  ) as Window;
  // The window starts on about:blank; wait for the report document.
  while (
    win.document.documentURI !== REPORT_URL ||
    win.document.readyState !== "complete"
  ) {
    if (win.closed) throw new Error("The report window was closed.");
    await Zotero.Promise.delay(20);
  }
  const report: Report = {
    win,
    doc: win.document,
    collection,
    rows: [],
    applying: false,
  };
  win.addEventListener("unload", () => {
    if (report.run) report.run.cancelled = true;
  });
  render(report);
  return report;
}

function $<T extends Element = HTMLElement>(report: Report, sel: string) {
  return report.doc.querySelector(sel) as T;
}

function render(report: Report) {
  const { doc, collection } = report;
  doc.title = `Published versions: ${collection.name}`;

  const scope = h(doc, "select", "pinakes-scope");
  for (const [value, label] of [
    ["preprints", "Preprints and items without a venue"],
    ["all", "All items"],
  ]) {
    const option = h(doc, "option", undefined, label);
    option.value = value;
    scope.append(option);
  }
  const count = h(doc, "span", "pinakes-count");
  const updateCount = () => {
    const n = itemsToCheck(collection, scope.value as CheckScope).length;
    count.textContent = `${n} ${n === 1 ? "item" : "items"}`;
    check.disabled = !n || !!report.run;
  };
  scope.addEventListener("change", updateCount);
  const check = button(
    doc,
    "Check in DBLP",
    () => void runCheck(report, scope.value as CheckScope),
  );
  check.classList.add("pinakes-check-button");

  const progress = h(doc, "div", "pinakes-progress");
  progress.append(
    h(doc, "progress", "pinakes-progress-bar"),
    h(doc, "span", "pinakes-progress-text"),
    button(doc, "Cancel", () => {
      if (report.run) report.run.cancelled = true;
    }),
  );
  progress.hidden = true;

  const action = h(doc, "select", "pinakes-action");
  for (const [value, label] of ACTIONS) {
    const option = h(doc, "option", undefined, label);
    option.value = value;
    action.append(option);
  }
  const apply = button(
    doc,
    "Apply to selected",
    () => void applyAction(report, action.value as PublishedAction),
    "pinakes-button pinakes-apply",
  );
  const footer = h(doc, "div", "pinakes-dialog-footer");
  footer.append(action, apply);
  footer.hidden = true;

  const header = h(doc, "div", "pinakes-dialog-header");
  header.append(
    h(doc, "h1", "", `Find published versions: ${collection.name}`),
    h(
      doc,
      "p",
      "pinakes-insights-note",
      "Searches dblp.org by title, one request at a time, and accepts only clear matches (same title, plausible year, shared authors). DBLP covers computer science only. Nothing is changed until you apply an action.",
    ),
  );
  const controls = h(doc, "div", "pinakes-toolbar");
  controls.append(h(doc, "span", "", "Check:"), scope, count, check);

  doc.body!.replaceChildren(
    header,
    controls,
    progress,
    h(doc, "div", "pinakes-status pinakes-status-none"),
    h(doc, "ol", "pinakes-list pinakes-report"),
    footer,
  );
  updateCount();
}

function setStatus(report: Report, kind: "info" | "error", message: string) {
  const status = $(report, ".pinakes-status");
  status.className = `pinakes-status pinakes-status-${kind}`;
  status.textContent = message;
}

async function runCheck(report: Report, scope: CheckScope) {
  if (report.run || report.applying) return;
  const items = itemsToCheck(report.collection, scope);
  const run = { cancelled: false };
  report.run = run;
  report.rows = items.map((item) => ({ item, el: renderRow(report, item) }));
  $(report, ".pinakes-report").replaceChildren(...report.rows.map((r) => r.el));
  $<HTMLButtonElement>(report, ".pinakes-check-button").disabled = true;
  $(report, ".pinakes-dialog-footer").hidden = true;
  const progress = $(report, ".pinakes-progress");
  progress.hidden = false;
  const bar = progress.querySelector("progress")!;
  bar.max = items.length;

  let done = 0;
  for (const row of report.rows) {
    if (run.cancelled) break;
    bar.value = done;
    progress.querySelector(".pinakes-progress-text")!.textContent =
      `Checking ${done + 1} of ${items.length}…`;
    const started = Date.now();
    try {
      row.outcome = await searchPublishedVersion(row.item, (message) => {
        progress.querySelector(".pinakes-progress-text")!.textContent = message;
      });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(`DBLP search failed for item ${row.item.id}`, e);
      row.outcome = { kind: "none", reason: `Error: ${message}` };
    }
    done++;
    updateRow(report, row);
    // Be gentle with DBLP: at most one request every DBLP_SPACING_MS.
    const wait = DBLP_SPACING_MS - (Date.now() - started);
    if (wait > 0 && done < items.length) await Zotero.Promise.delay(wait);
  }
  if (report.win.closed) return;
  report.run = undefined;
  progress.hidden = true;
  $<HTMLButtonElement>(report, ".pinakes-check-button").disabled = false;
  const found = report.rows.filter((r) => r.outcome?.kind === "found").length;
  setStatus(
    report,
    "info",
    `Checked ${done} of ${items.length}${run.cancelled ? " (cancelled)" : ""}: ${found} with a published version.`,
  );
  $(report, ".pinakes-dialog-footer").hidden = !found;
  updateApply(report);
}

function itemLine(item: Zotero.Item) {
  const date = item.getField("date") as string;
  const year = date ? Zotero.Date.strToDate(date).year : "";
  return [item.getDisplayTitle(), year].filter(Boolean).join(", ");
}

function renderRow(report: Report, item: Zotero.Item) {
  const { doc } = report;
  const li = h(doc, "li", "pinakes-row");
  const main = h(doc, "div", "pinakes-row-main");
  const check = h(doc, "input", "pinakes-check");
  check.type = "checkbox";
  check.disabled = true;
  check.style.visibility = "hidden";
  check.addEventListener("change", () => updateApply(report));
  const text = h(doc, "div", "pinakes-text");
  text.append(
    h(doc, "div", "pinakes-title", itemLine(item)),
    h(doc, "div", "pinakes-meta pinakes-result", "Waiting…"),
  );
  main.append(check, text);
  li.append(main);
  return li;
}

function updateRow(report: Report, row: Row) {
  const { doc } = report;
  const result = row.el.querySelector(".pinakes-result")!;
  const check = row.el.querySelector<HTMLInputElement>(".pinakes-check")!;
  const outcome = row.outcome;
  result.replaceChildren();
  if (!outcome) return;
  if (outcome.kind === "none") {
    result.textContent = outcome.reason;
    return;
  }
  const pub = outcome.match;
  const label =
    outcome.kind === "found"
      ? "Published: "
      : "Already the published version: ";
  const open = h(doc, "a", "pinakes-link", describePublication(pub));
  open.href = pub.url;
  open.title = `${pub.title} (${pub.key})`;
  open.addEventListener("click", (e) => {
    e.preventDefault();
    Zotero.launchURL(pub.url);
  });
  result.append(label, open);
  if (pub.doi) result.append(` · DOI ${pub.doi}`);
  if (outcome.kind === "found") {
    if (outcome.others.length) {
      result.append(
        ` · also: ${outcome.others.map(describePublication).join("; ")}`,
      );
    }
    row.el.classList.add("pinakes-found");
    check.disabled = false;
    check.checked = true;
    check.style.visibility = "";
  }
}

function selectedRows(report: Report) {
  return report.rows.filter(
    (r) =>
      r.outcome?.kind === "found" &&
      r.el.querySelector<HTMLInputElement>(".pinakes-check")!.checked,
  );
}

function updateApply(report: Report) {
  const n = selectedRows(report).length;
  const apply = $<HTMLButtonElement>(report, ".pinakes-apply");
  apply.textContent = `Apply to selected (${n})`;
  apply.disabled = !n || report.applying || !!report.run;
}

async function applyAction(report: Report, action: PublishedAction) {
  const rows = selectedRows(report);
  if (!rows.length || report.applying || report.run) return;
  const library = Zotero.Libraries.get(report.collection.libraryID);
  if (library && !library.editable) {
    setStatus(report, "error", `"${library.name}" is read-only.`);
    return;
  }
  const what = rows.length === 1 ? "1 item" : `${rows.length} items`;
  const ok = Services.prompt.confirm(
    report.win as any,
    config.addonName,
    CONFIRM[action].replace("{n}", what),
  );
  if (!ok) return;

  report.applying = true;
  updateApply(report);
  let failed = 0;
  for (const row of rows) {
    if (report.win.closed) return;
    if (row.outcome?.kind !== "found") continue;
    const pub = row.outcome.match;
    const check = row.el.querySelector<HTMLInputElement>(".pinakes-check")!;
    const note = h(report.doc, "div", "pinakes-row-note");
    try {
      if (action === "note") {
        await addNoteAndTag(row.item, pub);
        note.textContent = "Note and tag added.";
      } else if (action === "related") {
        const published = await addAsRelated(
          row.item,
          pub,
          report.collection.id,
        );
        note.textContent = `Related to item "${published.getDisplayTitle()}".`;
      } else {
        await updateToPublished(row.item, pub);
        note.textContent = "Updated to the published version.";
      }
      check.checked = false;
    } catch (e) {
      failed++;
      log(`Action ${action} failed for item ${row.item.id}`, e);
      note.className = "pinakes-row-error";
      note.textContent = `Failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    row.el.querySelector(".pinakes-row-note, .pinakes-row-error")?.remove();
    row.el.querySelector(".pinakes-text")!.append(note);
  }
  report.applying = false;
  updateApply(report);
  setStatus(
    report,
    failed ? "error" : "info",
    `Applied to ${rows.length - failed} of ${rows.length}${failed ? `; ${failed} failed` : ""}.`,
  );
}
