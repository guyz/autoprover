import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CampaignController,
  packetWithPriorResearch,
  requestCampaignStop,
} from "../src/campaign.mjs";
import { loadConfig } from "../src/config.mjs";

const usage = {
  inputTokens: 20,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 10,
  reasoningTokens: 0,
};

function problem(index) {
  return {
    id: `campaign-problem-${index}`,
    title: `Campaign problem ${index}`,
    domain: index === 1 ? "combinatorics" : index === 2 ? "number-theory" : "graph-theory",
    statement: `There is no integer n satisfying P_${index}(n).`,
    assumptions: [],
    sourceUrls: [`https://example.test/problems/${index}`],
    openStatusEvidence: ["The fixture's canonical source marks it open."],
    knownResults: [],
    verificationMode: "finite-witness",
    interest: 6 - index,
    tractability: 5,
    verifiability: 5,
    sourceQuality: 5,
    whyPromising: "A small exact witness would be decisive.",
    risks: [],
  };
}

test("a fresh retry receives compact prior research without local paths", () => {
  const entry = {
    packet: problem(1),
    attempts: [
      {
        outcome: "progress-no-solution",
        completedAt: "2026-07-23T19:13:29.888Z",
        note: "Exact search ruled out all witnesses through size 24.",
        evidenceCount: 47,
        runDir: "/private/local/attempt",
      },
    ],
  };

  const packet = packetWithPriorResearch(entry);

  assert.equal(packet.priorResearch.length, 1);
  assert.equal(
    packet.priorResearch[0].report,
    "Exact search ruled out all witnesses through size 24.",
  );
  assert.match(packet.priorResearch[0].instruction, /verify before reuse/i);
  assert.doesNotMatch(JSON.stringify(packet.priorResearch), /private\/local/);
});

function fixture(schemaName) {
  if (schemaName === "research_portfolio_plan") {
    return {
      baseline: "Search the smallest exact cases.",
      acceptanceContract: "Produce and independently check an integer witness.",
      strategies: [
        {
          id: "exact-search",
          title: "Exact search",
          hypothesis: "A small witness exists.",
          predictedObservation: "One exact evaluation contradicts the statement.",
          falsifier: "Every searched exact case satisfies the statement.",
          noveltyVector: ["bounded-exact-search"],
          preferredTools: ["exact arithmetic"],
        },
      ],
    };
  }
  if (schemaName === "research_epoch_result") {
    return {
      status: "candidate",
      progressKind: "candidate",
      summary: "Found and exactly checked a finite witness.",
      verifiedFacts: ["The witness was evaluated with exact arithmetic."],
      plausibleClaims: [],
      failedApproaches: [],
      unresolvedQuestions: [],
      artifacts: [
        {
          name: "exact-check",
          kind: "code",
          content: "assert P(17)",
          verification: "Run using exact integer arithmetic.",
        },
      ],
      candidate: {
        present: true,
        kind: "disproof",
        claim: "n=17 is a counterexample.",
        solution: "Direct exact evaluation gives P(17).",
        verificationPlan: "Recompute P(17) independently.",
      },
      nextAction: "verify",
      nextActionReason: "The finite witness is ready for checking.",
    };
  }
  if (schemaName === "candidate_verification") {
    return {
      verdict: "pass",
      statementAlignment: "The witness negates the exact universal statement.",
      exactnessAssessment: "Only exact integer arithmetic is used.",
      reproducedChecks: ["Independently recomputed P(17)."],
      fatalIssues: [],
      nonFatalIssues: [],
      independentArtifact: "The independent checker accepted n=17.",
      recommendedStatus: "mechanically-verified-candidate",
      feedbackToResearcher: "The check passed.",
    };
  }
  if (schemaName === "portfolio_synthesis") {
    return {
      sharedVerifiedFacts: [],
      rejectedClaims: [],
      duplicateDirections: [],
      informationGain: false,
      portfolioSummary: "No additional synthesis was needed.",
      branchDirectives: [],
      candidate: {
        present: false,
        kind: "none",
        claim: "",
        solution: "",
        verificationPlan: "",
      },
    };
  }
  throw new Error(`No test fixture for schema ${schemaName}`);
}

function problemIdFromOperationKey(operationKey = "") {
  return String(operationKey).match(/^problem:([^:]+):/)?.[1] ?? "unknown";
}

class TrackingFixtureProvider {
  constructor({ delayMs = 15 } = {}) {
    this.delayMs = delayMs;
    this.calls = [];
    this.activeByProblem = new Map();
    this.maxConcurrentProblems = 0;
    this.concurrentProblemSnapshots = [];
  }

