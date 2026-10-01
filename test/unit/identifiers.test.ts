// Run with `npm test` (Node's built-in test runner, no extra dependencies).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  abstractFromInvertedIndex,
  arxivFromDOI,
  arxivFromExtra,
  arxivFromURL,
  doiFromExtra,
  normalizeDOI,
  normalizeTitle,
  parseArxivId,
  normalizeForSearch,
  splitName,
} from "../../src/modules/identifiers.ts";

test("normalizeDOI", () => {
  assert.equal(
    normalizeDOI("10.1145/3292500.3330701"),
    "10.1145/3292500.3330701",
  );
  assert.equal(
    normalizeDOI("https://doi.org/10.1145/3292500.3330701."),
    "10.1145/3292500.3330701",
  );
  assert.equal(normalizeDOI("doi:10.1000/ABC(1)"), "10.1000/abc(1)");
  assert.equal(normalizeDOI("(see 10.1000/abc)."), "10.1000/abc");
  assert.equal(
    normalizeDOI("10.1002/1521-3773(20000103)39:1<1::AID-ANIE1>3.0.CO;2-8"),
    "10.1002/1521-3773(20000103)39:1<1::aid-anie1>3.0.co;2-8",
  );
  assert.equal(normalizeDOI("https://doi.org/10.1000%2Fxyz"), "10.1000/xyz");
  assert.equal(normalizeDOI("no doi here"), undefined);
  assert.equal(normalizeDOI(""), undefined);
});

test("doiFromExtra", () => {
  assert.equal(doiFromExtra("foo\nDOI: 10.5555/123\nbar"), "10.5555/123");
  assert.equal(doiFromExtra("arXiv: 2101.00001"), undefined);
});

test("arXiv parsing", () => {
  assert.equal(parseArxivId("arXiv:2101.00001v3"), "2101.00001");
  assert.equal(parseArxivId("hep-th/9901001"), "hep-th/9901001");
  assert.equal(parseArxivId("10.48550/arXiv.1706.03762"), "1706.03762");
  assert.equal(parseArxivId("not an id"), undefined);
  assert.equal(
    arxivFromURL("https://arxiv.org/abs/1706.03762v7"),
    "1706.03762",
  );
  assert.equal(
    arxivFromURL("http://arxiv.org/pdf/math.GT/0309136"),
    "math.GT/0309136",
  );
  assert.equal(arxivFromURL("https://example.org/abs/1706.03762"), undefined);
  assert.equal(arxivFromExtra("arXiv: 1706.03762"), "1706.03762");
  assert.equal(arxivFromDOI("10.48550/arxiv.1706.03762"), "1706.03762");
  assert.equal(arxivFromDOI("10.1145/1"), undefined);
});

test("normalizeTitle", () => {
  assert.equal(
    normalizeTitle("Attention Is All You Need"),
    normalizeTitle("attention is all you need."),
  );
  assert.equal(
    normalizeTitle("Café: <i>a</i> Résumé of things"),
    normalizeTitle("Cafe a resume of things"),
  );
  assert.equal(normalizeTitle("Short"), "");
});

test("splitName", () => {
  assert.deepEqual(splitName("Ada M. Lovelace"), {
    firstName: "Ada M.",
    lastName: "Lovelace",
  });
  assert.deepEqual(splitName("Plato"), { firstName: "", lastName: "Plato" });
});

test("abstractFromInvertedIndex", () => {
  assert.equal(
    abstractFromInvertedIndex({ hello: [0, 2], world: [1] }),
    "hello world hello",
  );
  assert.equal(abstractFromInvertedIndex(null), undefined);
});

test("normalizeForSearch", () => {
  assert.equal(
    normalizeForSearch("Café, Résumé: 10.1145/X"),
    "cafe resume 10.1145/x",
  );
});
