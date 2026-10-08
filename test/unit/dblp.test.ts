import { test } from "node:test";
import assert from "node:assert/strict";
import {
  describePublication,
  findPublishedVersion,
  isPreprintOrUnpublished,
  parseSparql,
  sparqlQuery,
  surname,
  type DblpPublication,
  type ItemInfo,
} from "../../src/modules/dblp.ts";

// From sparql.dblp.org for Optuna (sparqlQuery() below), trimmed to the
// fields used.
const RESPONSE = {
  results: {
    bindings: [
      {
        pub: {
          value: "https://dblp.org/rec/conf/kdd/AkibaSYOK19",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Inproceedings",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "KDD",
        },
        pages: {
          value: "2623-2631",
        },
        doi: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ee: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ord: {
          value: "1",
        },
        name: {
          value: "Takuya Akiba",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/conf/kdd/AkibaSYOK19",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Inproceedings",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "KDD",
        },
        pages: {
          value: "2623-2631",
        },
        doi: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ee: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ord: {
          value: "2",
        },
        name: {
          value: "Shotaro Sano",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/conf/kdd/AkibaSYOK19",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Inproceedings",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "KDD",
        },
        pages: {
          value: "2623-2631",
        },
        doi: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ee: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ord: {
          value: "3",
        },
        name: {
          value: "Toshihiko Yanase",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/conf/kdd/AkibaSYOK19",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Inproceedings",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "KDD",
        },
        pages: {
          value: "2623-2631",
        },
        doi: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ee: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ord: {
          value: "4",
        },
        name: {
          value: "Takeru Ohta",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/conf/kdd/AkibaSYOK19",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Inproceedings",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "KDD",
        },
        pages: {
          value: "2623-2631",
        },
        doi: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ee: {
          value: "https://doi.org/10.1145/3292500.3330701",
        },
        ord: {
          value: "5",
        },
        name: {
          value: "Masanori Koyama 0001",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/journals/corr/abs-1907-10902",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Informal",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "CoRR",
        },
        volume: {
          value: "abs/1907.10902",
        },
        doi: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ee: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ord: {
          value: "1",
        },
        name: {
          value: "Takuya Akiba",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/journals/corr/abs-1907-10902",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Informal",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "CoRR",
        },
        volume: {
          value: "abs/1907.10902",
        },
        doi: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ee: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ord: {
          value: "2",
        },
        name: {
          value: "Shotaro Sano",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/journals/corr/abs-1907-10902",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Informal",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "CoRR",
        },
        volume: {
          value: "abs/1907.10902",
        },
        doi: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ee: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ord: {
          value: "3",
        },
        name: {
          value: "Toshihiko Yanase",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/journals/corr/abs-1907-10902",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Informal",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "CoRR",
        },
        volume: {
          value: "abs/1907.10902",
        },
        doi: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ee: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ord: {
          value: "4",
        },
        name: {
          value: "Takeru Ohta",
        },
      },
      {
        pub: {
          value: "https://dblp.org/rec/journals/corr/abs-1907-10902",
        },
        title: {
          value:
            "Optuna: A Next-generation Hyperparameter Optimization Framework.",
        },
        type: {
          value: "https://dblp.org/rdf/schema#Informal",
        },
        year: {
          value: "2019",
        },
        venue: {
          value: "CoRR",
        },
        volume: {
          value: "abs/1907.10902",
        },
        doi: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ee: {
          value: "https://doi.org/10.48550/ARXIV.1907.10902",
        },
        ord: {
          value: "5",
        },
        name: {
          value: "Masanori Koyama 0001",
        },
      },
    ],
  },
};

const PREPRINT: ItemInfo = {
  itemType: "preprint",
  title: "Optuna: A Next-generation Hyperparameter Optimization Framework",
  authors: ["Takuya Akiba", "Shotaro Sano", "T. Yanase", "Takeru Ohta"],
  year: 2019,
  venue: "arXiv",
  doi: "10.48550/arxiv.1907.10902",
  arxiv: "1907.10902",
};

function pub(over: Partial<DblpPublication>): DblpPublication {
  return {
    ...parseSparql(RESPONSE)[0],
    ...over,
  };
}

test("parseSparql groups rows into records with ordered authors", () => {
  const [kdd, corr] = parseSparql(RESPONSE);
  assert.equal(kdd.key, "conf/kdd/AkibaSYOK19");
  assert.equal(
    kdd.title,
    "Optuna: A Next-generation Hyperparameter Optimization Framework",
  );
  assert.equal(kdd.type, "Inproceedings");
  assert.deepEqual(kdd.authors, [
    "Takuya Akiba",
    "Shotaro Sano",
    "Toshihiko Yanase",
    "Takeru Ohta",
    "Masanori Koyama",
  ]);
  assert.equal(kdd.year, 2019);
  assert.equal(kdd.venue, "KDD");
  assert.equal(kdd.pages, "2623-2631");
  assert.equal(kdd.doi, "10.1145/3292500.3330701");
  assert.equal(kdd.url, "https://dblp.org/rec/conf/kdd/AkibaSYOK19");
  assert.equal(corr.type, "Informal");
  assert.equal(corr.arxiv, "1907.10902");
  assert.deepEqual(parseSparql({ results: {} }), []);
  assert.deepEqual(parseSparql(null), []);
});