  async run(request) {
    const problemId = problemIdFromOperationKey(request.operationKey);
    const sessionId = `campaign-fixture-${this.calls.length + 1}`;
    this.calls.push({
      schema: request.schema.name,
      operationKey: request.operationKey,
      problemId,
    });
    await request.onStarted?.(sessionId);
    this.activeByProblem.set(
      problemId,
      (this.activeByProblem.get(problemId) ?? 0) + 1,
    );
    const activeProblems = [...this.activeByProblem]
      .filter(([, count]) => count > 0)
      .map(([id]) => id)
      .sort();
    this.maxConcurrentProblems = Math.max(
      this.maxConcurrentProblems,
      activeProblems.length,
    );
    this.concurrentProblemSnapshots.push(activeProblems);
    try {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return {
        sessionId,
        usage,
        evidence: [],
        data: fixture(request.schema.name),
      };
    } finally {
      const remaining = (this.activeByProblem.get(problemId) ?? 1) - 1;
      if (remaining) this.activeByProblem.set(problemId, remaining);
      else this.activeByProblem.delete(problemId);
    }
  }
}

async function campaignFixture(
  root,
  {
    provider = new TrackingFixtureProvider(),
    problems = [problem(1), problem(2), problem(3)],
    parallelProblems = 2,
    maxCalls = 30,
    providerName = "max",
    policy = {},
  } = {},
) {
  const config = await loadConfig(null, {
    runRoot: root,
    provider: "max",
    wallClockHours: 1,
    parallelProblems,
    branchesPerProblem: 1,
    maxConcurrentCalls: Math.max(2, parallelProblems),
    maxCalls,
    maxTurnsPerBranch: 1,
    maxNoProgressEpochs: 1,
    maxPortfolioStagnationRounds: 1,
    independentVerificationPasses: 1,
    roundCooldownSeconds: 0,
    discovery: {
      poolSize: Math.max(3, problems.length),
      attackCount: Math.max(3, problems.length),
      minimumInterest: 1,
      minimumTractability: 1,
      minimumVerifiability: 1,
    },
  });
  const campaignDir = path.join(root, "campaign");
  const discoveryCycles = [];
  const controller = await CampaignController.create({
    config,
    provider,
    providerName,
    campaignDir,
    policy: {
      durationHours: 1,
      problemHours: 1,
      parallelProblems,
      maxConcurrentCalls: Math.max(2, parallelProblems),
      maxCalls,
      maxCycles: 1,
      catalogLowWatermark: 1,
      discoveryRefreshMs: 0,
      idlePollMs: 2,
      leaseTtlMs: 10_000,
      leaseHeartbeatMs: 2_000,
      ...policy,
    },
    dependencies: {
      discoveryRunner: async ({ cycle }) => {
        discoveryCycles.push(cycle);
        return problems;
      },
    },
  });
  return {
    campaignDir,
    config,
    controller,
    discoveryCycles,
    provider,
  };
}

test(
  "campaign discovery fills the catalog, distinct slots run distinct problems, and completed slots refill",
  { timeout: 8_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-campaign-e2e-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = await campaignFixture(root, {
      // Keep fake calls open long enough for the second problem to enter the
      // shared semaphore even when the test runs beside CPU-heavy live agents.
      provider: new TrackingFixtureProvider({ delayMs: 300 }),
    });

    const snapshot = await setup.controller.run();

    assert.deepEqual(setup.discoveryCycles, [1]);
    assert.equal(snapshot.counts.catalog, 3);
    assert.equal(snapshot.counts.candidates, 3);
    assert.equal(snapshot.counts.active, 0);
    assert.equal(snapshot.completedProblems.length, 3);
    assert.ok(
      snapshot.completedProblems.every(
        (entry) =>
          entry.branches.length === 1 &&
          entry.verification.length === 1 &&
          entry.coordinatorNote,
      ),
      "completed problems retain their final branch, verification, and coordinator detail",
    );
    assert.equal(setup.controller.state.status, "completed");
    const attempts = Object.values(setup.controller.state.attempts);
    assert.equal(attempts.length, 3);
    assert.equal(new Set(attempts.map((attempt) => attempt.problemKey)).size, 3);
    assert.ok(attempts.every((attempt) => attempt.projectedAt));
    assert.ok(attempts.every((attempt) => attempt.outcome === "candidate"));
    assert.deepEqual(
      [...new Set(attempts.map((attempt) => attempt.slotId))].sort(),
      [1, 2],
    );
    assert.ok(
      attempts.some(
        (attempt) =>
          attempts.filter((other) => other.slotId === attempt.slotId).length > 1,
      ),
      "a released slot should be refilled with the third problem",
    );
    assert.equal(setup.provider.maxConcurrentProblems, 2);
    assert.ok(
      setup.provider.concurrentProblemSnapshots.every(
        (ids) => ids.length === new Set(ids).size,
      ),
      "no concurrent snapshot may contain the same problem twice",
    );

    const catalog = JSON.parse(
      await readFile(path.join(root, "_catalog", "catalog.json"), "utf8"),
    );
    assert.equal(Object.keys(catalog.entries).length, 3);
    assert.ok(
      Object.values(catalog.entries).every(
        (entry) =>
          entry.attempts.length === 1 &&
          entry.lifecycle === "candidate-review" &&
          entry.lease === null,
      ),
    );
  },
);

