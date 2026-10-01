/**
 * Integration tests, run inside a throwaway Zotero profile by
 * `npm run test:zotero`. They need network access (Semantic Scholar,
 * OpenAlex and the DOI/arXiv translators).
 */
import { assert } from "chai";
import { config } from "../../package.json";
import { importReference, resolveTarget } from "../../src/modules/importer";
import { findInLibrary, getPaperId } from "../../src/modules/library";
import { referencesFromPdf } from "../../src/modules/pdf";
import { fetchReferences } from "../../src/modules/sources";
import type { Reference } from "../../src/modules/types";

const PREF = `${config.prefsPrefix}.targetMode`;
const ACM_DOI = "10.1145/3292500.3330701"; // Optuna, KDD 2019

async function createGroup(name: string) {
  // Zotero.Group's typings mark these as read-only; tests set them directly.
  const group = new Zotero.Group() as any;
  group.id = 900000 + Math.floor(Math.random() * 99999);
  group.name = name;
  group.description = "";
  group.editable = true;
  group.filesEditable = true;
  group.version = 0;
  await group.saveTx();
  return group as Zotero.Group;
}

async function createCollection(libraryID: number, name: string) {
  const collection = new Zotero.Collection({ libraryID, name });
  await collection.saveTx();
  return collection;
}

async function selectCollection(collection: Zotero.Collection) {
  const pane = Zotero.getMainWindow().ZoteroPane as any;
  await pane.collectionsView.selectCollection(collection.id);
}

async function selectLibrary(libraryID: number) {
  const pane = Zotero.getMainWindow().ZoteroPane as any;
  await pane.collectionsView.selectLibrary(libraryID);
}

function reference(over: Partial<Reference>): Reference {
  return {
    index: 1,
    title: "Untitled",
    authors: ["Ada Lovelace"],
    kind: "journal",
    ...over,
  };
}

describe("startup", function () {
  it("exposes the plugin instance", function () {
    assert.isOk((Zotero as any)[config.addonInstance]?.data.initialized);
  });
});

describe("getPaperId", function () {
  it("prefers the DOI field, then arXiv sources", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("DOI", `https://doi.org/${ACM_DOI.toUpperCase()}`);
    item.setField("url", "https://arxiv.org/abs/1907.10902");
    assert.deepEqual(getPaperId(item), { kind: "DOI", value: ACM_DOI });

    const preprint = new Zotero.Item("preprint");
    preprint.setField("archiveID", "arXiv:1706.03762");
    assert.deepEqual(getPaperId(preprint), {
      kind: "arXiv",
      value: "1706.03762",
    });

    const viaExtra = new Zotero.Item("journalArticle");
    viaExtra.setField("extra", "arXiv: 1706.03762v5");
    assert.deepEqual(getPaperId(viaExtra), {
      kind: "arXiv",
      value: "1706.03762",
    });

    assert.isUndefined(getPaperId(new Zotero.Item("journalArticle")));
  });
});

describe("resolveTarget", function () {
  it("supports the three target modes", async function () {
    const group = await createGroup("Pinakes target test");
    const selected = await createCollection(group.libraryID, "Selected");
    const parent = await createCollection(group.libraryID, "Parent");
    const citing = new Zotero.Item("journalArticle");
    citing.libraryID = group.libraryID;
    citing.setCollections([parent.id]);
    await citing.saveTx();
    const personal = new Zotero.Item("journalArticle");
    await personal.saveTx();

    // "selected": the collection selected in the main window wins, even if
    // it is in another library than the citing item.
    await selectCollection(selected);
    let target = resolveTarget(personal, "selected");
    assert.equal(target.libraryID, group.libraryID);
    assert.equal(target.collectionID, selected.id);

    // No collection selected: the citing item's library root.
    await selectLibrary(Zotero.Libraries.userLibraryID);
    target = resolveTarget(citing, "selected");
    assert.equal(target.libraryID, group.libraryID);
    assert.isUndefined(target.collectionID);

    target = resolveTarget(citing, "parent");
    assert.equal(target.collectionID, parent.id);
    target = resolveTarget(personal, "parent");
    assert.equal(target.libraryID, Zotero.Libraries.userLibraryID);
    assert.isUndefined(target.collectionID);

    await selectCollection(selected);
    target = resolveTarget(citing, "root");
    assert.equal(target.libraryID, group.libraryID);
    assert.isUndefined(target.collectionID);
  });
});

