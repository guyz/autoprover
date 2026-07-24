import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { Autoprover } from "../src/orchestrator.mjs";

const problem = {
  id: "resume-phase-problem",
  title: "Resume phase problem",
  domain: "combinatorics",
  statement: "There is no integer n satisfying P(n).",
  assumptions: [],
  sourceUrls: ["https://mathworld.wolfram.com/"],
  openStatusEvidence: ["The test fixture is treated as open."],
  knownResults: [],
  verificationMode: "finite-witness",
  interest: 4,
  tractability: 5,
  verifiability: 5,
  sourceQuality: 5,
  whyPromising: "A finite witness is decisive.",
  risks: [],
};

const emptyUsage = {
  inputTokens: 10,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 10,
  reasoningTokens: 0,
};

function plan() {
  return {
    baseline: "Search exactly.",
    acceptanceContract: "Produce and independently check an exact witness.",
    strategies: [
      {
        id: "exact-search",
        title: "Exact search",
        hypothesis: "A small witness exists.",
        predictedObservation: "P(17) holds.",
        falsifier: "Exact evaluation rejects it.",
        noveltyVector: ["finite-search"],
        preferredTools: ["exact arithmetic"],
      },
    ],
  };
}

function epoch({ candidate = true } = {}) {
  return {
    status: candidate ? "candidate" : "progress",
    progressKind: candidate ? "candidate" : "verified-fact",
    summary: candidate ? "Found an exact witness." : "Established one exact fact.",
    verifiedFacts: ["P(17) was evaluated exactly."],
    plausibleClaims: [],
    failedApproaches: [],
    unresolvedQuestions: candidate ? [] : ["Whether the fact extends."],
    artifacts: candidate
      ? [
          {
            name: "checker",
            kind: "code",
            content: "assert P(17)",
            verification: "Run with exact integer arithmetic.",
          },
        ]
      : [],
    candidate: candidate
      ? {
          present: true,
          kind: "disproof",
          claim: "n=17 is a counterexample.",
          solution: "Direct exact evaluation gives P(17).",
          verificationPlan: "Recompute independently.",
        }
      : {
          present: false,
          kind: "none",
          claim: "",
          solution: "",
          verificationPlan: "",
        },
    nextAction: candidate ? "verify" : "deepen",
    nextActionReason: candidate
      ? "The witness is ready for checking."
      : "Continue from the exact fact.",
  };
}

function verification() {
  return {
    verdict: "pass",
    statementAlignment: "The witness negates the exact statement.",
    exactnessAssessment: "Only exact integer arithmetic is used.",
    reproducedChecks: ["Independently recomputed P(17)."],
    fatalIssues: [],
    nonFatalIssues: [],
    independentArtifact: "Independent exact checker accepted n=17.",
    recommendedStatus: "mechanically-verified-candidate",
    feedbackToResearcher: "The check passed.",
  };
}

function synthesis() {
  return {
    sharedVerifiedFacts: ["P(17) was evaluated exactly."],
    rejectedClaims: [],
    duplicateDirections: [],
    informationGain: true,
    portfolioSummary: "The first round produced a reusable exact fact.",
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

class FixtureProvider {
  constructor({ candidate = true } = {}) {
    this.candidate = candidate;
    this.calls = [];
  }

  async run(request) {
    this.calls.push({
      schema: request.schema.name,
      operationKey: request.operationKey,
      resumeId: request.resumeId ?? null,
    });
    const sessionId = `fixture-${this.calls.length}`;
    await request.onStarted?.(sessionId);
    const data =
      request.schema.name === "research_portfolio_plan"
        ? plan()
        : request.schema.name === "research_epoch_result"
          ? epoch({ candidate: this.candidate })
          : request.schema.name === "candidate_verification"
            ? verification()
            : synthesis();
    return { sessionId, data, usage: emptyUsage, evidence: [] };
  }
}

class PendingSynthesisProvider extends FixtureProvider {
  async run(request) {
    if (request.schema.name !== "portfolio_synthesis") {
      return super.run(request);
    }
    this.calls.push({
      schema: request.schema.name,
      operationKey: request.operationKey,
      resumeId: request.resumeId ?? null,
    });
    await request.onStarted?.("pending-synthesis-session");
    const error = new Error("Manual synthesis response is pending");
    error.code = "AUTOPROVER_MANUAL_RESPONSE_PENDING";
    error.packetId = "pending-synthesis-session";
    error.packetDir = "/tmp/manual-synthesis";
    error.resumable = true;
    throw error;
  }
}

async function createSeeded(root, configOverrides, provider) {
  const config = await loadConfig(null, {
    runRoot: root,
    provider: "max",
    parallelProblems: 1,
    branchesPerProblem: 1,
    maxConcurrentCalls: 1,
    roundCooldownSeconds: 0,
    ...configOverrides,
  });
  const runDir = path.join(root, "run");
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "max",
    runDir,
  });
  await app.seedProblems([problem], { vet: false });
  return { app, config, runDir };
}