test(
  "a shared campaign maxCalls gate cannot oversubscribe across parallel child runs",
  { timeout: 8_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-campaign-cap-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = new TrackingFixtureProvider({ delayMs: 30 });
    const setup = await campaignFixture(root, {
      provider,
      parallelProblems: 3,
      maxCalls: 2,
    });

    await setup.controller.run();

    assert.equal(provider.calls.length, 2);
    assert.equal(setup.controller.state.budget.callsStarted, 2);
    assert.equal(
      setup.controller.state.budget.callsCompleted +
        setup.controller.state.budget.callsFailed,
      2,
    );
    assert.equal(setup.controller.state.budget.inFlight, 0);
    assert.equal(setup.controller.state.status, "budget-exhausted");
  },
);

test(
  "a continuous subscription campaign renews call batches until its time boundary",
  { timeout: 8_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-continuous-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = new TrackingFixtureProvider({ delayMs: 15 });
    const setup = await campaignFixture(root, {
      provider,
      parallelProblems: 3,
      maxCalls: 2,
      policy: {
        continuous: true,
        callBudgetBatch: 2,
      },
    });

    const snapshot = await setup.controller.run();

    assert.equal(provider.calls.length, 9);
    assert.equal(setup.controller.state.budget.callsStarted, 9);
    assert.equal(setup.controller.state.status, "completed");
    assert.equal(snapshot.campaign.continuous, true);
    assert.ok(setup.controller.state.policy.maxCalls >= 10);
    assert.equal(setup.controller.state.policy.callBudgetBatch, 2);
    assert.ok(
      setup.controller.state.notes.some((note) =>
        /renewed its call allowance/i.test(note.message),
      ),
    );
  },
);

test(
  "an API-billed campaign keeps its hard call cap even if continuous is requested",
  { timeout: 8_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-api-cap-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const provider = new TrackingFixtureProvider({ delayMs: 15 });
    const setup = await campaignFixture(root, {
      provider,
      providerName: "pro",
      parallelProblems: 3,
      maxCalls: 2,
      policy: {
        continuous: true,
        callBudgetBatch: 2,
      },
    });

    const snapshot = await setup.controller.run();

    assert.equal(provider.calls.length, 2);
    assert.equal(snapshot.campaign.status, "budget-exhausted");
    assert.equal(setup.controller.state.policy.maxCalls, 2);
    assert.equal(setup.controller.state.budget.callsStarted, 2);
  },
);

test(
  "a campaign whose deadline has already arrived starts no discovery or research",
  { timeout: 4_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-deadline-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = await campaignFixture(root);
    setup.controller.state.deadlineAt = new Date(
      Date.now() - 1_000,
    ).toISOString();

    const snapshot = await setup.controller.run();

    assert.equal(snapshot.campaign.status, "deadline-reached");
    assert.equal(snapshot.campaign.timeLeftMs, 0);
    assert.equal(setup.provider.calls.length, 0);
    assert.deepEqual(setup.discoveryCycles, []);
  },
);

