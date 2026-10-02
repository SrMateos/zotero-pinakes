// Unit tests for the PDF bibliography parser. The excerpts imitate the text
// Zotero.PDFWorker.getFullText() returns: one paragraph per line, page
// numbers and running headers between pages.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  entryYear,
  extractBibliography,
  titleInEntry,
} from "../../src/modules/bibliography.ts";

const HEADER = "Preprint – A Paper About Catalogues";

test("bracketed entries, across a page break", () => {
  const text = [
    "1 Introduction",
    "As shown in [1, 2], catalogues matter.",
    `${HEADER} 7`,
    "References",
    "[1] Jimmy Lei Ba, Jamie Ryan Kiros, and Geoffrey E Hinton. Layer normalization. arXiv preprint arXiv:1607.06450, 2016.",
    "[2] Frank Hutter, Holger H. Hoos, and Kevin Leyton-Brown. Sequential model-based optimization for general algorithm",
    "",
    "",
    `${HEADER} 8`,
    "configuration. In LION, pages 507–523, 2011.",
    "[3] Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural computation, 9(8):1735–1780, 1997.",
    "12",
    `${HEADER} 9`,
  ].join("\n");
  const result = extractBibliography(text)!;
  assert.equal(result.style, "bracket");
  assert.deepEqual(
    result.entries.map((e) => e.label),
    ["1", "2", "3"],
  );
  assert.match(
    result.entries[1].text,
    /general algorithm configuration\. In LION/,
  );
  assert.doesNotMatch(result.entries[2].text, /Preprint/);
});

test("numbered entries ignore years that look like numbers", () => {
  const text = [
    "Bibliography",
    "1. Smith, J. A study of tables. J. Tables 3, 1–10 (2001).",
    "2. Doe, A. Another study of",
    "2019. something that is not a label at all, continued.",
    "3. Roe, B. Third paper on the catalogue of things. Nature (2020).",
  ].join("\n");
  const result = extractBibliography(text)!;
  assert.equal(result.style, "numbered");
  assert.equal(result.entries.length, 3);
  assert.match(result.entries[1].text, /2019\. something/);
});

test("author-year entries and the end at an appendix", () => {
  const text = [
    "References",
    "Alan Akbik, Duncan Blythe, and Roland Vollgraf. 2018. Contextual string embeddings for sequence labeling. In COLING.",
    "Rie Kubota Ando and Tong Zhang. 2005. A framework for learning predictive structures from multiple tasks and",
    "",
    "unlabeled data. Journal of Machine Learning Research, 6(Nov):1817–1853.",
    "Z. Chen, H. Zhang, X. Zhang, and L. Zhao. 2018. Quora question pairs.",
    "Ashish Vaswani, Noam Shazeer, and Niki Parmar. 2017. Attention is all you need. In NIPS.",
    "Appendix for “A Paper About Catalogues and Other Long Things”",
    "We organize the appendix into three sections.",
  ].join("\n");
  const result = extractBibliography(text)!;
  assert.equal(result.style, "author-year");
  assert.equal(result.entries.length, 4);
  assert.match(result.entries[1].text, /tasks and unlabeled data/);
  assert.ok(result.entries.every((e) => !/organize/.test(e.text)));
});

test("no bibliography heading", () => {
  assert.equal(
    extractBibliography("Just some text.\nNo references here."),
    undefined,
  );
});

test("entryYear and titleInEntry", () => {
  assert.equal(entryYear("Foo. In NIPS, pages 1–9, 2012."), 2012);
  assert.equal(entryYear("Peters et al. 2018a. Deep things."), 2018);
  assert.ok(
    titleInEntry(
      "Long Short-Term Memory",
      "Sepp Hochreiter and Jürgen Schmidhuber. Long short-term memory. Neural computation, 1997.",
    ),
  );
  assert.ok(!titleInEntry("Short", "Short paper"));
  assert.ok(
    !titleInEntry(
      "Attention is all you need",
      "Hochreiter. Long short-term memory.",
    ),
  );
});

test("bracketed entries that share a paragraph (IEEE layout)", () => {
  const text = [
    "References",
    "[1] M. Chen et al., “Evaluating large language models trained on code,” 2021. [2] A. Eghbali and M. Pradel, “De-hallucinator,” CoRR, 2024.",
    "[3] N. Jiang, “Impact of code language models,” in ICSE, 2023. [5] S. B. Hossain, “Togll,” in ICSE, 2025. [6] C. S. Xia, “Fuzz4all,” in ICSE, 2024.",
    "[Online]. Available: https://example.org [7] I. Bouzenia, “RepairAgent,” 2025.",
  ].join("\n");
  const result = extractBibliography(text)!;
  assert.deepEqual(
    result.entries.map((e) => e.label),
    ["1", "2", "3", "5", "6", "7"],
  );
  assert.match(result.entries[4].text, /Fuzz4all.*\[Online\]/);
  assert.match(result.entries[5].text, /^I\. Bouzenia/);
});

test("bracketed labels glued to the text ([1]M. Chen)", () => {
  const text = [
    "REFERENCES",
    "[1]M. Chen et al., “Evaluating large language models trained on code,” 2021.",
    "[2]A. Eghbali and M. Pradel, “De-hallucinator,”CoRR, 2024. [3]S. Barke, “Grounded copilot,” 2023.",
  ].join("\n");
  const result = extractBibliography(text)!;
  assert.equal(result.style, "bracket");
  assert.deepEqual(
    result.entries.map((e) => e.label),
    ["1", "2", "3"],
  );
});
