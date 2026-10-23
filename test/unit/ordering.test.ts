import { test } from "node:test";
import assert from "node:assert/strict";
import { orderByPaper } from "../../src/modules/ordering.ts";
import type { Reference } from "../../src/modules/types.ts";

const ref = (index: number, title: string, extra: Partial<Reference> = {}) =>
  ({ index, title, authors: [], kind: "journal", ...extra }) as Reference;

test("orderByPaper follows the bibliography and keeps its numbers", () => {
  const api = [
    ref(1, "Long short-term memory"),
    ref(2, "Layer normalization"),
    ref(3, "Something only the API has", { year: 2020 }),
    ref(4, "Adam", { arxiv: "1412.6980" }),
  ];
  const entries = [
    {
      label: "1",
      text: "Jimmy Lei Ba et al. Layer normalization. arXiv:1607.06450, 2016.",
    },
    {
      label: "2",
      text: "Diederik Kingma and Jimmy Ba. A method. arXiv preprint arXiv:1412.6980, 2015.",
    },
    {
      label: "3",
      text: "Sepp Hochreiter and J. Schmidhuber. Long short-term memory. Neural computation, 1997.",
    },
    {
      label: "4",
      text: "A. Nobody. A paper that no API knows about at all. Tech report, 1999.",
    },
  ];
  const result = orderByPaper(api, entries);
  assert.equal(result.matched, 3);
  assert.equal(result.extra, 1);
  assert.deepEqual(
    result.references.map((r) => [r.index, r.label, r.unresolved ?? false]),
    [
      [1, "1", false],
      [2, "2", false],
      [3, "3", false],
      [4, "4", true],
      [5, undefined, false],
    ],
  );
  assert.equal(result.references[0].title, "Layer normalization");
  assert.equal(result.references[1].title, "Adam"); // matched by arXiv ID
  assert.equal(result.references[4].title, "Something only the API has");
});

test("orderByPaper reuses a reference cited twice", () => {
  const api = [ref(1, "Evaluating agent-based program repair at Google")];
  const entries = [
    {
      label: "1",
      text: "P. Rondon et al., “Evaluating agent-based program repair at google,” arXiv, 2025.",
    },
    {
      label: "2",
      text: "P. Rondon et al., “Evaluating agent-based program repair at google,” 2025.",
    },
  ];
  const result = orderByPaper(api, entries);
  assert.equal(result.matched, 2);
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.references.map((r) => [r.label, r.title]),
    [
      ["1", "Evaluating agent-based program repair at Google"],
      ["2", "Evaluating agent-based program repair at Google"],
    ],
  );
});

test("orderByPaper drops bare API records that match no entry", () => {
  // Semantic Scholar's records for arXiv:2607.02599 (ACL author-year
  // style): appendix text taken for references, and real references it
  // could not link, with mangled titles.
  const api = [
    ref(1, "Two-variable logic on data words", {
      doi: "10.1145/1970398.1970403",
      year: 2011,
    }),
    ref(2, "2025. Why do multi-agent llm systems"),
    ref(3, "read_file"),
    ref(4, "A.1.1 Trace A trace is a finite sequence"),
    ref(5, "Process Mining: Data Science in Action , 2 edition", {
      year: 2016,
    }),
  ];
  const entries = [
    {
      text: "Mikołaj Bojańczyk, Claire David, Anca Muscholl, Thomas Schwentick, and Luc Segoufin. 2011. Two-variable logic on data words. ACM Transactions on Computational Logic, 12(4):27:1–27:26.",
    },
    {
      text: "Mert Cemri, Melissa Z. Pan, and Ion Stoica. 2025. Why do multi-agent llm systems fail? Preprint, arXiv:2503.13657.",
    },
  ];
  const result = orderByPaper(api, entries);
  assert.equal(result.matched, 2);
  assert.equal(result.dropped, 2);
  assert.equal(result.extra, 1);
  assert.deepEqual(
    result.references.map((r) => r.title),
    [
      "Two-variable logic on data words",
      "2025. Why do multi-agent llm systems",
      "Process Mining: Data Science in Action , 2 edition",
    ],
  );
  // The unlinked record takes the arXiv ID printed in its entry.
  assert.equal(result.references[1].arxiv, "2503.13657");
  assert.equal(result.references[0].arxiv, undefined);
});
