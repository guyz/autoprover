import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CampaignStore,
  acquireProblemLease,
  emptyCatalog,
  leaseTokenMatches,
  releaseProblemLease,
} from "../src/campaign-store.mjs";
import {
  catalogProblemKey,
  deduplicateCampaignCandidates,
  isCampaignCandidateEligible,
  rankCampaignCandidates,
  scoreCatalogEntry,
} from "../src/campaign.mjs";

const NOW = new Date("2026-07-23T12:00:00.000Z");

function catalogEntry(overrides = {}) {
  const packet = {
    id: "balanced-problem",
    title: "Balanced problem",
    domain: "combinatorics",
    statement: "Every admissible finite system has property P.",
    statementHash: "statement-balanced",
    assumptions: ["The system is finite."],
    interest: 5,
    tractability: 4,
    verifiability: 5,
    sourceQuality: 5,
    ...overrides.packet,
  };
  return {
    problemKey: packet.statementHash,
    packet,
    lifecycle: "eligible",
    vet: {
      verified: true,
      expiresAt: "2026-08-23T12:00:00.000Z",
    },
    attempts: [],
    maxAttempts: 2,
    cooldownUntil: null,
    lease: null,
    ...overrides,
    packet,
  };
}

test("ranking deterministically balances mathematical interest with predicted solvability", () => {
  const balanced = catalogEntry();
  const easyButMinor = catalogEntry({
    problemKey: "easy-but-minor",
    packet: {
      id: "easy-but-minor",
      title: "Easy but minor",
      statement: "A small finite lookup has property E.",
      statementHash: "easy-but-minor",
      interest: 2,
      tractability: 5,
      verifiability: 5,
      sourceQuality: 5,
    },
  });
  const famousMoonshot = catalogEntry({
    problemKey: "famous-moonshot",
    packet: {
      id: "famous-moonshot",
      title: "Famous moonshot",
      statement: "A celebrated invariant always has property M.",
      statementHash: "famous-moonshot",
      interest: 5,
      tractability: 1,
      verifiability: 1,
      sourceQuality: 5,
    },
  });

  const forward = rankCampaignCandidates(
    [famousMoonshot, easyButMinor, balanced],
    { now: NOW },
  );
  const reverse = rankCampaignCandidates(
    [balanced, easyButMinor, famousMoonshot].reverse(),
    { now: NOW },
  );

  assert.deepEqual(
    forward.map((entry) => entry.problemKey),
    ["statement-balanced", "easy-but-minor", "famous-moonshot"],
  );
  assert.deepEqual(
    reverse.map((entry) => entry.problemKey),
    forward.map((entry) => entry.problemKey),
  );
  assert.ok(forward[0].ranking.priority > forward[1].ranking.priority);
  assert.ok(forward[0].ranking.solvability > forward[2].ranking.solvability);
  assert.match(
    forward[0].ranking.rationale,
    /interest 100%.*predicted solvability.*0 prior attempts/,
  );
});

test("ranking favors only concrete, verifier-backed counterexample routes", () => {
  const noFalsificationRoute = catalogEntry({
    problemKey: "no-falsification-route",
    packet: {
      id: "no-falsification-route",
      title: "No falsification route",
      statement: "Determine the exact value of invariant I.",
      statementHash: "no-falsification-route",
      falsificationType: "not-applicable",
      counterexampleSearchability: 0,
      counterexampleVerificationPlan:
        "The problem asks for a value rather than a falsifiable universal claim.",
    },
  });
  const finiteCounterexample = catalogEntry({
    problemKey: "finite-counterexample",
    packet: {
      id: "finite-counterexample",
      title: "Finite counterexample",
      statement: "Every finite object in C has property P.",
      statementHash: "finite-counterexample",
      verificationMode: "finite-witness",
      falsificationType: "finite-counterexample",
      counterexampleSearchability: 5,
      counterexampleVerificationPlan:
        "Enumerate canonical objects and check P with exact arithmetic.",
    },
  });
  const informalNegation = catalogEntry({
    problemKey: "informal-negation",
    packet: {
      id: "informal-negation",
      title: "Informal negation",
      statement: "Every analytic object in A has property Q.",
      statementHash: "informal-negation",
      verificationMode: "informal-proof",
      falsificationType: "formal-negation",
      counterexampleSearchability: 5,
      counterexampleVerificationPlan:
        "A disproof would still require a long informal analytic argument.",
    },
  });

  const finiteScore = scoreCatalogEntry(finiteCounterexample);
  const neutralScore = scoreCatalogEntry(noFalsificationRoute);
  const informalScore = scoreCatalogEntry(informalNegation);

  assert.equal(finiteScore.counterexampleBonus, 0.08);
  assert.equal(neutralScore.counterexampleBonus, 0);
  assert.equal(informalScore.counterexampleBonus, 0.004);
  assert.ok(finiteScore.priority > neutralScore.priority);
  assert.ok(finiteScore.counterexampleBonus > informalScore.counterexampleBonus);
  assert.match(
    finiteScore.rationale,
    /checkable counterexample opportunity \+8 priority/,
  );
  assert.deepEqual(
    rankCampaignCandidates(
      [noFalsificationRoute, finiteCounterexample],
      { now: NOW },
    ).map((entry) => entry.problemKey),
    ["finite-counterexample", "no-falsification-route"],
  );
});