describe("importReference into a group collection", function () {
  let group: Zotero.Group;
  let collection: Zotero.Collection;

  before(async function () {
    group = await createGroup("Pinakes import test");
    collection = await createCollection(group.libraryID, "Imports");
  });

  const target = () => ({
    libraryID: group.libraryID,
    collectionID: collection.id,
    label: "test",
  });

  function assertInGroup(item: Zotero.Item) {
    assert.equal(
      item.libraryID,
      group.libraryID,
      "item is in the group library",
    );
    assert.include(
      item.getCollections(),
      collection.id,
      "item is in the collection",
    );
  }

  it("imports by DOI (ACM)", async function () {
    const { item, method } = await importReference(
      reference({ title: "Optuna", doi: ACM_DOI }),
      target(),
    );
    assert.equal(method, "DOI");
    assertInGroup(item);
    assert.match(item.getField("title") as string, /Optuna/i);
  });

  it("imports by arXiv ID", async function () {
    const { item, method } = await importReference(
      reference({ title: "Attention", arxiv: "1706.03762", kind: "preprint" }),
      target(),
    );
    assert.equal(method, "arXiv");
    assertInGroup(item);
  });

  it("creates an item from metadata when there is no identifier", async function () {
    const { item, method } = await importReference(
      reference({
        title: "A paper without identifiers about catalogues",
        authors: ["Callimachus of Cyrene"],
        year: 2001,
        venue: "Journal of Alexandrian Studies",
      }),
      target(),
    );
    assert.equal(method, "metadata");
    assertInGroup(item);
    assert.equal(item.itemType, "journalArticle");
    assert.equal(
      item.getField("publicationTitle"),
      "Journal of Alexandrian Studies",
    );
    assert.equal(item.getCreators()[0].lastName, "Cyrene");
  });

  it("marks imported references as in library", async function () {
    const matches = await findInLibrary(group.libraryID, [
      reference({ index: 1, doi: ACM_DOI }),
      reference({ index: 2, arxiv: "1706.03762" }),
      reference({
        index: 3,
        title: "A Paper Without Identifiers About Catalogues!",
      }),
      reference({
        index: 4,
        title: "Something that is certainly not in the library",
      }),
    ]);
    assert.isOk(matches.get(1), "matched by DOI");
    assert.isOk(matches.get(2), "matched by arXiv ID");
    assert.isOk(matches.get(3), "matched by title");
    assert.isUndefined(matches.get(4));
  });
});

describe("fetchReferences", function () {
  it("fetches references for an ACM DOI", async function () {
    const list = await fetchReferences(
      { kind: "DOI", value: ACM_DOI },
      () => {},
    );
    assert.isAbove(list.references.length, 10);
    assert.isOk(list.references[0].title);
  });

  it("fetches references for an arXiv-only paper", async function () {
    const list = await fetchReferences(
      { kind: "arXiv", value: "1706.03762" },
      () => {},
    );
    assert.isAbove(list.references.length, 10);
  });
});

