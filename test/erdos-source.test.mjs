import assert from "node:assert/strict";
import test from "node:test";
import {
  parseErdosProblemIndex,
  selectErdosProblemHints,
} from "../src/problem-sources/erdos.mjs";

const INDEX = `
- number: "19"
  prize: "$500"
  status:
    state: "decidable"
    last_update: "2026-01-01"
  formalized:
    state: "no"
  tags: ["graph theory", "chromatic number"]

- number: "20"
  prize: "$1000"
  status:
    state: "open"
  formalized:
    state: "yes"
  tags: ["combinatorics"]

- number: "21"
  status:
    state: "proved"
  formalized:
    state: "yes"
  tags: ["combinatorics"]

- number: "23"
  status:
    state: "falsifiable"
  formalized:
    state: "yes"
  tags: ["graph theory"]

- number: "24"
  status:
    state: "verifiable"
`;

test("the Erdős source retains only currently unresolved database states", () => {
  const entries = parseErdosProblemIndex(INDEX);
  assert.deepEqual(
    entries.map((entry) => [entry.number, entry.status]),
    [
      ["19", "decidable"],
      ["20", "open"],
      ["23", "falsifiable"],
      ["24", "verifiable"],
    ],
  );
  assert.equal(entries[0].url, "https://www.erdosproblems.com/19");
  assert.deepEqual(entries[0].tags, ["graph theory", "chromatic number"]);
});

test("Erdős hint sampling is deterministic and favors operational variety", () => {
  const entries = parseErdosProblemIndex(INDEX);
  const first = selectErdosProblemHints(entries, {
    count: 2,
    seed: "campaign-a",
  });
  const second = selectErdosProblemHints([...entries].reverse(), {
    count: 2,
    seed: "campaign-a",
  });
  assert.deepEqual(first, second);
  assert.equal(new Set(first.map((entry) => entry.number)).size, 2);
  assert.ok(
    first.some((entry) =>
      ["decidable", "falsifiable"].includes(entry.status),
    ),
  );
});