test("ranking uses a stable problem-key tie break rather than insertion order", () => {
  const first = catalogEntry({
    problemKey: "z-problem",
    packet: {
      id: "z-problem",
      title: "Z problem",
      statement: "Statement Z.",
      statementHash: "z-problem",
    },
  });
  const second = catalogEntry({
    problemKey: "a-problem",
    packet: {
      id: "a-problem",
      title: "A problem",
      statement: "Statement A.",
      statementHash: "a-problem",
    },
  });

  assert.deepEqual(
    rankCampaignCandidates([first, second], { now: NOW }).map(
      (entry) => entry.problemKey,
    ),
    ["a-problem", "z-problem"],
  );
  assert.deepEqual(
    rankCampaignCandidates([second, first], { now: NOW }).map(
      (entry) => entry.problemKey,
    ),
    ["a-problem", "z-problem"],
  );
});

test("an operator pin moves an eligible backlog problem ahead of automatic ranking", () => {
  const automaticFavorite = catalogEntry({
    problemKey: "automatic-favorite",
  });
  const operatorChoice = catalogEntry({
    problemKey: "operator-choice",
    packet: {
      id: "operator-choice",
      title: "Operator choice",
      statement: "A lower-scored exact statement.",
      statementHash: "operator-choice",
      interest: 2,
      tractability: 3,
      verifiability: 3,
      sourceQuality: 4,
    },
    operatorPriority: {
      requestedAt: NOW.toISOString(),
      commandId: "command-operator-choice",
    },
  });

  assert.deepEqual(
    rankCampaignCandidates([automaticFavorite, operatorChoice], {
      now: NOW,
    }).map((entry) => entry.problemKey),
    ["operator-choice", "automatic-favorite"],
  );
});

test("deduplication suppresses statement aliases but preserves a changed version", () => {
  const aliasLowQuality = catalogEntry({
    problemKey: undefined,
    packet: {
      id: "balanced-alias-low",
      title: "Balanced alias",
      statement: "  EVERY admissible finite system has property P. ",
      statementHash: "raw-format-specific-hash-a",
      assumptions: ["the system is finite."],
      sourceQuality: 3,
    },
  });
  const aliasHighQuality = catalogEntry({
    problemKey: undefined,
    packet: {
      id: "balanced-alias-authoritative",
      title: "Balanced authoritative source",
      statement: "Every admissible finite system has property P.",
      statementHash: "raw-format-specific-hash-b",
      assumptions: ["The system is finite."],
      sourceQuality: 5,
    },
  });
  const changedVersion = catalogEntry({
    problemKey: undefined,
    packet: {
      id: "balanced-strengthened",
      title: "Balanced strengthened version",
      statement:
        "Every admissible finite system of size at least two has property P.",
      statementHash: "raw-format-specific-hash-c",
      assumptions: ["The system is finite."],
      sourceQuality: 5,
    },
  });

  assert.equal(
    catalogProblemKey(aliasLowQuality),
    catalogProblemKey(aliasHighQuality),
  );
  assert.notEqual(
    catalogProblemKey(aliasHighQuality),
    catalogProblemKey(changedVersion),
  );
  const deduplicated = deduplicateCampaignCandidates([
    aliasLowQuality,
    changedVersion,
    aliasHighQuality,
  ]);
  assert.equal(deduplicated.length, 2);
  assert.equal(
    deduplicated.find(
      (entry) => catalogProblemKey(entry) === catalogProblemKey(aliasHighQuality),
    ).packet.id,
    "balanced-alias-authoritative",
  );
});

test("cooldown, attempt cap, stale vetting, and a live lease exclude work until eligible", () => {
  const future = "2026-07-23T13:00:00.000Z";
  const past = "2026-07-23T11:00:00.000Z";
  const baseline = catalogEntry();
  const cooldown = catalogEntry({ problemKey: "cooldown", cooldownUntil: future });
  const exhausted = catalogEntry({
    problemKey: "attempt-cap",
    maxAttempts: 2,
    attempts: [{ attemptId: "one" }, { attemptId: "two" }],
  });
  const staleVet = catalogEntry({
    problemKey: "stale-vet",
    vet: { verified: true, expiresAt: past },
  });
  const liveLease = catalogEntry({
    problemKey: "live-lease",
    lease: {
      leaseId: "lease-live",
      fencingToken: "fence-live",
      expiresAt: future,
    },
  });
  const expiredLease = catalogEntry({
    problemKey: "expired-lease",
    lease: {
      leaseId: "lease-expired",
      fencingToken: "fence-expired",
      expiresAt: past,
    },
  });

  assert.equal(isCampaignCandidateEligible(baseline, { now: NOW }), true);
  assert.equal(isCampaignCandidateEligible(cooldown, { now: NOW }), false);
  assert.equal(isCampaignCandidateEligible(exhausted, { now: NOW }), false);
  assert.equal(isCampaignCandidateEligible(staleVet, { now: NOW }), false);
  assert.equal(isCampaignCandidateEligible(liveLease, { now: NOW }), false);
  assert.equal(isCampaignCandidateEligible(expiredLease, { now: NOW }), true);
  assert.deepEqual(
    rankCampaignCandidates(
      [cooldown, exhausted, staleVet, liveLease, expiredLease, baseline],
      { now: NOW },
    ).map((entry) => entry.problemKey),
    ["expired-lease", "statement-balanced"],
  );
  assert.equal(
    isCampaignCandidateEligible(cooldown, {
      now: new Date("2026-07-23T13:00:00.000Z"),
    }),
    true,
  );
});