describe("item pane section", function () {
  let collection: Zotero.Collection;
  let win: _ZoteroTypes.MainWindow;

  before(async function () {
    // A personal-library collection: selecting items of a group created in
    // the test profile freezes headless Zotero (independent of the plugin).
    // Group imports are covered above through the same importReference().
    collection = await createCollection(
      Zotero.Libraries.userLibraryID,
      "Section",
    );
    win = Zotero.getMainWindow();
    Zotero.Prefs.set(PREF, "parent", true);
  });

  after(function () {
    Zotero.Prefs.set(PREF, "selected", true);
  });

  // Failures in this suite may carry non-ASCII text (labels contain "›" and
  // "…"), which the scaffold reporter cannot transmit; log them as well.
  afterEach(async function () {
    const test = this.currentTest;
    if (test?.state === "failed") {
      Zotero.debug(`[Pinakes test] ${test.title}: ${test.err?.message}`);
    }
  });

  async function waitFor<T>(
    fn: () => T | undefined | null | false,
    what: string,
  ) {
    for (let i = 0; i < 120; i++) {
      const value = fn();
      if (value) return value;
      await Zotero.Promise.delay(250);
    }
    const status = $(".pinakes-status")?.textContent ?? "";
    // ASCII only: the scaffold reporter hangs on non-ASCII messages.
    throw new Error(
      `Timed out waiting for ${what} (status: ${encodeURIComponent(status)})`,
    );
  }

  // The main item pane's Pinakes section (the reader context pane has its own).
  const section = () =>
    (
      Array.from(
        win.document.querySelectorAll("#zotero-item-pane [data-pane]"),
      ) as Element[]
    ).find((el) => el.getAttribute("data-pane")?.endsWith("-references"))!;
  const $ = (sel: string) => section().querySelector(sel) as HTMLElement | null;
  const rows = () =>
    Array.from(section().querySelectorAll(".pinakes-row")) as HTMLElement[];
  const shownRows = () => rows().filter((r) => !r.hidden);
  const click = (selector: string) => $(selector)!.click();

  it("loads the list without scrolling, filters and batch-imports", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Optuna");
    item.setField("DOI", ACM_DOI);
    item.setCollections([collection.id]);
    await item.saveTx();
    await selectCollection(collection);
    await win.ZoteroPane.selectItem(item.id);

    // Eager loading: rows appear although the section was never scrolled to.
    await waitFor(() => rows().length > 10, "rows");
    const first = rows()[0];
    assert.isOk(first.querySelector(".pinakes-title")?.textContent);
    const labels = (
      Array.from(first.querySelectorAll("button")) as Element[]
    ).map((b) => b.textContent);
    assert.includeMembers(labels, ["Copy DOI", "Open"]);
    // Keep assertion messages ASCII: the scaffold reporter hangs on others.
    const label = $(".pinakes-target")?.textContent;
    assert.isTrue(
      label === "Import to: My Library \u203a Section",
      `target label: ${encodeURIComponent(label ?? "")}`,
    );

    // Filter on the first two titles' distinctive words: only matching rows stay.
    const titles = rows()
      .slice(0, 2)
      .map((r) => r.querySelector(".pinakes-title")!.textContent!);
    const filter = $(".pinakes-filter") as HTMLInputElement;
    filter.value = titles[0];
    filter.dispatchEvent(new win.Event("input"));
    assert.isAtLeast(shownRows().length, 1);
    assert.isBelow(shownRows().length, rows().length);
    assert.match($(".pinakes-count")?.textContent ?? "", / of /);

    // Import all shown, then clear the filter.
    const before = collection.getChildItems().length;
    click(".pinakes-import-all");
    await waitFor(
      () =>
        $(".pinakes-progress")?.hidden &&
        /Imported/.test($(".pinakes-status")?.textContent ?? ""),
      "batch to finish",
    );
    assert.isTrue(
      /Imported \d+ of \d+/.test($(".pinakes-status")!.textContent!),
    );
    assert.isAbove(collection.getChildItems().length, before);
    for (const child of collection.getChildItems()) {
      assert.equal(child.libraryID, Zotero.Libraries.userLibraryID);
    }
    assert.isOk(shownRows()[0].querySelector(".pinakes-in-library"));

    filter.value = "";
    filter.dispatchEvent(new win.Event("input"));
    assert.equal(shownRows().length, rows().length);

    // Multi-select with shift-click, then "Import selected".
    const candidates = rows().filter((r) => r.querySelector(".pinakes-import"));
    const a = candidates[0].querySelector(".pinakes-check") as HTMLInputElement;
    const b = candidates[1].querySelector(".pinakes-check") as HTMLInputElement;
    a.click();
    b.dispatchEvent(
      new win.MouseEvent("click", { shiftKey: true, bubbles: true }),
    );
    const button = $(".pinakes-import-selected")!;
    assert.match(button.textContent!, /Import selected \(\d+\)/);
    assert.notEqual(button.textContent, "Import selected (0)");
    const count = collection.getChildItems().length;
    (button as HTMLElement).click();
    await waitFor(
      () =>
        $(".pinakes-progress")?.hidden &&
        collection.getChildItems().length > count,
      "selected import",
    );
  });
});

