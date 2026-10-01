import { test } from "node:test";
import assert from "node:assert/strict";
import { findMarkers, markerAt } from "../../src/modules/citations.ts";

test("findMarkers", () => {
  const text =
    "as in [23] and [4, 7–9], not [2019] or [0], also [3-1] and [12;14].";
  assert.deepEqual(
    findMarkers(text).map((m) => m.numbers),
    [[23], [4, 7, 8, 9], [12, 14]],
  );
  assert.deepEqual(findMarkers("[1 – 3]")[0].numbers, [1, 2, 3]);
  assert.deepEqual(findMarkers("no markers [a] here"), []);
});

test("markerAt", () => {
  const text = "see [4, 7–9] for details";
  assert.deepEqual(markerAt(text, 4)?.numbers, [4, 7, 8, 9]);
  assert.deepEqual(markerAt(text, 11)?.numbers, [4, 7, 8, 9]);
  assert.equal(markerAt(text, 12), undefined);
  assert.equal(markerAt(text, 1), undefined);
});