test("a live lease excludes a duplicate owner and an expired lease advances the fence", () => {
  const entry = catalogEntry();
  const firstLeased = acquireProblemLease(entry, {
    ownerId: "campaign-a",
    attemptId: "attempt-a",
    now: NOW,
    ttlMs: 60_000,
  });
  const first = firstLeased.lease;

  assert.equal(leaseTokenMatches(firstLeased, first), true);
  assert.throws(
    () =>
      acquireProblemLease(firstLeased, {
        ownerId: "campaign-b",
        attemptId: "attempt-b",
        now: new Date(NOW.getTime() + 30_000),
        ttlMs: 60_000,
      }),
    /live lease/,
  );

  const reclaimed = acquireProblemLease(firstLeased, {
    ownerId: "campaign-b",
    attemptId: "attempt-b",
    now: new Date(NOW.getTime() + 60_001),
    ttlMs: 60_000,
  });
  assert.notEqual(reclaimed.lease.leaseId, first.leaseId);
  assert.notEqual(reclaimed.lease.fencingToken, first.fencingToken);
  assert.equal(leaseTokenMatches(reclaimed, first), false);
  assert.equal(leaseTokenMatches(reclaimed, reclaimed.lease), true);
  assert.throws(
    () => releaseProblemLease(reclaimed, first),
    /fencing token does not match/,
  );
  assert.equal(
    releaseProblemLease(reclaimed, reclaimed.lease).lease,
    null,
  );
});

test("concurrent durable lease claims have one winner without surfacing a lock race", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-campaign-lease-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const campaignDir = path.join(root, "campaign");
  const catalogDir = path.join(root, "catalog");
  const store = new CampaignStore(campaignDir, { catalogDir });
  const entry = catalogEntry();
  const catalog = emptyCatalog();
  catalog.entries[entry.problemKey] = entry;
  await store.initialize(
    {
      schemaVersion: 1,
      campaignId: "lease-race",
      status: "running",
      updatedAt: NOW.toISOString(),
    },
    catalog,
  );

  const claims = await Promise.allSettled([
    store.acquireLease(entry.problemKey, {
      ownerId: "worker-a",
      attemptId: "attempt-a",
      now: NOW,
      ttlMs: 60_000,
    }),
    store.acquireLease(entry.problemKey, {
      ownerId: "worker-b",
      attemptId: "attempt-b",
      now: NOW,
      ttlMs: 60_000,
    }),
  ]);

  assert.deepEqual(
    claims.map((claim) => claim.status),
    ["fulfilled", "fulfilled"],
    "contention is an expected scheduling outcome, not an operator-visible lock error",
  );
  const values = claims.map((claim) => claim.value);
  assert.equal(values.filter(Boolean).length, 1);
  assert.equal(values.filter((value) => value === null).length, 1);
  const persisted = await store.readLease(entry.problemKey);
  assert.equal(
    persisted.leaseId,
    values.find(Boolean).leaseId,
  );
});

test("operator commands are durable, ordered, and independently checkpointed", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-commands-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new CampaignStore(path.join(root, "campaign"), {
    catalogDir: path.join(root, "catalog"),
  });
  await store.initialize(
    {
      schemaVersion: 1,
      campaignId: "operator-commands",
      status: "running",
      updatedAt: NOW.toISOString(),
    },
    emptyCatalog(),
  );

  const discover = await store.enqueueCommand("discover");
  const prioritize = await store.enqueueCommand("prioritize", {
    problemKey: "problem-a",
  });
  assert.deepEqual(
    (await store.listCommands({ statuses: ["pending"] })).map(
      (command) => command.type,
    ),
    ["discover", "prioritize"],
  );

  await store.saveCommand(discover, {
    status: "completed",
    completedAt: NOW.toISOString(),
  });
  assert.deepEqual(
    (await store.listCommands({ statuses: ["pending"] })).map(
      (command) => command.id,
    ),
    [prioritize.id],
  );
  assert.equal(
    (await store.listCommands()).find(
      (command) => command.id === discover.id,
    ).status,
    "completed",
  );
});