describe("PDF fallback", function () {
  let item: Zotero.Item;

  before(async function () {
    this.timeout(120_000);
    // Optuna's arXiv PDF: 29 bracketed references.
    const xhr = await Zotero.HTTP.request(
      "GET",
      "https://arxiv.org/pdf/1907.10902v1",
      { responseType: "arraybuffer" },
    );
    const path = PathUtils.join(PathUtils.tempDir, "pinakes-test-optuna.pdf");
    await IOUtils.write(path, new Uint8Array(xhr.response as ArrayBuffer));
    item = new Zotero.Item("journalArticle");
    item.setField("title", "A paper whose identifier is unknown");
    await item.saveTx();
    await Zotero.Attachments.importFromFile({
      file: path,
      parentItemID: item.id,
    });
  });

  it("extracts and resolves the bibliography", async function () {
    this.timeout(300_000);
    const notes: string[] = [];
    const list = await referencesFromPdf(
      item,
      undefined,
      notes,
      () => {},
      () => false,
    );
    assert.equal(list.source, "pdf");
    assert.isAtLeast(list.references.length, 25);
    assert.equal(list.references[0].label, "1");
    assert.match(list.references[0].raw!, /Hyperopt/);
    const resolved = list.references.filter((r) => r.doi && !r.unresolved);
    assert.isAtLeast(resolved.length, 5, "some entries resolved via Crossref");
    assert.isTrue(
      /Extracted \d+ references from the PDF/.test(notes.join(" ")),
    );
  });

  it("offers the PDF in the library view and lists the entries", async function () {
    this.timeout(300_000);
    const win = Zotero.getMainWindow();
    await (win.ZoteroPane as any).collectionsView.selectLibrary(
      Zotero.Libraries.userLibraryID,
    );
    await win.ZoteroPane.selectItem(item.id);
    const section = () =>
      (
        Array.from(
          win.document.querySelectorAll("#zotero-item-pane [data-pane]"),
        ) as Element[]
      ).find((el) => el.getAttribute("data-pane")?.endsWith("-references"))!;
    const find = (sel: string) =>
      section().querySelector(sel) as HTMLElement | null;
    const waitFor = async (fn: () => unknown, what: string, tries = 1000) => {
      for (let i = 0; i < tries; i++) {
        if (fn()) return;
        await Zotero.Promise.delay(250);
      }
      throw new Error(`Timed out waiting for ${what}`);
    };
    await waitFor(
      () => find(".pinakes-status button"),
      "the read-from-PDF button",
      40,
    );
    find(".pinakes-status button")!.click();
    await waitFor(
      () => section().querySelectorAll(".pinakes-row").length > 20,
      "rows",
    );
    assert.equal(find(".pinakes-num")!.textContent, "1");
    assert.isTrue(/from the PDF/.test(find(".pinakes-source")!.textContent!));
  });

  it("shows a reference card when hovering a citation marker in the reader", async function () {
    this.timeout(180_000);
    const pref = `${config.prefsPrefix}.citationPopups`;
    Zotero.Prefs.set(pref, true, true);
    try {
      const attachmentID = item.getAttachments()[0];
      const reader: any = await (Zotero as any).Reader.open(attachmentID);
      await reader._initPromise;

      // PDF.js re-renders text layers while loading, so look the marker up
      // again on every attempt rather than keeping a reference to it.
      const findMarker = () => {
        const doc: Document | undefined =
          reader._internalReader?._primaryView?._iframeWindow?.document;
        const span = (
          Array.from(
            doc?.querySelectorAll(".textLayer span") ?? [],
          ) as Element[]
        ).find((s) => /\[\d{1,2}\]/.test(s.firstChild?.textContent ?? ""));
        if (!doc || !span) return undefined;
        // Hit-testing only works inside the visible viewport.
        const viewport = doc.defaultView!.innerHeight;
        const box = span.getBoundingClientRect();
        if (box.top < 0 || box.bottom > viewport) {
          span.scrollIntoView({ block: "center" });
          return undefined;
        }
        const textNode = span.firstChild!;
        const at = (textNode.textContent ?? "").search(/\[\d/) + 1;
        const range = doc.createRange();
        range.setStart(textNode, at);
        range.setEnd(textNode, at + 1);
        const label = (textNode.textContent ?? "").slice(at).match(/^\d+/)![0];
        return { doc, rect: range.getBoundingClientRect(), label };
      };

      // Real mouse events cannot be delivered to the reader's view in the
      // headless test profile, so run the plugin's hover handler directly
      // at the marker's position.
      const plugin = (Zotero as any)[config.addonInstance];
      let popup: Element | null = null;
      let label = "";
      for (let i = 0; i < 120 && !popup; i++) {
        await Zotero.Promise.delay(500);
        const marker = findMarker();
        if (!marker) continue;
        label = marker.label;
        await plugin.testHooks.hoverForTest(
          reader.tabID,
          marker.rect.left + marker.rect.width / 2,
          marker.rect.top + marker.rect.height / 2,
        );
        popup = marker.doc.querySelector(".pinakes-citation-popup");
      }
      assert.isOk(popup, "popup shown");
      assert.isTrue(
        popup!.textContent!.includes(`[${label}]`),
        `popup for [${label}]`,
      );
    } finally {
      Zotero.Prefs.set(pref, false, true);
    }
  });
});