test(
  "operator nudges trigger targeted discovery, pin backlog work, and checkpoint switches",
  { timeout: 4_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-nudges-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = await campaignFixture(root);

    const discoveryCommand = await setup.controller.store.enqueueCommand(
      "add-problem",
      { query: "https://example.test/requested-open-problem" },
    );
    await setup.controller.processControlCommands();
    await setup.controller.operatorDiscoveryPromise;
    const completedDiscovery = (await setup.controller.store.listCommands()).find(
      (command) => command.id === discoveryCommand.id,
    );
    assert.equal(completedDiscovery.status, "completed");
    assert.deepEqual(setup.discoveryCycles, [1]);
    assert.deepEqual(
      setup.controller.state.discoveryRuns["1"].hints,
      ["https://example.test/requested-open-problem"],
    );

    const catalog = await setup.controller.store.loadCatalog();
    const problemKey = Object.keys(catalog.entries)[2];
    const prioritize = await setup.controller.store.enqueueCommand(
      "prioritize",
      { problemKey },
    );
    await setup.controller.processControlCommands();
    const prioritizedCatalog = await setup.controller.store.loadCatalog();
    assert.equal(
      prioritizedCatalog.entries[problemKey].operatorPriority.commandId,
      prioritize.id,
    );

    const attemptId = "attempt-switch-fixture";
    setup.controller.state.attempts[attemptId] = {
      attemptId,
      problemKey,
      projectedAt: null,
      status: "running",
    };
    Object.assign(setup.controller.state.slots[0], {
      status: "running",
      problemKey,
      attemptId,
    });
    const switchCommand = await setup.controller.store.enqueueCommand("switch", {
      attemptId,
      problemKey,
      reason: "Try another backlog item",
    });
    await setup.controller.processControlCommands();
    assert.ok(
      setup.controller.state.attempts[attemptId].switchRequestedAt,
    );
    assert.equal(
      (await setup.controller.store.listCommands()).find(
        (command) => command.id === switchCommand.id,
      ).status,
      "running",
    );
  },
);

test(
  "an operator stop request prevents new discovery or child work",
  { timeout: 4_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-campaign-stop-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = await campaignFixture(root);
    await requestCampaignStop(setup.campaignDir, "Pause for operator review");

    const snapshot = await setup.controller.run();

    assert.equal(snapshot.campaign.status, "stopped");
    assert.equal(snapshot.campaign.stopReason, "Pause for operator review");
    assert.deepEqual(setup.discoveryCycles, []);
    assert.equal(setup.provider.calls.length, 0);
    assert.equal(Object.keys(setup.controller.state.attempts).length, 0);
  },
);

test(
  "a campaign deadline pauses the exact child attempt and resume keeps its run directory",
  { timeout: 4_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-checkpoint-resume-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = await campaignFixture(root, {
      problems: [problem(1)],
      parallelProblems: 1,
    });
    await setup.controller.mergeCatalogProblems([problem(1)], {
      source: "checkpoint-test",
      vetted: true,
    });
    const catalog = await setup.controller.store.loadCatalog();
    const entry = Object.values(catalog.entries)[0];
    const attempt = await setup.controller.startAttempt(
      setup.controller.state.slots[0],
      entry,
    );
    assert.ok(attempt);
    await mkdir(attempt.runDir, { recursive: true });
    const childState = {
      status: "deadline-reached",
      deadlineAt: new Date(Date.now() - 1_000).toISOString(),
      stopReason: "Wall-clock deadline reached",
      budget: { callsStarted: 3 },
      problems: [
        {
          packet: entry.packet,
          status: "deadline-reached",
          stopReason: "Wall-clock deadline reached",
          round: 1,
          activeWorkMs: 60_000,
          evidenceKeys: [],
          branches: [],
          verificationRuns: [],
        },
      ],
    };
    await writeFile(
      path.join(attempt.runDir, "run.json"),
      `${JSON.stringify(childState, null, 2)}\n`,
      "utf8",
    );
    setup.controller.state.deadlineAt = new Date(
      Date.now() - 1_000,
    ).toISOString();

    await setup.controller.projectFinishedAttempt(attempt, childState);

    assert.equal(attempt.status, "paused");
    assert.equal(attempt.projectedAt, null);
    assert.equal(setup.controller.state.slots[0].status, "paused");
    assert.equal(setup.controller.state.slots[0].attemptId, attempt.attemptId);
    const pausedCatalog = await setup.controller.store.loadCatalog();
    assert.equal(pausedCatalog.entries[entry.problemKey].attempts.length, 0);
    assert.equal(
      pausedCatalog.entries[entry.problemKey].lease.attemptId,
      attempt.attemptId,
    );

    const resumed = await CampaignController.resume({
      config: setup.config,
      provider: new TrackingFixtureProvider(),
      providerName: "max",
      campaignDir: setup.campaignDir,
      extendHours: 0.25,
    });
    const launches = [];
    resumed.launchAttemptWorker = (candidate, options) => {
      launches.push({ candidate, options });
    };
    await resumed.reconcile();

    assert.equal(launches.length, 1);
    assert.equal(launches[0].candidate.attemptId, attempt.attemptId);
    assert.equal(launches[0].candidate.runDir, attempt.runDir);
    assert.equal(launches[0].options.resume, true);
  },
);