test(
  "a final solver call preserves its candidate at the budget boundary and a raised cap resumes verification",
  { timeout: 2_000 },
  async (t) => {
    const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-phase-budget-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const firstProvider = new FixtureProvider();
    const { app, runDir } = await createSeeded(
      root,
      {
        maxCalls: 2,
        independentVerificationPasses: 2,
      },
      firstProvider,
    );

    await app.run();
    const stopped = app.state.problems[0];
    assert.equal(app.state.status, "budget-exhausted");
    assert.equal(stopped.pendingCandidates.length, 1);
    assert.equal(stopped.pendingSynthesisRound, null);
    assert.equal(stopped.branches[0].lastCompletedRound, 1);

    const raisedConfig = await loadConfig(null, {
      ...app.state.configSnapshot,
      runRoot: root,
      provider: "max",
      maxCalls: 4,
    });
    const resumedProvider = new FixtureProvider();
    const resumed = await Autoprover.resume({
      config: raisedConfig,
      provider: resumedProvider,
      providerName: "max",
      runDir,
    });
    await resumed.run();

    assert.equal(
      resumed.state.problems[0].status,
      "candidate-complete-agent-reproduced",
    );
    assert.deepEqual(
      resumedProvider.calls.map((entry) => entry.schema),
      ["candidate_verification", "candidate_verification"],
    );
    assert.equal(resumed.state.budget.callsStarted, 4);
  },
);

test("a completed synthesis checkpoint is applied before any later branch turn", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-phase-synthesis-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new PendingSynthesisProvider({ candidate: false });
  const { app } = await createSeeded(
    root,
    {
      maxCalls: 6,
      maxTurnsPerBranch: 1,
      maxPortfolioStagnationRounds: 3,
      skipSingleBranchSynthesis: false,
    },
    provider,
  );

  await app.run();
  const state = app.state.problems[0];
  assert.equal(app.state.status, "awaiting-manual");
  assert.equal(state.pendingSynthesisRound, 1);
  const operationKey = `problem:${problem.id}:synthesis:1`;
  const operation = app.state.operations[operationKey];
  operation.status = "completed";
  operation.completedAt = new Date().toISOString();
  operation.result = {
    sessionId: operation.sessionId,
    data: synthesis(),
    usage: emptyUsage,
    evidencePath: null,
  };
  await app.store.save(app.state);
  const callCountBeforeReplay = provider.calls.length;

  await app.run();

  assert.equal(provider.calls.length, callCountBeforeReplay);
  assert.equal(app.state.problems[0].syntheses.length, 1);
  assert.equal(app.state.problems[0].syntheses[0].round, 1);
  assert.equal(app.state.problems[0].branches[0].turns, 1);
  assert.equal(app.state.problems[0].status, "exhausted-no-result");
});

test("resume owns the lock before reading or changing checkpoint configuration", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-resume-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const provider = new FixtureProvider();
  const { app, runDir } = await createSeeded(
    root,
    { maxCalls: 5 },
    provider,
  );
  const firstConfig = await loadConfig(null, {
    ...app.state.configSnapshot,
    provider: "max",
    maxCalls: 10,
  });
  const first = await Autoprover.resume({
    config: firstConfig,
    provider,
    providerName: "max",
    runDir,
  });
  const secondConfig = await loadConfig(null, {
    ...app.state.configSnapshot,
    provider: "max",
    maxCalls: 20,
  });
  await assert.rejects(
    () =>
      Autoprover.resume({
        config: secondConfig,
        provider,
        providerName: "max",
        runDir,
      }),
    /already active/,
  );
  const stored = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  assert.equal(stored.configSnapshot.maxCalls, 10);
  await first.store.releaseLock();
  first.lockHeld = false;
});

test("API usage is charged even when the returned output fails validation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-failed-usage-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    provider: "pro",
    maxCalls: 2,
  });
  const app = await Autoprover.create({
    config,
    provider: {
      async run(request) {
        await request.onStarted?.("billed-invalid-output");
        return {
          sessionId: "billed-invalid-output",
          data: { wrong: true },
          usage: {
            inputTokens: 1_000,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 1_000,
            reasoningTokens: 0,
          },
          evidence: [],
        };
      },
    },
    providerName: "pro",
    runDir: path.join(root, "run"),
  });

  await assert.rejects(
    () =>
      app.callModel({
        operationKey: "test:billed-invalid",
        role: "critic",
        prompt: "Return a valid answer.",
        schema: {
          name: "strict_answer",
          schema: {
            type: "object",
            additionalProperties: false,
            properties: { answer: { type: "string" } },
            required: ["answer"],
          },
        },
        workingDir: path.join(root, "work"),
        tools: { webSearch: false, codeInterpreter: false },
      }),
    /does not match/,
  );
  assert.equal(app.state.budget.inputTokens, 1_000);
  assert.equal(app.state.budget.outputTokens, 1_000);
  assert.ok(app.state.budget.estimatedUsd > 0);
  assert.equal(app.state.budget.callsFailed, 1);
});
