import { clamp, sha256 } from "./utils.mjs";

const PROBLEM_SELECTION_TEMPERATURE = 0.16;
const PROBLEM_SIMILARITY_PENALTY = 3.2;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "against",
  "also",
  "among",
  "another",
  "because",
  "before",
  "being",
  "between",
  "could",
  "does",
  "every",
  "from",
  "given",
  "have",
  "into",
  "itself",
  "more",
  "must",
  "only",
  "other",
  "problem",
  "prove",
  "show",
  "such",
  "than",
  "that",
  "their",
  "there",
  "these",
  "this",
  "through",
  "under",
  "using",
  "when",
  "where",
  "which",
  "with",
  "without",
  "would",
]);

const OBJECT_TERMS = [
  "algebra",
  "analytic",
  "category",
  "code",
  "coloring",
  "combinatorics",
  "design",
  "dynamics",
  "equation",
  "field",
  "geometry",
  "graph",
  "group",
  "hadamard",
  "hypergraph",
  "integer",
  "knot",
  "lattice",
  "manifold",
  "matrix",
  "measure",
  "number",
  "operator",
  "optimization",
  "partition",
  "polynomial",
  "prime",
  "probability",
  "ramsey",
  "recurrence",
  "ring",
  "sequence",
  "set",
  "topology",
];

const STRATEGY_TERMS = [
  "algebraic",
  "analytic",
  "asymptotic",
  "certificate",
  "census",
  "combinatorial",
  "computational",
  "construction",
  "counterexample",
  "enumeration",
  "exact",
  "formal",
  "fourier",
  "geometric",
  "induction",
  "literature",
  "modular",
  "moment",
  "optimization",
  "p-adic",
  "polynomial",
  "probabilistic",
  "recurrence",
  "reduction",
  "sat",
  "search",
  "semidefinite",
  "smt",
  "sos",
  "spectral",
  "topological",
];

const DISCOVERY_LENSES = [
  "explicit open-question sections of recent peer-reviewed papers",
  "established survey articles and research monographs with clearly delimited open problems",
  "human-curated problem databases whose entries link to substantive published mathematics",
  "unresolved boundary cases of known theorems with exact acceptance criteria",
  "computational conjectures with small decisive certificates and a documented human research history",
  "less-publicized specialist problems from fields underrepresented in the existing catalog",
  "problems where a meaningful intermediate lemma is itself sharply falsifiable",
  "open classification or existence questions with independently checkable finite witnesses",
];

export function problemDescriptors(input = {}) {
  const packet = input.packet ?? input;
  const descriptors = new Set();
  const domain = normalizedPhrase(packet.domain);
  if (domain) descriptors.add(`domain:${domain}`);
  for (const token of meaningfulTokens(packet.domain)) {
    descriptors.add(`domain-token:${token}`);
  }

  descriptors.add(
    `verification:${normalizedPhrase(packet.verificationMode || "unknown")}`,
  );
  descriptors.add(
    `falsification:${normalizedPhrase(packet.falsificationType || "unknown")}`,
  );

  const statementText = [
    packet.title,
    packet.domain,
    packet.statement,
  ].join(" ").toLowerCase();
  for (const term of OBJECT_TERMS) {
    if (containsTerm(statementText, term)) descriptors.add(`object:${term}`);
  }
  if (/\b(for every|for all|every|all)\b/i.test(statementText)) {
    descriptors.add("shape:universal");
  }
  if (/\b(there exists|does there exist|existence|exists?)\b/i.test(statementText)) {
    descriptors.add("shape:existential");
  }
  if (/\b(maximum|minimum|exact value|equal to|how many)\b/i.test(statementText)) {
    descriptors.add("shape:extremal-value");
  }
  if (/\b(asymptotic|limit|density|growth rate|infinitely many)\b/i.test(statementText)) {
    descriptors.add("shape:asymptotic");
  }
  if (/\b(finite|bounded|at most|at least)\b/i.test(statementText)) {
    descriptors.add("shape:finite-or-bounded");
  }
  if (Number(packet.counterexampleSearchability ?? 0) >= 4) {
    descriptors.add("route:checkable-counterexample");
  }
  return [...descriptors].sort();
}

