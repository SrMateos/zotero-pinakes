/**
 * The "Pinakes: find published versions" entry of the item context menu,
 * and its report window: check the selected items in DBLP one at a time,
 * list what was found, and update the selected items only after the user
 * confirms.
 */
import { config } from "../../package.json";
import { log } from "../utils/log";
import { button, h } from "./dom";
import { describePublication, type DblpOutcome } from "./dblp";
import {
  addPublishedFullText,
  checkableItems,
  DBLP_SPACING_MS,
  searchPublishedVersion,
  updateToPublished,
  type FullTextOutcome,
} from "./publishedVersions";

const MENU_ID = `${config.addonRef}-find-published`;
const REPORT_URL = `chrome://${config.addonRef}/content/published.xhtml`;
const MENU_ICON = `chrome://${config.addonRef}/content/icons/pinakes-menu.svg`;
const MENU_DARK_ICON = `chrome://${config.addonRef}/content/icons/pinakes-menu-dark.svg`;

/** Add the menu entry to the item context menu, for the selected items. */
export function registerItemMenu() {
  Zotero.MenuManager.registerMenu({
    menuID: MENU_ID,
    pluginID: config.addonID,
    target: "main/library/item",
    menus: [
      {
        menuType: "menuitem",
        l10nID: "pinakes-find-published",
        icon: MENU_ICON,
        darkIcon: MENU_DARK_ICON,
        // Only papers: attachments, notes and annotations stand for their
        // parent, and a selection without a regular item has nothing to check.
        onShowing: (_event, context) => {
          context.setVisible(checkableItems(context.items ?? []).length > 0);
        },
        onCommand: (_event, context) => {
          const items = checkableItems(context.items ?? []);
          const win = Zotero.getMainWindow();
          if (items.length && win) void openReport(win, items);
        },
      },
    ],
  });
}

export function unregisterItemMenu() {
  Zotero.MenuManager.unregisterMenu(MENU_ID);
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
  items: Zotero.Item[];
  rows: Row[];
  /** Set while checking; cancelled when the window closes. */
  run?: { cancelled: boolean };
  applying: boolean;
}

const CONFIRM =
  "Update {n} to the published version? Item type, fields and authors are replaced with the published metadata. Attachments, notes, tags and collections are kept, the arXiv ID is kept in Extra, and a note records the previous metadata. If the published version is already in the library, the two are merged. Then the published full text is looked up, as Find Full Text does; a PDF you have and its annotations are never replaced by a different document.";

/** What to say after the full-text lookup, per outcome. */
const FULL_TEXT: Record<FullTextOutcome, string> = {
  added: "Published full text added.",
  replaced:
    "Published full text added; the annotations of the previous PDF were moved to it.",
  same: "The published full text is the PDF already attached.",
  kept: "Published full text added next to the previous PDF, which was kept (different document).",
  none: "No published full text found.",
};

/** Open the report for the selected items; resolves once it is shown. */
export async function openReport(mainWin: Window, items: Zotero.Item[]) {
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
    items,
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
  const { doc, items } = report;
  doc.title = "Published versions";

  const count = h(
    doc,
    "span",
    "pinakes-count",
    `${items.length} ${items.length === 1 ? "item" : "items"}`,
  );
  const check = button(doc, "Check in DBLP", () => void runCheck(report));
  check.classList.add("pinakes-check-button");
  check.disabled = !items.length || !!report.run;

  const progress = h(doc, "div", "pinakes-progress");
  progress.append(
    h(doc, "progress", "pinakes-progress-bar"),
    h(doc, "span", "pinakes-progress-text"),
    button(doc, "Cancel", () => {
      if (report.run) report.run.cancelled = true;
    }),
  );
  progress.hidden = true;

  const apply = button(
    doc,
    "Update selected",
    () => void applyAction(report),
    "pinakes-button pinakes-apply",
  );
  const footer = h(doc, "div", "pinakes-dialog-footer");
  footer.append(apply);
  footer.hidden = true;

  const header = h(doc, "div", "pinakes-dialog-header");
  header.append(
    h(doc, "h1", "", "Find published versions"),
    h(
      doc,
      "p",
      "pinakes-insights-note",
      "Searches dblp.org by the title of each selected item, one request at a time, and accepts only clear matches (same title, plausible year, shared authors). DBLP covers computer science only. Nothing is changed until you press Update selected and confirm; if the published version is already in the library, the two are merged, and the published full text is then looked up as Find Full Text does, keeping the annotations of any PDF you have.",
    ),
  );
  const controls = h(doc, "div", "pinakes-toolbar");
  controls.append(h(doc, "span", "", "Check:"), count, check);

  doc.body!.replaceChildren(
    header,
    controls,
    progress,
    h(doc, "div", "pinakes-status pinakes-status-none"),
    h(doc, "ol", "pinakes-list pinakes-report"),
    footer,
  );
}

function setStatus(report: Report, kind: "info" | "error", message: string) {
  const status = $(report, ".pinakes-status");
  status.className = `pinakes-status pinakes-status-${kind}`;
  status.textContent = message;
}

async function runCheck(report: Report) {
  if (report.run || report.applying) return;
  const items = report.items;
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
  apply.textContent = `Update selected (${n})`;
  apply.disabled = !n || report.applying || !!report.run;
}

async function applyAction(report: Report) {
  const rows = selectedRows(report);
  if (!rows.length || report.applying || report.run) return;
  const what = rows.length === 1 ? "1 item" : `${rows.length} items`;
  const ok = Services.prompt.confirm(
    report.win as any,
    config.addonName,
    CONFIRM.replace("{n}", what),
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
    const library = Zotero.Libraries.get(row.item.libraryID);
    try {
      if (library && !library.editable) {
        throw new Error(`"${library.name}" is read-only.`);
      }
      const merged = await updateToPublished(row.item, pub);
      const updated = merged
        ? "Updated to the published version; the duplicate was merged."
        : "Updated to the published version.";
      note.textContent = `${updated} Looking for the published full text…`;
      check.checked = false;
      const fullText = await addPublishedFullText(row.item);
      note.textContent = `${updated} ${FULL_TEXT[fullText]}`;
    } catch (e) {
      failed++;
      log(`Update failed for item ${row.item.id}`, e);
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
