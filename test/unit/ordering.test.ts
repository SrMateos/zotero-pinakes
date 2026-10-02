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
    ref(3, "Something only the API has"),
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
