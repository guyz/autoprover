import assert from "node:assert/strict";
import test from "node:test";
import {
  descriptorSimilarity,
  discoveryDiversityBrief,
  problemDescriptors,
  selectDiverseStrategies,
  selectProblemPortfolio,
  strategyCoverageReceipt,
  strategyDescriptors,
} from "../src/diversity.mjs";

function problemEntry(
  index,
  {
    domain = `domain-${index}`,
    priority = 0.72,
    attempts = [],
    operatorPriority = null,
  } = {},
) {
  return {
    problemKey: `problem-${index}`,
    ranking: { priority },
    attempts,
    operatorPriority,
    packet: {
      id: `problem-${index}`,
      title: `Open problem ${index}`,
      domain,
      statement:
        `For every finite ${domain} object in family ${index}, ` +
        "property P holds.",
      verificationMode: "exact-computation",
      falsificationType: "finite-counterexample",
      counterexampleSearchability: 5,
    },
  };
}

function strategy(
  id,
  {
    title = id,
    hypothesis = `${id} hypothesis`,
    predictedObservation = `${id} prediction`,
    falsifier = `${id} exact falsifier`,
    noveltyVector = [id],
    preferredTools = [id],
  } = {},
) {
  return {
    id,
    title,
    hypothesis,
    predictedObservation,
    falsifier,
    noveltyVector,
    preferredTools,
  };
}

test("problem portfolios are reproducible, order-independent, unique, and support arbitrary slot counts", () => {
  const entries = Array.from({ length: 19 }, (_, index) =>
    problemEntry(index),
  );
  for (const count of [1, 2, 6, 11, 19]) {
    const forward = selectProblemPortfolio(entries, {
      count,
      seed: "installation-a",
      cycle: 7,
    });
    const reversed = selectProblemPortfolio([...entries].reverse(), {
      count,
      seed: "installation-a",
      cycle: 7,
    });
    assert.equal(forward.length, count);
    assert.equal(new Set(forward.map((entry) => entry.problemKey)).size, count);
    assert.deepEqual(
      reversed.map((entry) => entry.problemKey),
      forward.map((entry) => entry.problemKey),
    );
  }
});

test("different installation seeds spread equivalent work instead of converging on one favorite", () => {
  const entries = Array.from({ length: 24 }, (_, index) =>
    problemEntry(index, { priority: 0.7 }),
  );
  const firstSelections = new Set();
  for (let index = 0; index < 40; index += 1) {
    firstSelections.add(
      selectProblemPortfolio(entries, {
        count: 1,
        seed: `installation-${index}`,
        cycle: 0,
      })[0].problemKey,
    );
  }
  assert.ok(
    firstSelections.size >= 12,
    `expected broad seeded coverage; observed ${firstSelections.size} first choices`,
  );
});

test("seeded exploration remains strongly quality-weighted", () => {
  const strong = problemEntry(1, {
    domain: "number theory",
    priority: 0.9,
  });
  const weak = problemEntry(2, {
    domain: "geometry",
    priority: 0.4,
  });
  let strongSelections = 0;
  for (let index = 0; index < 200; index += 1) {
    const [selected] = selectProblemPortfolio([strong, weak], {
      count: 1,
      seed: `quality-node-${index}`,
      cycle: 0,
    });
    if (selected.problemKey === strong.problemKey) strongSelections += 1;
  }
  assert.ok(
    strongSelections >= 180,
    `expected the stronger problem to dominate while retaining exploration; observed ${strongSelections}/200`,
  );
});

test("portfolio selection automatically balances quality with within-run coverage", () => {
  const entries = [
    ...Array.from({ length: 5 }, (_, index) =>
      problemEntry(index, {
        domain: "graph theory",
        priority: 0.72,
      }),
    ),
    problemEntry(5, { domain: "number theory", priority: 0.72 }),
    problemEntry(6, { domain: "discrete geometry", priority: 0.72 }),
  ];
  let portfoliosWithMultipleDomains = 0;
  for (let index = 0; index < 60; index += 1) {
    const selected = selectProblemPortfolio(entries, {
      count: 3,
      seed: `node-${index}`,
      cycle: 2,
    });
    const domains = new Set(selected.map((entry) => entry.packet.domain));
    if (domains.size >= 2) portfoliosWithMultipleDomains += 1;
  }
  assert.ok(
    portfoliosWithMultipleDomains >= 56,
    `expected automatic diversity in nearly every portfolio; observed ${portfoliosWithMultipleDomains}/60`,
  );
});