export function strategyDescriptors(strategy = {}) {
  const descriptors = new Set();
  for (const value of strategy.noveltyVector ?? []) {
    const normalized = normalizedPhrase(value);
    if (normalized) descriptors.add(`novelty:${normalized}`);
  }
  for (const value of strategy.preferredTools ?? []) {
    const normalized = normalizedPhrase(value);
    if (normalized) descriptors.add(`tool:${normalized}`);
  }

  const text = [
    strategy.title,
    strategy.hypothesis,
    strategy.predictedObservation,
    strategy.falsifier,
  ].join(" ").toLowerCase();
  for (const term of STRATEGY_TERMS) {
    if (containsTerm(text, term)) descriptors.add(`method:${term}`);
  }
  for (const token of meaningfulTokens(text).slice(0, 32)) {
    descriptors.add(`token:${token}`);
  }
  return [...descriptors].sort();
}

export function strategyFingerprint(strategy) {
  return sha256(JSON.stringify(strategyDescriptors(strategy)));
}

export function descriptorSimilarity(left, right) {
  const leftSet = left instanceof Set ? left : new Set(left ?? []);
  const rightSet = right instanceof Set ? right : new Set(right ?? []);
  if (!leftSet.size || !rightSet.size) return 0;
  let intersection = 0;
  for (const value of leftSet) {
    if (rightSet.has(value)) intersection += 1;
  }
  return intersection / (leftSet.size + rightSet.size - intersection);
}

export function selectProblemPortfolio(
  entries,
  {
    count,
    seed,
    cycle = 0,
    selectedPackets = [],
    coverageEntries = entries,
  } = {},
) {
  const limit = Math.max(0, Math.min(Number(count) || 0, entries?.length ?? 0));
  if (!limit) return [];
  const stableSeed = String(seed || "autoprover-quality-diversity");
  const descriptorCounts = attemptedDescriptorCounts(coverageEntries ?? []);
  const contextDescriptors = selectedPackets.map((packet) =>
    new Set(problemDescriptors(packet)),
  );
  const selected = [];
  const pool = [...entries];

  const pinned = pool
    .filter((entry) => entry.operatorPriority)
    .sort(
      (left, right) =>
        String(right.operatorPriority?.requestedAt ?? "").localeCompare(
          String(left.operatorPriority?.requestedAt ?? ""),
        ) ||
        String(left.problemKey ?? "").localeCompare(
          String(right.problemKey ?? ""),
        ),
    );
  for (const entry of pinned) {
    if (selected.length >= limit) break;
    selectEntry(entry, {
      selected,
      pool,
      contextDescriptors,
      descriptorCounts,
      selectionReason: "operator-priority",
    });
  }

  while (selected.length < limit && pool.length) {
    const scored = pool.map((entry) =>
      scorePortfolioCandidate(entry, {
        seed: stableSeed,
        cycle,
        selectionIndex: selected.length,
        contextDescriptors,
        descriptorCounts,
      }),
    );
    scored.sort(
      (left, right) =>
        right.selectionKey - left.selectionKey ||
        String(left.entry.problemKey ?? "").localeCompare(
          String(right.entry.problemKey ?? ""),
        ),
    );
    const winner = scored[0];
    selectEntry(winner.entry, {
      selected,
      pool,
      contextDescriptors,
      descriptorCounts,
      selectionReason: "quality-diversity",
      diagnostics: winner,
    });
  }
  return selected;
}

