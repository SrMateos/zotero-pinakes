# Pinakes for Zotero

Pinakes shows the reference list of the paper you are reading, right in
Zotero's item pane, and imports any cited work into your library with one
click.

It works with Zotero 7 and later, including group libraries. The plugin is
written in plain, unminified TypeScript, has no runtime dependencies and
sends no telemetry.

## Features

- **Reference list in the item pane.** A Pinakes section appears next to
  the PDF reader and in the library view. It lists the references of the
  selected item, or of the parent item of the open PDF.
- **In the paper's own order.** References are numbered as in the paper's
  bibliography (`[1]`, `[2]`, …), not in the order an API returns them.
  See [How references are ordered](#how-references-are-ordered).
- **One-click import.** Each reference is imported the same way as Zotero's
  _Add Item by Identifier_: by DOI, then arXiv ID. If neither resolves, the
  item is created from the available metadata.
- **"In library" detection.** References already in the target library are
  matched by DOI, arXiv ID or title, and link to the existing item.
- **Batch import.** You can import selected references (shift-click selects
  a range) or every reference not yet in your library. A progress bar and a
  Cancel button are shown while it runs.
- **Filter.** Narrow the list by title, author, venue, year, DOI or arXiv
  ID.
- **Insights.** A collapsible panel above the list summarises it. See
  [Insights](#insights).
- **PDF fallback.** If no API has the references, Pinakes reads the
  bibliography from the PDF and resolves each entry through Crossref.
- **Citation popups (experimental).** In the reader, hovering a marker such
  as `[23]` or `[4, 7–9]` shows the cited references.
- **Caching.** Lists are kept in memory and in
  `<Zotero data directory>/pinakes/`. Press **Refresh** to fetch a list
  again.

## Installation

1. Download `pinakes.xpi` from the
   [latest release](https://github.com/srmateos/zotero-pinakes/releases/latest).
2. In Zotero, open **Tools → Plugins**, click the gear icon, choose
   **Install Plugin From File…** and select the file.

Pinakes updates automatically through Zotero's plugin manager.

## Usage

Open a PDF, or select an item in the library, and click the Pinakes icon in
the item pane's side navigation.

To find the references, the item needs a **DOI**, either in the DOI field
or as a `DOI:` line in Extra. Failing that, it needs an **arXiv ID** in
the URL, Extra or Archive ID field.

Each row has these actions:

| Action               | What it does                                                |
| -------------------- | ----------------------------------------------------------- |
| Import / In library  | Imports the reference, or selects the existing item.        |
| Copy DOI             | Copies the DOI to the clipboard.                            |
| Open                 | Opens the DOI (or the arXiv page) in your browser.          |
| Copy (PDF-only rows) | Copies the text of a bibliography entry that has no record. |

Click a row to expand its abstract.

## How references are ordered

The Semantic Scholar and OpenAlex APIs do not return references in the
paper's order. When the item has a PDF, Pinakes reads its bibliography
locally, without any network request. It then matches each entry to the
API records: by title first, then by the DOI or arXiv ID printed in the
entry. The result:

- the list follows the paper and uses the paper's numbers, and the header
  says "paper order";
- entries the API lacks are still shown, built from the PDF text;
- if the whole bibliography was read (`[1]` to `[N]` with no gaps), API
  records that are not in it are hidden. These are usually headings that
  the API's own PDF parser mistook for references. A note says how many
  were hidden;
- with no usable PDF, the API order is kept and a note explains why.

## Insights

Open **Insights** above the reference list to see:

- **Summary.** The number of references, their years (range, median and a
  bar per year), and how many are already in the target library.
- **Top venues** and **most cited authors.** Authors are counted by their
  Semantic Scholar or OpenAlex author ID, so two people with the same name
  are not merged. Authors of the paper itself are marked "self", and
  **Self-citations** lists the references they wrote.
- **Semantic Scholar tags.** Whether the paper cites a reference
  _influentially_, and why: background, methodology or result comparison.
  The tags also appear on each row.
- **In-text citations.** How often each `[n]` is cited in the paper's text
  and in which sections. This is read locally from the PDF, only for
  papers with numeric citations.

Click a venue, author, tag, year bar or in-text entry to show only the
matching references; click × on the filter chip to show all again.

## Where imported items go

| Import target (Settings → Pinakes) | Where the item is created                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| Selected collection (default)      | The collection selected in the main window. If none is selected, the root of the paper's library. |
| Paper's collection                 | The first collection containing the paper, or its library root.                                   |
| Library root                       | Always the root of the paper's library.                                                           |

The current target is shown at the top of the section ("Import to: …").

Items are created directly in the library that owns the target collection,
so group libraries work. Read-only libraries are refused with an error.

## Settings

| Setting                  | Default          | Notes                                                                    |
| ------------------------ | ---------------- | ------------------------------------------------------------------------ |
| Semantic Scholar API key | empty            | Optional. Raises the rate limit; sent only to `api.semanticscholar.org`. |
| Try first                | Semantic Scholar | The other source (OpenAlex) is always the fallback.                      |
| PDF fallback             | on               | Automatic in the reader; started with a button in the library view.      |
| Import target            | selected         | See [Where imported items go](#where-imported-items-go).                 |
| Citation popups          | off              | Experimental. Recent Zotero versions also show their own citation popup. |

## Privacy and network access

Pinakes itself contacts only these hosts:

| Purpose               | Request                                                                                                                                                                                                                                                                                      |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| References (primary)  | `GET https://api.semanticscholar.org/graph/v1/paper/{DOI:<doi>\|ARXIV:<id>}/references?fields=title,authors,year,venue,externalIds,abstract,publicationTypes,isInfluential,intents&offset=<n>&limit=500`, then `GET …/paper/{DOI:<doi>\|ARXIV:<id>}?fields=authors` (to mark self-citations) |
| References (fallback) | `GET https://api.openalex.org/works/doi:<doi>?select=id,referenced_works,authorships`, then `GET https://api.openalex.org/works?filter=ids.openalex:<ids>&per-page=50&select=…`                                                                                                              |
| PDF fallback only     | `GET https://api.crossref.org/works?query.bibliographic=<entry text>&rows=3&select=DOI,title,author,issued,container-title,type,abstract`, one request per entry, at least 0.6 s apart                                                                                                       |

- **arXiv papers in OpenAlex.** They are looked up by their DataCite DOI,
  `10.48550/arxiv.<id>`.
- **API key.** If you set a Semantic Scholar API key, it is sent only in
  the `x-api-key` header to `api.semanticscholar.org`.
- **Import.** Importing runs Zotero's own translators, as _Add Item by
  Identifier_ does. These contact doi.org, Crossref, DataCite or arXiv,
  and may download an open-access PDF.
- **Open.** It opens the DOI or arXiv page in your browser.

Nothing else is sent anywhere. Rate limits (HTTP 429) and server errors
are retried with exponential backoff, and every retry, fallback and error
is shown in the section.

## Troubleshooting

- **"No identifier".** Add a DOI or an arXiv ID to the item. You can also
  use **Read the bibliography from the PDF**.
- **Frequent rate-limit retries.** Add a free Semantic Scholar API key in
  the settings.
- **Debug log.** Enable **Help → Debug Output Logging**, reproduce the
  problem, then choose **View Output** and look for lines starting with
  `[Pinakes]`.

## Development

### Requirements

- Node.js (LTS) and npm
- Zotero 7 or later, for `npm start` and the integration tests

### First-time setup

After cloning, install the development dependencies. The build tools,
including the `zotero-plugin` command, live in `node_modules/` and are
not committed:

```sh
npm ci                 # installs the exact versions in package-lock.json
cp .env.example .env   # set the Zotero binary, and a separate profile and data directory
```

Run `npm ci` again whenever `package-lock.json` changes, for example after
a pull. Use `npm install <package>` only to add or upgrade a dependency;
it rewrites the lockfile.

If a script fails with `zotero-plugin: not found` (or `tsc`, `eslint`,
`prettier: not found`), the dependencies are not installed: run `npm ci`.

### Commands

| Command               | What it does                                                             |
| --------------------- | ------------------------------------------------------------------------ |
| `npm start`           | Development build; starts Zotero with the plugin and reloads on changes. |
| `npm run build`       | Release build to `.scaffold/build/pinakes.xpi`, then a type check.       |
| `npm test`            | Unit tests, in Node only.                                                |
| `npm run test:zotero` | Integration tests in a throwaway Zotero profile (needs network).         |
| `npm run lint:check`  | Prettier and ESLint, without changing files.                             |
| `npm run lint:fix`    | Prettier and ESLint, fixing what they can.                               |

`npm start` and `npm run test:zotero` read `.env`. The integration tests
send Zotero's output to `.scaffold/test/zotero-output.log`.

To try a build in your everyday Zotero, install
`.scaffold/build/pinakes.xpi` with **Tools → Plugins → Install Plugin From
File…**.

### Source overview

Modules in `src/modules/`:

| Module                                           | Responsibility                                                  |
| ------------------------------------------------ | --------------------------------------------------------------- |
| `section.ts`                                     | Item pane section: rendering, filter, import and batch import   |
| `loader.ts`                                      | Cache → APIs → paper order → PDF fallback pipeline              |
| `sources.ts`                                     | Semantic Scholar and OpenAlex clients, retry and backoff        |
| `pdf.ts`, `bibliography.ts`, `ordering.ts`       | PDF bibliography, Crossref resolution, paper order              |
| `library.ts`, `importer.ts`, `selectionGuard.ts` | Library matching, import target and translation                 |
| `citations.ts`, `citationPopups.ts`              | Citation markers and reader popups                              |
| `insights.ts`, `insightsPanel.ts`                | Insights panel: authors, venues, years, tags, in-text citations |
| `identifiers.ts`, `cache.ts`, `dom.ts`           | Shared helpers                                                  |

### Continuous integration

Every push to `main` and every pull request runs
[`ci.yml`](.github/workflows/ci.yml): `npm ci`, lint, unit tests and a
build. The `.xpi` is kept as a workflow artifact (`pinakes-xpi`) on the
run's page under **Actions**.

## Releasing

A release is driven by a git tag. Pushing a tag named `v<version>` (for
example `v1.2.0`) starts [`release.yml`](.github/workflows/release.yml),
which builds the plugin and publishes it on GitHub.

### Steps

1. Make sure `main` is clean, up to date with `origin` and CI is green.
2. Run:

   ```sh
   npm run release
   ```

   It asks for the new version (patch, minor, major or a pre-release such
   as `1.2.0-beta.0`) and asks you to confirm. Then it:
   1. writes the version to `package.json` and `package-lock.json`;
   2. runs `npm run build`;
   3. commits as `chore(publish): release v<version>`;
   4. creates the tag `v<version>`;
   5. pushes the commit and the tag.

3. Watch the **Release** run in the repository's **Actions** tab. It runs
   `npm run release` again; on CI this skips the steps above and instead:
   - creates the GitHub release `v<version>`, with the changelog built
     from the commit messages since the previous tag, and attaches
     `pinakes.xpi`;
   - uploads `update.json` and `update-beta.json` to a special
     pre-release tagged `release` ("Release Manifest"). Installed copies
     of Pinakes read that file to find updates, so do not delete it.

Pre-releases (versions with a `-`) are marked as such on GitHub and only
update `update-beta.json`, so users on `update.json` are not moved to a
beta.

### Version numbers

Versions follow [semantic versioning](https://semver.org/):
`major.minor.patch`. Bump the patch for fixes, the minor for new features,
and the major for changes that break existing behaviour or settings.

### If something goes wrong

- **The commit was pushed but no Release run started.** The tag is
  missing. Check with `git ls-remote --tags origin`. Create and push it on
  the release commit:

  ```sh
  git tag v1.2.0 <release-commit>
  git push origin v1.2.0
  ```

- **The Release run failed.** Fix the cause, then rerun it from the
  Actions tab. If the fix needs a new commit, delete the tag locally and
  on GitHub (`git tag -d v1.2.0 && git push origin :refs/tags/v1.2.0`),
  delete the GitHub release if one was created, and release again.

- **Never move a tag that was already published.** Users and Zotero's
  updater may have the old build. Release a new patch version instead.

## About the name

The _Pinakes_ (Πίνακες, "tables") was the catalogue of the Library of
Alexandria, compiled by Callimachus of Cyrene in the 3rd century BC and
often called the first library catalogue. This plugin shows the catalogue
of the works a paper cites.

## License

[AGPL-3.0-or-later](LICENSE). Built on
[zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template)
and [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold).
