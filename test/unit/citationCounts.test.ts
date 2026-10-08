import { test } from "node:test";
import assert from "node:assert/strict";
import {
  citationBadge,
  citationTooltip,
  formatCount,
  sortByCitations,
} from "../../src/modules/citationCounts.ts";
import type { Reference } from "../../src/modules/types.ts";

function ref(index: number, citedBy?: number): Reference {
  return {
    index,
    title: `Paper ${index}`,
    authors: [],
    kind: "other",
    citedBy,
    citedBySource: citedBy === undefined ? undefined : "openalex",
  };
}

test("formatCount", () => {
  assert.equal(formatCount(0), "0");
  assert.equal(formatCount(999), "999");
  assert.equal(formatCount(1000), "1k");
  assert.equal(formatCount(1234), "1.2k");
  assert.equal(formatCount(9960), "10k");
  assert.equal(formatCount(12_345), "12k");
  assert.equal(formatCount(999_499), "999k");
  assert.equal(formatCount(999_500), "1M");
  assert.equal(formatCount(3_420_000), "3.4M");
});

test("citationBadge", () => {
  assert.equal(citationBadge(1), "1 citation");
  assert.equal(citationBadge(0), "0 citations");
  assert.equal(citationBadge(1234), "1.2k citations");
});

test("citationTooltip names the source and the fetch time", () => {
  assert.equal(
    citationTooltip(ref(1, 1234), "today"),
    "Cited 1,234 times according to OpenAlex (fetched today). Counts differ between sources.",
  );
  assert.match(citationTooltip(ref(1, 1), "today"), /^Cited once /);
  assert.equal(citationTooltip(ref(1), "today"), "");
});

test("sortByCitations: most cited first, missing counts last, stable", () => {
  const refs = [ref(1, 5), ref(2), ref(3, 50), ref(4, 5), ref(5, 0)];
  assert.deepEqual(
    sortByCitations(refs).map((r) => r.index),
    [3, 1, 4, 5, 2],
  );
  assert.deepEqual(
    refs.map((r) => r.index),
    [1, 2, 3, 4, 5],
  );
});