test("operator priorities remain authoritative without exposing diversity controls", () => {
  const pinned = problemEntry(9, {
    priority: 0.1,
    operatorPriority: {
      requestedAt: "2026-07-24T12:00:00.000Z",
      commandId: "operator-request",
    },
  });
  const selected = selectProblemPortfolio(
    [problemEntry(1, { priority: 0.95 }), pinned],
    {
      count: 1,
      seed: "any-node",
      cycle: 0,
    },
  );
  assert.equal(selected[0].problemKey, pinned.problemKey);
  assert.equal(selected[0].selection.reason, "operator-priority");
});

test("strategy selection suppresses exact duplicates and prefers uncovered mechanisms", () => {
  const exact = strategy("exact-search", {
    title: "Exact bounded search",
    hypothesis: "A small witness exists.",
    predictedObservation: "An exact witness appears.",
    falsifier: "An exact checker rejects every case.",
    noveltyVector: ["bounded exact search"],
    preferredTools: ["python"],
  });
  const cosmeticDuplicate = {
    ...exact,
    id: "exact-search-renamed",
  };
  const spectral = strategy("spectral", {
    title: "Spectral obstruction",
    hypothesis: "An eigenvalue inequality rules out a witness.",
    predictedObservation: "The spectral bound is contradictory.",
    falsifier: "A checked matrix violates the bound.",
    noveltyVector: ["spectral representation"],
    preferredTools: ["sage"],
  });
  const sat = strategy("sat", {
    title: "Proof-carrying SAT",
    hypothesis: "The unrestricted encoding is unsatisfiable.",
    predictedObservation: "A checked UNSAT certificate is produced.",
    falsifier: "A satisfying model passes the exact checker.",
    noveltyVector: ["proof carrying sat"],
    preferredTools: ["cadical"],
  });
  const probabilistic = strategy("probabilistic", {
    title: "Probabilistic construction",
    hypothesis: "A random construction has positive success probability.",
    predictedObservation: "A moment bound stays below one.",
    falsifier: "An exact dependency calculation defeats the bound.",
    noveltyVector: ["probabilistic construction"],
    preferredTools: ["symbolic algebra"],
  });

  const result = selectDiverseStrategies(
    [exact, cosmeticDuplicate, spectral, sat, probabilistic],
    {
      count: 3,
      seed: "strategy-node",
      priorCoverage: [{ descriptors: strategyDescriptors(exact) }],
    },
  );
  assert.equal(result.diagnostics.suppressedExactDuplicates, 1);
  assert.equal(result.strategies.length, 3);
  assert.equal(
    new Set(
      result.strategies.map((entry) => entry.strategyFingerprint),
    ).size,
    3,
  );
  assert.ok(
    result.strategies.every((entry) => entry.id !== "exact-search"),
    "an already-covered exact-search mechanism should yield to fresh mechanisms when enough exist",
  );
});

test("coverage receipts are compact, path-free, and reusable by a later attempt", () => {
  const covered = strategy("sat", {
    noveltyVector: ["proof carrying sat"],
    preferredTools: ["cadical"],
  });
  const receipt = strategyCoverageReceipt({
    branches: [
      {
        id: "branch-private-path",
        strategy: covered,
        status: "stopped",
        turns: 3,
        verifiedFacts: ["One fact"],
        failedApproaches: ["One failed approach"],
      },
    ],
  });
  assert.equal(receipt.length, 1);
  assert.equal(receipt[0].turns, 3);
  assert.equal(receipt[0].failedApproachCount, 1);
  assert.ok(receipt[0].fingerprint);
  assert.ok(receipt[0].descriptors.length);
  assert.doesNotMatch(JSON.stringify(receipt), /private-path/);
});

test("discovery policy rejects machine-generated-list provenance and changes source lanes by seed", () => {
  const first = discoveryDiversityBrief("installation-a", 12);
  const second = discoveryDiversityBrief("installation-b", 12);
  assert.match(first, /machine-generated conjecture list/i);
  assert.match(first, /substantive human mathematical study/i);
  assert.notEqual(first, second);
});

test("problem descriptors distinguish unlike research niches", () => {
  const graph = problemDescriptors(
    problemEntry(1, { domain: "graph theory" }),
  );
  const graphAgain = problemDescriptors(
    problemEntry(2, { domain: "graph theory" }),
  );
  const geometry = problemDescriptors(
    problemEntry(3, { domain: "discrete geometry" }),
  );
  assert.ok(
    descriptorSimilarity(graph, graphAgain) >
      descriptorSimilarity(graph, geometry),
  );
});
