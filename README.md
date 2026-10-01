# Pinakes for Zotero

Pinakes is a Zotero 7+ plugin that shows the **reference list of the paper
you are reading** in a side-pane section. You can import any cited work into
your library in one click, the same way Zotero's "Add Item by Identifier"
does.

It is a from-scratch, readable reimplementation of the core features of
"Zotero Reference". No code was taken from that project.

## The name

The _Pinakes_ (Πίνακες, "tables") was the catalogue of the Library of
Alexandria, compiled by Callimachus of Cyrene in the 3rd century BC. It is
often called the first library catalogue. This plugin shows the catalogue of
the works a paper cites.

## What it does

- Adds a **Pinakes** section to the item pane. It shows in the PDF reader's
  context pane, where it lists the references of the open PDF's parent item,
  and in the library view for the selected item.
- Finds the item's identifier: the **DOI** field first (or a `DOI:` line in
  Extra), then an **arXiv ID** from the URL, Extra or Archive ID field. If
  there is none, the section says so.
- Fetches references from **Semantic Scholar**. If that fails or returns
  nothing, it falls back to **OpenAlex**. Rate limits (HTTP 429) and server
  errors are retried with exponential backoff. Every retry, fallback and
  error is shown in the section.
- Each row shows the number, title, first author and year, and venue. Hover
  over a row to see the abstract as a tooltip, or click it to expand the
  abstract inline. Each row has three actions:
  - **Import**: uses `Zotero.Translate.Search` with the DOI or arXiv ID. If
    the reference has neither, or the identifier does not resolve, the item
    is created from the API metadata (journal article, conference paper or
    preprint).
  - **Copy DOI**: copies the DOI to the clipboard.
  - **Open**: opens the DOI or arXiv page in your browser.
- References that are already in the target library show **In library**
  instead of Import. They are matched by DOI, then arXiv ID, then normalised
  title. Click it to select the existing item.
- References are loaded as soon as an item is shown, so the list is ready
  when you open the section from the side navigation. In the library view
  the request waits 0.6 s, so that moving through items with the arrow keys
  does not send a request per item.
- Fetched lists are cached in memory and as JSON files in
  `<Zotero data directory>/pinakes/`. **Refresh** re-fetches the list.
- **Filter** box: type words to keep only references whose title, authors,
  venue, year, DOI or arXiv ID contain all of them (accents and case are
  ignored).
- **Batch import**: tick references (shift-click selects a range) and press
  **Import selected**, or press **Import all not in library**. With a filter
  active, both act only on the references shown. A progress bar shows the
  current item and can be cancelled. Imports run one after another. A
  summary at the end reports how many were imported, how many were created
  from metadata and how many failed; failed rows show the reason in red. If
  you switch to another item mid-batch, the batch keeps going and reports in
  a Zotero progress window.

### PDF fallback

When neither API has references for a paper, or the item has no DOI or
arXiv ID, Pinakes can read the bibliography from the PDF:

1. The PDF's text is extracted locally by Zotero (`Zotero.PDFWorker`).
2. The bibliography is the text after the last "References" or
   "Bibliography" heading, up to an appendix. Page numbers and running
   headers are dropped, and entries split across pages are re-joined.
   Bracketed (`[12]`), numbered (`12.`) and author-year styles are
   recognised.
3. Each entry is looked up in Crossref's bibliographic search. A match is
   accepted only if the title Crossref returns appears in the entry text.
   Requests go one at a time, at least 0.6 s apart.
4. Matched entries become normal rows, numbered as in the paper. Entries
   that Crossref does not match but that contain a DOI or arXiv ID can
   still be imported. All other entries are shown as plain text with a
   **Copy** button.

In the PDF reader this runs automatically. In the library view the section
shows a **Read the bibliography from the PDF** button instead, because it
sends one Crossref request per entry. It can be turned off in Settings →
Pinakes. The result is cached like any other list; press **Refresh** to try
the APIs again.

### Citation popups in the reader (experimental)