test(
  "resume repairs an older controller's projected deadline attempt",
  { timeout: 4_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-legacy-resume-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = await campaignFixture(root, {
      problems: [problem(1)],
      parallelProblems: 1,
    });
    await setup.controller.mergeCatalogProblems([problem(1)], {
      source: "legacy-checkpoint-test",
      vetted: true,
    });
    const catalog = await setup.controller.store.loadCatalog();
    const entry = Object.values(catalog.entries)[0];
    const attempt = await setup.controller.startAttempt(
      setup.controller.state.slots[0],
      entry,
    );
    await mkdir(attempt.runDir, { recursive: true });
    await writeFile(
      path.join(attempt.runDir, "run.json"),
      `${JSON.stringify(
        {
          status: "deadline-reached",
          deadlineAt: new Date(Date.now() - 1_000).toISOString(),
          budget: { callsStarted: 3 },
          problems: [
            {
              packet: entry.packet,
              status: "deadline-reached",
              branches: [],
              verificationRuns: [],
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await setup.controller.store.releaseLease(
      attempt.problemKey,
      attempt.lease,
    );
    const completedAt = new Date(Date.now() - 500).toISOString();
    await setup.controller.store.withCatalogLock(async (lockedCatalog) => {
      const lockedEntry = lockedCatalog.entries[attempt.problemKey];
      lockedEntry.attempts.push({
        attemptId: attempt.attemptId,
        outcome: "progress-no-solution",
        completedAt,
        hasCandidate: false,
        childStatus: "deadline-reached",
        note: "Saved useful work before the deadline.",
      });
      lockedEntry.lifecycle = "cooldown";
      lockedEntry.cooldownUntil = new Date(Date.now() + 60_000).toISOString();
    });
    Object.assign(attempt, {
      status: "completed",
      completedAt,
      projectedAt: completedAt,
      outcome: "progress-no-solution",
    });
    Object.assign(setup.controller.state.slots[0], {
      status: "idle",
      problemKey: null,
      attemptId: null,
      runDir: null,
      startedAt: null,
      latestNote: "",
    });

    await setup.controller.restoreLegacyBoundaryAttempts();

    assert.equal(attempt.status, "paused");
    assert.equal(attempt.projectedAt, null);
    assert.equal(attempt.runDir, setup.controller.state.slots[0].runDir);
    assert.equal(setup.controller.state.slots[0].status, "paused");
    const repairedCatalog = await setup.controller.store.loadCatalog();
    assert.equal(
      repairedCatalog.entries[attempt.problemKey].attempts.length,
      0,
    );
    assert.equal(
      repairedCatalog.entries[attempt.problemKey].lease.attemptId,
      attempt.attemptId,
    );
  },
);

test(
  "resume clears a durable stop request, extends the deadline, and continues the campaign",
  { timeout: 8_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-resume-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const setup = await campaignFixture(root);
    const originalDeadline = Date.parse(setup.controller.state.deadlineAt);
    await requestCampaignStop(setup.campaignDir, "Pause before discovery");
    const stoppedSnapshot = await setup.controller.run();
    assert.equal(setup.controller.state.status, "stopped");
    assert.ok(setup.controller.state.pausedRemainingMs > 0);
    assert.equal(
      stoppedSnapshot.campaign.timeLeftMs,
      setup.controller.state.pausedRemainingMs,
    );

    const resumeDiscoveryCycles = [];
    const resumedProvider = new TrackingFixtureProvider();
    const resumed = await CampaignController.resume({
      config: setup.config,
      provider: resumedProvider,
      providerName: "max",
      campaignDir: setup.campaignDir,
      extendHours: 0.25,
      dependencies: {
        discoveryRunner: async ({ cycle }) => {
          resumeDiscoveryCycles.push(cycle);
          return [problem(1), problem(2), problem(3)];
        },
      },
    });

    const snapshot = await resumed.run();

    assert.deepEqual(resumeDiscoveryCycles, [1]);
    assert.equal(snapshot.campaign.status, "completed");
    assert.equal(snapshot.counts.candidates, 3);
    assert.ok(
      Date.parse(resumed.state.deadlineAt) >= originalDeadline + 0.25 * 60 * 60 * 1_000,
    );
    assert.equal(resumedProvider.calls.length, 9);
    await assert.rejects(
      () => readFile(path.join(setup.campaignDir, "stop-request.json"), "utf8"),
      (error) => error?.code === "ENOENT",
    );
  },
);
