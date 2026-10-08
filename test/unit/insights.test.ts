import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hasAuthor,
  inTextCitations,
  intentCounts,
  nameKey,
  sectionHeading,
  selfCitations,
  topAuthors,
  topVenues,
  yearSummary,
} from "../../src/modules/insights.ts";
import type { Reference } from "../../src/modules/types.ts";

function ref(over: Partial<Reference>): Reference {
  return { index: 1, title: "A title", authors: [], kind: "other", ...over };
}

test("nameKey: surname and first initial", () => {
  assert.equal(nameKey("Ada Lovelace"), "lovelace a");
  assert.equal(nameKey("A. Lovelace"), "lovelace a");
  assert.equal(nameKey("Ádá  M. Lovelace"), "lovelace a");
  assert.equal(nameKey("Plato"), "plato");
});

test("topAuthors counts by ID, so namesakes are not merged", () => {
  const refs = [
    ref({ authors: ["Wei Wang", "Ada Lovelace"], authorIds: ["1", "9"] }),
    ref({ authors: ["Wei Wang"], authorIds: ["1"] }),
    ref({ authors: ["Wei Wang"], authorIds: ["2"] }),
    ref({ authors: ["Wei Wang"], authorIds: ["2"] }),
    ref({ authors: ["Wei Wang"], authorIds: ["2"] }),
    ref({ authors: ["Ada Lovelace"], authorIds: ["9"] }),
  ];
  assert.deepEqual(topAuthors(refs, ["9"]), [
    { key: "id:2", name: "Wei Wang", count: 3, self: false },
    { key: "id:9", name: "Ada Lovelace", count: 2, self: true },
    { key: "id:1", name: "Wei Wang", count: 2, self: false },
  ]);
  assert.ok(hasAuthor(refs[0], "id:9"));
  assert.ok(!hasAuthor(refs[2], "id:1"));
});

test("topAuthors falls back to names without IDs", () => {
  const refs = [
    ref({ authors: ["Ada Lovelace", "C. Babbage"] }),
    ref({ authors: ["A. Lovelace"] }),
    ref({ authors: ["Charles Babbage"] }),
    ref({ authors: ["Someone Once"] }),
    ref({ authors: ["X. Y"], unresolved: true }),
  ];
  const top = topAuthors(refs, [], ["Charles Babbage"]);
  assert.deepEqual(
    top.map((a) => [a.key, a.count, a.self]),
    [
      // Ties are sorted by name.
      ["name:lovelace a", 2, false],
      ["name:babbage c", 2, true],
    ],
  );
  assert.deepEqual(selfCitations(refs, [], ["Charles Babbage"]).length, 2);
});

test("yearSummary", () => {
  assert.equal(yearSummary([ref({})]), undefined);
  const s = yearSummary([
    ref({ year: 2020 }),
    ref({ year: 2017 }),
    ref({ year: 2020 }),
    ref({}),
  ])!;
  assert.equal(s.min, 2017);
  assert.equal(s.max, 2020);
  assert.equal(s.median, 2020);
  assert.equal(s.dated, 3);
  assert.deepEqual(s.histogram, [
    [2017, 1],
    [2018, 0],
    [2019, 0],
    [2020, 2],
  ]);
});

test("topVenues groups spellings and years", () => {
  const venues = topVenues([
    ref({ venue: "NeurIPS" }),
    ref({ venue: "NeurIPS 2019" }),
    ref({ venue: "neurips" }),
    ref({ venue: "ICML" }),
    ref({ venue: "NeurIPS" }),
  ]);
  assert.deepEqual(venues, [
    { key: "neurips", name: "NeurIPS", count: 4 },
    { key: "icml", name: "ICML", count: 1 },
  ]);
});

test("intentCounts", () => {
  assert.deepEqual(
    intentCounts([
      ref({ intents: ["methodology", "background"] }),
      ref({ intents: ["background"] }),
      ref({}),
    ]),
    [
      ["background", 2],
      ["methodology", 1],
    ],
  );
});

test("sectionHeading", () => {
  assert.deepEqual(sectionHeading("1 Introduction", 0), {
    title: "Introduction",
    number: 1,
  });
  assert.deepEqual(sectionHeading("III. RELATED WORK", 2), {
    title: "Related Work",
    number: 3,
  });
  assert.deepEqual(sectionHeading("Conclusion", 5), { title: "Conclusion" });
  // As extracted from PDFs: glued numbers and split small capitals.
  assert.deepEqual(sectionHeading("1I ntroduction", 0), {
    title: "Introduction",
    number: 1,
  });
  assert.deepEqual(sectionHeading("3E fficient Sampling and Pruning", 2), {
    title: "Efficient Sampling and Pruning",
    number: 3,
  });
  assert.equal(sectionHeading("2.1Modular Programming", 2), undefined);
  assert.equal(sectionHeading("1Preferred Networks, Inc.", 0), undefined);
  // Out of sequence, subsections, sentences and table rows are not headings.
  assert.equal(sectionHeading("7 Method", 2), undefined);
  assert.equal(sectionHeading("3.1 Setup", 2), undefined);
  assert.equal(sectionHeading("2 We propose a method.", 1), undefined);
  assert.equal(sectionHeading("3 0.51 0.62", 2), undefined);
});

test("inTextCitations counts markers per number and section", () => {
  const text = [
    "A Paper Title",
    "Abstract",
    "We build on [1].",
    "1 Introduction",
    "Prior work [1, 2] and [2–4] exists.",
    "2 Method",
    "We follow [2].",
    "Table 3 shows [5].",
    "References",
    "[1] A. Author. Cited in the bibliography [9].",
  ].join("\n");
  const counts = inTextCitations(text);
  assert.deepEqual(counts.get(1), {
    count: 2,
    sections: ["Abstract", "Introduction"],
  });
  assert.deepEqual(counts.get(2), {
    count: 3,
    sections: ["Introduction", "Method"],
  });
  assert.deepEqual(counts.get(4), { count: 1, sections: ["Introduction"] });
  assert.equal(counts.get(5)?.count, 1);
  // Markers in the bibliography itself are not in-text citations.
  assert.equal(counts.get(9), undefined);
});
