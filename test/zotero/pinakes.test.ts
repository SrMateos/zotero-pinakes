/**
 * Integration tests, run inside a throwaway Zotero profile by
 * `npm run test:zotero`. They need network access (Semantic Scholar,
 * OpenAlex and the DOI/arXiv translators).
 */
import { assert } from "chai";
import { config } from "../../package.json";
import { importReference, resolveTarget } from "../../src/modules/importer";
import { findInLibrary, getPaperId } from "../../src/modules/library";
import { fetchReferences } from "../../src/modules/sources";
import type { Reference } from "../../src/modules/types";

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
  it("uses the selected collection, else the item's library", async function () {
    const group = await createGroup("Pinakes target test");
    const collection = await createCollection(group.libraryID, "Target");
    await selectCollection(collection);
    const target = resolveTarget(Zotero.Libraries.userLibraryID);
    assert.equal(target.libraryID, group.libraryID);
    assert.equal(target.collectionID, collection.id);

    await selectLibrary(Zotero.Libraries.userLibraryID);
    const fallback = resolveTarget(group.libraryID);
    assert.equal(fallback.libraryID, group.libraryID);
    assert.isUndefined(fallback.collectionID);
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
  it("renders reference rows for the selected item", async function () {
    const item = new Zotero.Item("journalArticle");
    item.setField("title", "Optuna");
    item.setField("DOI", ACM_DOI);
    await item.saveTx();
    const win = Zotero.getMainWindow();
    await selectLibrary(Zotero.Libraries.userLibraryID);
    await win.ZoteroPane.selectItem(item.id);
    // Sections load lazily, when scrolled into view.
    const details = win.document.querySelector(
      "#zotero-item-pane item-details",
    ) as any;
    const panes = Array.from(
      win.document.querySelectorAll("#zotero-item-pane [data-pane]"),
    ) as Element[];
    const pane = panes.find((el) =>
      el.getAttribute("data-pane")?.endsWith("-references"),
    );
    await details.scrollToPane(pane!.getAttribute("data-pane"), "instant");

    let rows: NodeListOf<Element> | undefined;
    for (let i = 0; i < 60; i++) {
      rows = win.document.querySelectorAll(".pinakes-row");
      if (rows.length) break;
      await Zotero.Promise.delay(500);
    }
    const status = win.document.querySelector(".pinakes-status")?.textContent;
    assert.isAbove(rows!.length, 10, `rows rendered (status: ${status})`);
    const first = rows![0];
    assert.isOk(first.querySelector(".pinakes-title")?.textContent);
    const buttons = Array.from(first.querySelectorAll("button")) as Element[];
    const labels = buttons.map((b) => b.textContent);
    assert.includeMembers(labels, ["Copy DOI", "Open"]);
    assert.isTrue(
      labels.includes("Import") || labels.includes("In library"),
      `row actions: ${labels.join(", ")}`,
    );
    const target = win.document.querySelector(".pinakes-target")?.textContent;
    assert.match(target ?? "", /^Import to: /);
  });
});