Turn this on in Settings → Pinakes → Experimental. In the PDF reader,
pausing the mouse over a numeric citation marker such as `[23]` or
`[4, 7–9]` then shows a card for each cited reference: title, authors,
year, venue, the start of the abstract, and **Open** and **Import** (or "In
library") buttons.

- The marker is read from the reader's text layer under the pointer.
  Markers split across lines are handled.
- Numbers are matched to the paper's own bibliography, which is read
  locally from the PDF. Each entry is then matched by title to the API
  reference, because the order of API results does not always follow the
  paper's numbering. If the PDF uses author-year citations or its
  bibliography cannot be read, the API order is used and the popup says so.
- Popups appear only once the Pinakes section has loaded the reference
  list for that paper.
- Recent Zotero versions show their own popup for citations they detect.
  When both appear, Zotero's popup shows the bibliography text and the
  Pinakes popup adds the metadata and import buttons. This is why the
  feature is off by default.

### Where imports go

By default the target is the **collection currently selected in the main
window**. If no collection is selected, items go to the root of the library
that holds the PDF. You can change this in Settings → Pinakes to "the
collection that contains the paper being read" or "always the library
root". The current target is shown at the top of the section ("Import to:
…").

When the target is the collection you are viewing, Zotero selects each new
item, just as "Add Item by Identifier" does. In the library view Pinakes
then selects the paper you were looking at again, so its reference list
stays open.

The item is always created **in the library that owns the target
collection**: `libraryID` and `collections` are both passed to
`translate()`. Group libraries are supported. (The original plugin created
items in the personal library and then added them to a group collection,
which violates Zotero's `fki_collectionItems_libraryID` constraint.)
Read-only libraries are refused with an error message.

## Network requests

The plugin itself contacts only these hosts:

| When                         | Request                                                                                                                                                                                                                                                              |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loading references (primary) | `GET https://api.semanticscholar.org/graph/v1/paper/{DOI:<doi> \| ARXIV:<id>}/references?fields=title,authors,year,venue,externalIds,abstract,publicationTypes&offset=<n>&limit=500`. If you set an API key, it is sent in the `x-api-key` header to this host only. |
| Fallback                     | `GET https://api.openalex.org/works/doi:<doi>?select=id,referenced_works`. arXiv papers are looked up by their DataCite DOI, `10.48550/arxiv.<id>`.                                                                                                                  |
| Fallback, details            | `GET https://api.openalex.org/works?filter=ids.openalex:W1\|W2…&per-page=50&select=id,doi,display_name,publication_year,authorships,primary_location,locations,type,abstract_inverted_index` (one request per 50 references)                                         |

| PDF fallback only | `GET https://api.crossref.org/works?query.bibliographic=<entry text, max. 400 chars>&rows=3&select=DOI,title,author,issued,container-title,type,abstract` (one per bibliography entry, sequential) |

`publicationTypes` is requested in addition to the fields you specified. It
is used only to choose the item type when an item has to be created from
metadata.

Two actions cause other traffic, and only when you click them:

- **Import** runs Zotero's own translators, exactly as "Add Item by
  Identifier" does. Zotero then contacts doi.org, Crossref or DataCite for
  DOIs, and arxiv.org for arXiv IDs, and may download an open-access PDF.
  These requests are made by Zotero, not by the plugin.
- **Open** opens `https://doi.org/<doi>` or `https://arxiv.org/abs/<id>` in
  your browser.

There is no telemetry, no analytics, and no other network access. The
release build is not minified, so `content/scripts/pinakes.js` inside the
`.xpi` can be read and audited directly.

## Settings

**Settings → Pinakes** has:

- **Semantic Scholar API key** (optional). Without a key, Semantic Scholar
  shares a low request rate among all anonymous users, so you may see 429
  retries more often.
- **Reference source**: which API to try first (Semantic Scholar or
  OpenAlex). The other one is always tried as a fallback.
- **Where imported references go**: the selected collection (default), the
  collection that contains the paper being read, or always the library
  root.
- **PDF fallback**: on by default.
- **Experimental → citation popups**: off by default.

## Debugging

All plugin messages start with `[Pinakes]`. To read them, open **Help →
Debug Output Logging → View Output** and filter on that prefix.

## Development

Requirements: Node.js LTS and Zotero 7 or later.

```sh
npm install
cp .env.example .env    # set the Zotero binary path, profile and data dir
npm start               # dev build, launches Zotero with the plugin, hot reload
npm run build           # production build -> .scaffold/build/pinakes.xpi
npm test                # unit tests (Node, no Zotero needed)
npm run test:zotero     # integration tests in a throwaway Zotero profile (needs network)
                        # Zotero's output goes to .scaffold/test/zotero-output.log
npm run lint:check
```

Source layout:

- `src/modules/identifiers.ts`: pure DOI, arXiv and title helpers
  (unit-tested)
- `src/modules/sources.ts`: Semantic Scholar and OpenAlex clients, with
  retry and backoff
- `src/modules/library.ts`: finds the item's identifier and the "in library"
  index (one SQL query per library)
- `src/modules/importer.ts`: import target and translation, plus creation
  from metadata
- `src/modules/bibliography.ts`: pure bibliography extraction from PDF text
  (unit-tested)
- `src/modules/pdf.ts`: the PDF fallback (PDF text, then Crossref)
- `src/modules/citations.ts`: pure parser for citation markers such as
  `[4, 7–9]` (unit-tested)
- `src/modules/citationPopups.ts`: the reader popups
- `src/modules/cache.ts`: memory and JSON-file cache
- `src/modules/section.ts`: the item pane section UI

Built on [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
and [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold).
The plugin has no runtime dependencies.

## License

AGPL-3.0-or-later, inherited from the template.