export function selectDiverseStrategies(
  strategies,
  {
    count,
    seed,
    priorCoverage = [],
  } = {},
) {
  const requested = Math.max(
    0,
    Math.min(Number(count) || 0, strategies?.length ?? 0),
  );
  const stableSeed = String(seed || "autoprover-strategy-diversity");
  const unique = [];
  const seen = new Set();
  for (const [index, strategy] of (strategies ?? []).entries()) {
    const descriptors = strategyDescriptors(strategy);
    const fingerprint = sha256(JSON.stringify(descriptors));
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    unique.push({ strategy, index, descriptors, fingerprint });
  }

  const priorDescriptorSets = (priorCoverage ?? [])
    .map((entry) => entry?.descriptors)
    .filter(Array.isArray)
    .map((descriptors) => new Set(descriptors));
  const selected = [];
  const selectedDescriptorSets = [];
  const pool = [...unique];
  while (selected.length < requested && pool.length) {
    const scored = pool.map((entry) => {
      const currentSimilarity = maximumSimilarity(
        entry.descriptors,
        selectedDescriptorSets,
      );
      const priorSimilarity = maximumSimilarity(
        entry.descriptors,
        priorDescriptorSets,
      );
      const orderQuality =
        1 - 0.25 * (entry.index / Math.max(1, strategies.length - 1));
      const concreteBonus =
        /\b(exact|certificate|witness|checker|refut|contradict|unsat)\b/i.test(
          `${entry.strategy.falsifier} ${entry.strategy.predictedObservation}`,
        )
          ? 0.08
          : 0;
      const jitter =
        0.03 *
        deterministicUnit(
          stableSeed,
          "strategy",
          selected.length,
          entry.fingerprint,
        );
      return {
        ...entry,
        currentSimilarity,
        priorSimilarity,
        selectionKey:
          orderQuality +
          concreteBonus +
          0.75 * (1 - currentSimilarity) +
          0.9 * (1 - priorSimilarity) +
          jitter,
      };
    });
    scored.sort(
      (left, right) =>
        right.selectionKey - left.selectionKey ||
        left.index - right.index,
    );
    const winner = scored[0];
    selected.push({
      ...winner.strategy,
      strategyFingerprint: winner.fingerprint,
      strategyDescriptors: winner.descriptors,
    });
    selectedDescriptorSets.push(new Set(winner.descriptors));
    pool.splice(
      pool.findIndex((entry) => entry.fingerprint === winner.fingerprint),
      1,
    );
  }
  return {
    strategies: selected,
    diagnostics: {
      proposedCount: strategies?.length ?? 0,
      uniqueCount: unique.length,
      selectedCount: selected.length,
      suppressedExactDuplicates: (strategies?.length ?? 0) - unique.length,
      selected: selected.map((strategy) => ({
        id: strategy.id,
        fingerprint: strategy.strategyFingerprint,
        descriptors: strategy.strategyDescriptors,
      })),
    },
  };
}

export function strategyCoverageReceipt(problem = {}) {
  return (problem.branches ?? []).map((branch) => {
    const descriptors = strategyDescriptors(branch.strategy);
    return {
      fingerprint: sha256(JSON.stringify(descriptors)),
      descriptors,
      title: branch.strategy?.title ?? branch.id,
      status: branch.status,
      turns: branch.turns ?? 0,
      verifiedFactCount: branch.verifiedFacts?.length ?? 0,
      failedApproachCount: branch.failedApproaches?.length ?? 0,
    };
  });
}

export function priorStrategyCoverage(problem = {}) {
  return (problem.priorResearch ?? []).flatMap((entry) =>
    Array.isArray(entry.strategyCoverage) ? entry.strategyCoverage : [],
  );
}

export function discoveryDiversityBrief(seed, poolSize) {
  const desired = Math.max(1, Number(poolSize) || 1);
  const ordered = DISCOVERY_LENSES
    .map((lens) => ({
      lens,
      key: deterministicUnit(seed, "discovery-lens", lens),
    }))
    .sort((left, right) => right.key - left.key);
  const lensCount = Math.min(3, ordered.length, desired);
  const lenses = ordered.slice(0, lensCount).map((entry) => entry.lens);
  const subdomainCap = Math.max(1, Math.ceil(desired * 0.25));
  return [
    "Build a quality-diverse pool rather than a ranked list of near-duplicates.",
    `When the search scope permits, return no more than ${subdomainCap} problems from one narrow subdomain.`,
    "A machine-generated conjecture list by itself is not evidence of mathematical interest or genuine open status. Require substantive human mathematical study in papers, surveys, monographs, or an authoritative curated source.",
    "Vary object type, quantifier shape, proof-versus-counterexample direction, and verification method.",
    `For this run, deliberately search these source lanes: ${lenses.join("; ")}.`,
  ].join("\n");
}