test("sparqlQuery", () => {
  const query = sparqlQuery({ ...PREPRINT, title: 'A "quoted" title.' });
  assert.match(
    query,
    /VALUES \?t \{ "A \\"quoted\\" title" "A \\"quoted\\" title\." \}/,
  );
  assert.match(query, /<https:\/\/doi\.org\/10\.48550\/ARXIV\.1907\.10902>/);
  assert.match(query, /<https:\/\/doi\.org\/10\.48550\/arxiv\.1907\.10902>/);
  assert.doesNotMatch(
    sparqlQuery({ ...PREPRINT, arxiv: undefined, doi: undefined }),
    /UNION/,
  );
});

test("findPublishedVersion finds the conference version of a preprint", () => {
  const outcome = findPublishedVersion(PREPRINT, parseSparql(RESPONSE));
  assert.equal(outcome.kind, "found");
  assert.equal(
    outcome.kind === "found" && outcome.match.key,
    "conf/kdd/AkibaSYOK19",
  );
});

test("findPublishedVersion accepts only clear matches", () => {
  const hits = parseSparql(RESPONSE);
  const none = (info: Partial<ItemInfo>) =>
    findPublishedVersion({ ...PREPRINT, ...info }, hits).kind;
  assert.equal(none({ title: "Optuna: something else entirely" }), "none");
  assert.equal(none({ authors: ["Somebody Else", "Another One"] }), "none");
  assert.equal(none({ authors: [] }), "none");
  assert.equal(none({ year: 2012 }), "none");
  // Only the CoRR record: no published version.
  assert.deepEqual(findPublishedVersion(PREPRINT, [hits[1]]), {
    kind: "none",
    reason: "DBLP lists only the preprint.",
  });
});

test("findPublishedVersion recognises the published version itself", () => {
  const outcome = findPublishedVersion(
    {
      ...PREPRINT,
      itemType: "conferencePaper",
      venue: "KDD",
      doi: "10.1145/3292500.3330701",
    },
    parseSparql(RESPONSE),
  );
  assert.equal(outcome.kind, "already");
});

test("findPublishedVersion prefers the earliest of several versions", () => {
  const journal = pub({
    key: "j",
    type: "Article",
    venue: "JMLR",
    year: 2021,
    doi: "10.1/j",
  });
  const outcome = findPublishedVersion(PREPRINT, [journal, pub({})]);
  assert.equal(outcome.kind, "found");
  if (outcome.kind === "found") {
    assert.equal(outcome.match.key, "conf/kdd/AkibaSYOK19");
    assert.deepEqual(
      outcome.others.map((p) => p.key),
      ["j"],
    );
  }
});

test("a workshop paper later published elsewhere", () => {
  const workshop: ItemInfo = {
    ...PREPRINT,
    itemType: "conferencePaper",
    venue: "AutoML Workshop",
    doi: undefined,
    arxiv: undefined,
    year: 2018,
  };
  assert.equal(isPreprintOrUnpublished(workshop), false);
  const outcome = findPublishedVersion(workshop, [
    pub({ key: "w", venue: "AutoML Workshop", year: 2018, doi: undefined }),
    pub({}),
  ]);
  assert.equal(
    outcome.kind === "found" && outcome.match.key,
    "conf/kdd/AkibaSYOK19",
  );
});

test("isPreprintOrUnpublished", () => {
  const base: ItemInfo = {
    itemType: "journalArticle",
    title: "T",
    authors: [],
    venue: "Nature",
    doi: "10.1/x",
  };
  assert.equal(isPreprintOrUnpublished(base), false);
  assert.equal(
    isPreprintOrUnpublished({ ...base, itemType: "preprint" }),
    true,
  );
  assert.equal(isPreprintOrUnpublished({ ...base, venue: "" }), true);
  assert.equal(isPreprintOrUnpublished({ ...base, venue: "CoRR" }), true);
  assert.equal(
    isPreprintOrUnpublished({ ...base, venue: "arXiv preprint" }),
    true,
  );
  assert.equal(
    isPreprintOrUnpublished({ ...base, doi: undefined, arxiv: "1907.10902" }),
    true,
  );
});

test("helpers", () => {
  assert.equal(surname("Masanori Koyama 0001"), "koyama");
  assert.equal(surname("T. Yánase"), "yanase");
  assert.equal(describePublication(pub({})), "KDD 2019");
  assert.equal(
    describePublication(
      pub({ venue: "JMLR", volume: "21", number: "4", year: 2020 }),
    ),
    "JMLR 21(4), 2020",
  );
});