function scorePortfolioCandidate(
  entry,
  {
    seed,
    cycle,
    selectionIndex,
    contextDescriptors,
    descriptorCounts,
  },
) {
  const descriptors = problemDescriptors(entry);
  const attemptCount = entry.attempts?.length ?? 0;
  const quality = normalizedQuality(entry);
  const coverage =
    descriptors.reduce(
      (sum, descriptor) =>
        sum + 1 / Math.sqrt(1 + (descriptorCounts.get(descriptor) ?? 0)),
      0,
    ) / Math.max(1, descriptors.length);
  const uncertainty = 1 / Math.sqrt(1 + attemptCount);
  const crowding = clamp(Math.log1p(attemptCount) / Math.log(5), 0, 1);
  const similarity = maximumSimilarity(descriptors, contextDescriptors);
  const utility =
    quality +
    0.09 * coverage +
    0.04 * uncertainty -
    0.04 * crowding;
  const gumbel = deterministicGumbel(
    seed,
    cycle,
    selectionIndex,
    entry.problemKey ?? entry.packet?.statementHash ?? entry.id,
  );
  return {
    entry,
    descriptors,
    quality,
    coverage,
    uncertainty,
    crowding,
    similarity,
    utility,
    selectionKey:
      utility / PROBLEM_SELECTION_TEMPERATURE +
      gumbel -
      PROBLEM_SIMILARITY_PENALTY * similarity,
  };
}

function selectEntry(
  entry,
  {
    selected,
    pool,
    contextDescriptors,
    descriptorCounts,
    selectionReason,
    diagnostics = null,
  },
) {
  const descriptors = diagnostics?.descriptors ?? problemDescriptors(entry);
  selected.push({
    ...entry,
    selection: {
      reason: selectionReason,
      quality: diagnostics?.quality ?? normalizedQuality(entry),
      coverage: diagnostics?.coverage ?? null,
      uncertainty: diagnostics?.uncertainty ?? null,
      crowding: diagnostics?.crowding ?? null,
      similarity: diagnostics?.similarity ?? null,
      descriptors,
    },
  });
  contextDescriptors.push(new Set(descriptors));
  pool.splice(pool.indexOf(entry), 1);
  for (const descriptor of descriptors) {
    descriptorCounts.set(
      descriptor,
      (descriptorCounts.get(descriptor) ?? 0) + 1,
    );
  }
}

function attemptedDescriptorCounts(entries) {
  const counts = new Map();
  for (const entry of entries ?? []) {
    const attempts = entry.attempts?.length ?? 0;
    if (!attempts) continue;
    for (const descriptor of problemDescriptors(entry)) {
      counts.set(descriptor, (counts.get(descriptor) ?? 0) + attempts);
    }
  }
  return counts;
}

function normalizedQuality(entry) {
  const raw = Number(
    entry.ranking?.priority ??
      entry.priority ??
      entry.score ??
      0.5,
  );
  if (!Number.isFinite(raw)) return 0.5;
  return clamp(raw > 1 ? raw / 5.4 : raw, 0.01, 0.99);
}

function maximumSimilarity(descriptors, descriptorSets) {
  if (!descriptorSets?.length) return 0;
  return Math.max(
    0,
    ...descriptorSets.map((other) =>
      descriptorSimilarity(descriptors, other),
    ),
  );
}

function deterministicGumbel(...parts) {
  const unit = clamp(deterministicUnit(...parts), 1e-12, 1 - 1e-12);
  return -Math.log(-Math.log(unit));
}

function deterministicUnit(...parts) {
  const digest = sha256(parts.map(String).join("\u241f"));
  const integer = Number.parseInt(digest.slice(0, 13), 16);
  return (integer + 0.5) / 0x10000000000000;
}

function meaningfulTokens(value) {
  return [
    ...new Set(
      String(value ?? "")
        .normalize("NFKD")
        .toLowerCase()
        .match(/[a-z][a-z0-9-]{2,}/g) ?? [],
    ),
  ]
    .filter((token) => !STOP_WORDS.has(token))
    .sort();
}

function normalizedPhrase(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 96);
}

function containsTerm(text, term) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`, "i").test(text);
}
