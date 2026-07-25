import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import { Autoprover } from "../src/orchestrator.mjs";

class FakeProvider {
  constructor() {
    this.count = 0;
  }

  async run(request) {
    this.count += 1;
    const sessionId = `fake-${this.count}`;
    await request.onStarted?.(sessionId);
    return {
      sessionId,
      usage: { inputTokens: 100, cachedInputTokens: 0, outputTokens: 50, reasoningTokens: 10 },
      data: fixture(request.schema.name),
    };
  }
}

class NeedsExpertProvider extends FakeProvider {
  async run(request) {
    const result = await super.run(request);
    if (request.schema.name === "candidate_verification") {
      result.data.recommendedStatus = "needs-expert-review";
    }
    return result;
  }
}

class MachineGeneratedOnlyProvider extends FakeProvider {
  async run(request) {
    const result = await super.run(request);
    if (request.schema.name === "problem_vetting") {
      result.data.substantiveHumanStudyVerified = false;
      result.data.recommendation = "reject";
      result.data.materialErrors = [
        "The only provenance is an automatically generated conjecture list.",
      ];
    }
    return result;
  }
}

class BudgetFanoutProvider extends FakeProvider {
  constructor() {
    super();
    this.activeEpochs = 0;
  }

  async run(request) {
    if (request.schema.name === "research_portfolio_plan") {
      const result = await super.run(request);
      result.data.strategies.push({
        ...result.data.strategies[0],
        id: "exact-search-two",
        title: "Independent exact search",
        noveltyVector: ["second-finite-search"],
      });
      return result;
    }
    if (request.schema.name === "research_epoch_result") {
      this.count += 1;
      const sessionId = `fake-${this.count}`;
      await request.onStarted?.(sessionId);
      this.activeEpochs += 1;
      await new Promise((resolve) => setTimeout(resolve, 40));
      this.activeEpochs -= 1;
      return {
        sessionId,
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
        data: {
          status: "progress",
          progressKind: "search-pruning",
          decisiveProgress: "bounded-check",
          coverageOfExactStatement: "bounded",
          remainingBlockers: ["The unbounded case remains."],
          summary: "Finished one bounded search.",
          verifiedFacts: ["One bounded interval was checked exactly."],
          plausibleClaims: [],
          failedApproaches: [],
          unresolvedQuestions: ["The remaining interval."],
          artifacts: [],
          candidate: { present: false, kind: "none", claim: "", solution: "", verificationPlan: "" },
          nextAction: "deepen",
          nextActionReason: "Search the next interval.",
        },
      };
    }
    return super.run(request);
  }
}

class RedundantPlannerProvider extends FakeProvider {
  async run(request) {
    if (request.schema.name !== "research_portfolio_plan") {
      return super.run(request);
    }
    this.count += 1;
    const sessionId = `fake-${this.count}`;
    await request.onStarted?.(sessionId);
    const exact = {
      id: "exact-search",
      title: "Exact bounded search",
      hypothesis: "A small witness exists.",
      predictedObservation: "An exact witness appears.",
      falsifier: "An exact checker rejects every case.",
      noveltyVector: ["bounded exact search"],
      preferredTools: ["python"],
    };
    return {
      sessionId,
      usage: {
        inputTokens: 100,
        cachedInputTokens: 0,
        outputTokens: 50,
        reasoningTokens: 10,
      },
      data: {
        baseline: "Search exactly.",
        acceptanceContract: "Produce a checked witness.",
        strategies: [
          exact,
          { ...exact, id: "exact-search-renamed" },
          {
            id: "spectral",
            title: "Spectral obstruction",
            hypothesis: "An eigenvalue inequality is decisive.",
            predictedObservation: "A forbidden spectrum is forced.",
            falsifier: "A checked matrix violates the inequality.",
            noveltyVector: ["spectral representation"],
            preferredTools: ["sage"],
          },
          {
            id: "sat",
            title: "Proof-carrying SAT",
            hypothesis: "The exact encoding is unsatisfiable.",
            predictedObservation: "A checked UNSAT certificate appears.",
            falsifier: "A satisfying model passes the exact checker.",
            noveltyVector: ["proof carrying sat"],
            preferredTools: ["cadical"],
          },
          {
            id: "probabilistic",
            title: "Probabilistic construction",
            hypothesis: "A random construction succeeds.",
            predictedObservation: "A moment bound gives positive probability.",
            falsifier: "An exact dependency calculation defeats the bound.",
            noveltyVector: ["probabilistic construction"],
            preferredTools: ["symbolic algebra"],
          },
        ],
      },
    };
  }
}

class LoopWithoutCandidateProvider extends FakeProvider {
  constructor() {
    super();
    this.epochSessionInputs = [];
  }

  async run(request) {
    if (request.schema.name === "research_epoch_result") {
      this.count += 1;
      this.epochSessionInputs.push(request.sessionId ?? null);
      const sessionId = `fake-${this.count}`;
      await request.onStarted?.(sessionId);
      return {
        sessionId,
        usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10, reasoningTokens: 0 },
        data: {
          status: "progress",
          progressKind: "verified-fact",
          decisiveProgress: "reusable-lemma",
          coverageOfExactStatement: "conditional",
          remainingBlockers: ["Remove the auxiliary hypothesis."],
          summary: "Rechecked the same elementary fact.",
          verifiedFacts: ["The base case holds."],
          plausibleClaims: [],
          failedApproaches: [],
          unresolvedQuestions: ["The induction step."],
          artifacts: [],
          candidate: { present: false, kind: "none", claim: "", solution: "", verificationPlan: "" },
          nextAction: "deepen",
          nextActionReason: "Try the induction step.",
        },
      };
    }
    return super.run(request);
  }
}

class PartialLeadProvider extends FakeProvider {
  async run(request) {
    if (request.schema.name !== "research_epoch_result") {
      return super.run(request);
    }
    this.count += 1;
    const sessionId = `partial-${this.count}`;
    await request.onStarted?.(sessionId);
    return {
      sessionId,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        outputTokens: 10,
        reasoningTokens: 0,
      },
      data: {
        status: "progress",
        progressKind: "verified-fact",
        decisiveProgress: "reusable-lemma",
        coverageOfExactStatement: "conditional",
        remainingBlockers: ["Complete the final reduction."],
        summary: "A useful lemma was proved, but the full problem remains open.",
        verifiedFacts: ["The bounded auxiliary lemma holds."],
        plausibleClaims: [],
        failedApproaches: [],
        unresolvedQuestions: ["Extend the lemma to the unbounded case."],
        artifacts: [
          {
            name: "bounded-lemma",
            kind: "lemma",
            content: "Proof of the bounded auxiliary lemma.",
            verification: "Check the displayed induction.",
          },
        ],
        candidate: {
          present: true,
          kind: "partial",
          claim: "The bounded auxiliary lemma holds.",
          solution: "Induction proves the bounded auxiliary statement.",
          verificationPlan: "Check the induction.",
        },
        nextAction: "deepen",
        nextActionReason: "Use the lemma on the remaining unbounded case.",
      },
    };
  }
}

function fixture(name) {
  if (name === "open_problem_discovery") {
    return {
      problems: [
        {
          id: "finite-test-problem",
          title: "Finite test problem",
          domain: "combinatorics",
          statement: "There is no integer n satisfying P(n).",
          assumptions: [],
          sourceUrls: ["https://mathworld.wolfram.com/"],
          openStatusEvidence: ["Canonical source marks it open."],
          knownResults: [],
          verificationMode: "finite-witness",
          interest: 4,
          tractability: 5,
          verifiability: 5,
          sourceQuality: 5,
          falsificationType: "finite-counterexample",
          counterexampleSearchability: 5,
          counterexampleVerificationPlan:
            "Enumerate exact integer candidates and independently evaluate P.",
          minimumDecisiveArtifact:
            "One explicit integer witness with a reproducible exact evaluation of P.",
          artifactReadiness: 5,
          blockingDependencies: [],
          whyPromising: "A witness is decisive.",
          risks: [],
        },
      ],
    };
  }
  if (name === "problem_vetting") {
    return {
      exactStatementVerified: true,
      openStatusVerified: true,
      sourceQualityVerified: true,
      substantiveHumanStudyVerified: true,
      correctedStatement: "There is no integer n satisfying P(n).",
      correctedAssumptions: [],
      canonicalSourceUrls: ["https://mathworld.wolfram.com/"],
      statusEvidence: ["Verified open."],
      materialErrors: [],
      literatureRisks: [],
      correctedFalsificationType: "finite-counterexample",
      correctedCounterexampleSearchability: 5,
      counterexampleAssessment:
        "The witness space is exactly searchable and each candidate is decisive.",
      correctedMinimumDecisiveArtifact:
        "One explicit integer witness with a reproducible exact evaluation of P.",
      correctedArtifactReadiness: 5,
      blockingDependencies: [],
      recommendation: "attack",
    };
  }
  if (name === "research_portfolio_plan") {
    return {
      baseline: "Search exactly.",
      acceptanceContract: "An exact integer witness and direct check.",
      strategies: [
        {
          id: "exact-search",
          title: "Exact search",
          hypothesis: "A small witness exists.",
          predictedObservation: "P(17) holds.",
          falsifier: "Exact evaluation rejects it.",
          noveltyVector: ["finite-search"],
          preferredTools: ["python"],
        },
      ],
    };
  }
  if (name === "research_epoch_result") {
    return {
      status: "candidate",
      progressKind: "candidate",
      decisiveProgress: "complete-candidate",
      coverageOfExactStatement: "exact",
      remainingBlockers: [],
      summary: "Found and exactly checked n=17.",
      verifiedFacts: ["P(17) evaluates to true."],
      plausibleClaims: [],
      failedApproaches: [],
      unresolvedQuestions: [],
      artifacts: [{ name: "check", kind: "code", content: "assert P(17)", verification: "run exactly" }],
      candidate: {
        present: true,
        kind: "disproof",
        claim: "n=17 is a counterexample.",
        solution: "Evaluate P(17) exactly.",
        verificationPlan: "Independent exact evaluation.",
      },
      nextAction: "verify",
      nextActionReason: "The witness is complete.",
    };
  }
  if (name === "candidate_verification") {
    return {
      verdict: "pass",
      statementAlignment: "The witness negates the exact universal claim.",
      exactnessAssessment: "Integer arithmetic only.",
      reproducedChecks: ["Recomputed P(17)."],
      fatalIssues: [],
      nonFatalIssues: [],
      independentArtifact: "Independent checker returned true.",
      recommendedStatus: "mechanically-verified-candidate",
      feedbackToResearcher: "None.",
    };
  }
  if (name === "portfolio_synthesis") {
    return {
      sharedVerifiedFacts: [],
      rejectedClaims: [],
      duplicateDirections: [],
      informationGain: false,
      portfolioSummary: "No result.",
      branchDirectives: [],
      candidate: { present: false, kind: "none", claim: "", solution: "", verificationPlan: "" },
    };
  }
  throw new Error(`No fixture for ${name}`);
}

test("end-to-end loop discovers, attacks, and independently verifies a finite candidate", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-run-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    parallelProblems: 1,
    branchesPerProblem: 1,
    maxConcurrentCalls: 2,
    maxCalls: 12,
    independentVerificationPasses: 2,
    discovery: {
      poolSize: 1,
      attackCount: 1,
      minimumInterest: 1,
      minimumTractability: 1,
      minimumVerifiability: 1,
    },
  });
  const provider = new FakeProvider();
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "responses",
    runDir: path.join(root, "run"),
  });
  await app.run();
  assert.equal(app.state.status, "completed-with-candidate");
  assert.equal(app.state.problems[0].status, "candidate-complete-agent-reproduced");
  assert.equal(app.state.problems[0].verificationRuns[0].passes.length, 2);
  assert.equal(app.state.budget.callsStarted, 6);
});

test("solver-turn checkpoints finish a probe cleanly and resume the same thread", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-turn-checkpoint-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const runDir = path.join(root, "run");
  const provider = new LoopWithoutCandidateProvider();
  const config = await loadConfig(null, {
    runRoot: root,
    wallClockHours: 1,
    parallelProblems: 1,
    branchesPerProblem: 1,
    maxConcurrentCalls: 1,
    maxCalls: 20,
    maxTurnsPerBranch: 8,
    maxSolverTurnsPerProblem: 1,
    maxNoProgressEpochs: 8,
    maxPortfolioStagnationRounds: 8,
  });
  const packet = fixture("open_problem_discovery").problems[0];
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "max",
    runDir,
  });
  await app.seedProblems([packet], { vet: false });
  await app.run();

  assert.equal(app.state.status, "completed-checkpoint");
  assert.equal(app.state.problems[0].status, "research-checkpoint");
  assert.equal(app.state.problems[0].branches[0].history.length, 1);
  const firstSession = app.state.problems[0].branches[0].sessionId;

  const resumedConfig = await loadConfig(null, {
    ...config,
    maxSolverTurnsPerProblem: 2,
  });
  const resumed = await Autoprover.resume({
    config: resumedConfig,
    provider,
    providerName: "max",
    runDir,
  });
  await resumed.run();

  assert.equal(resumed.state.status, "completed-checkpoint");
  assert.equal(resumed.state.problems[0].branches[0].history.length, 2);
  assert.equal(
    provider.epochSessionInputs.at(-1),
    firstSession,
    "the next solver turn must resume the exact saved session",
  );
});

test("partial leads stay in the solver loop and never consume verifier calls", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-partial-loop-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    parallelProblems: 1,
    branchesPerProblem: 1,
    maxConcurrentCalls: 1,
    maxCalls: 4,
    maxTurnsPerBranch: 2,
    maxPortfolioStagnationRounds: 8,
    skipSingleBranchSynthesis: true,
  });
  const provider = new PartialLeadProvider();
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "max",
    runDir: path.join(root, "run"),
  });
  await app.seedProblems(
    [fixture("open_problem_discovery").problems[0]],
    { vet: false },
  );

  await app.run();

  const state = app.state.problems[0];
  assert.equal(state.branches[0].turns, 2);
  assert.equal(state.partialLeads.length, 1);
  assert.equal(state.verificationRuns.length, 0);
  assert.equal(
    provider.count,
    3,
    "one planner and two persistent solver turns should run",
  );
  assert.equal(
    Object.values(app.state.operations).some(
      (operation) => operation.role === "critic",
    ),
    false,
  );
});

test("expert-review recommendations cannot become agent-reproduced candidates", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-expert-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    parallelProblems: 1,
    branchesPerProblem: 1,
    maxConcurrentCalls: 2,
    maxCalls: 12,
    independentVerificationPasses: 2,
    discovery: {
      poolSize: 1,
      attackCount: 1,
      minimumInterest: 1,
      minimumTractability: 1,
      minimumVerifiability: 1,
    },
  });
  const app = await Autoprover.create({
    config,
    provider: new NeedsExpertProvider(),
    providerName: "responses",
    runDir: path.join(root, "run"),
  });
  await app.run();
  assert.equal(app.state.problems[0].status, "candidate-complete-needs-expert");
  assert.equal(app.state.problems[0].verificationRuns[0].status, "candidate-needs-expert");
});

test("discovery rejects problems supported only by machine-generated conjecture provenance", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-human-study-gate-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    parallelProblems: 1,
    discovery: {
      poolSize: 1,
      attackCount: 1,
      minimumInterest: 1,
      minimumTractability: 1,
      minimumVerifiability: 1,
    },
  });
  const app = await Autoprover.create({
    config,
    provider: new MachineGeneratedOnlyProvider(),
    providerName: "responses",
    runDir: path.join(root, "run"),
  });
  await assert.rejects(
    () => app.discover(),
    /no problem whose exact statement, open status, source quality, and substantive human study passed/i,
  );
  assert.equal(app.state.problems.length, 0);
});

test("completed named operations replay without a second provider call or budget charge", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-operation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, { runRoot: root, maxCalls: 5 });
  const provider = new FakeProvider();
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "responses",
    runDir: path.join(root, "run"),
  });
  const request = {
    operationKey: "test:plan",
    role: "planner",
    prompt: "Plan the test problem.",
    schema: { name: "research_portfolio_plan", schema: { type: "object" } },
    workingDir: path.join(root, "work"),
    tools: { webSearch: false, codeInterpreter: false },
  };
  const first = await app.callModel(request);
  const second = await app.callModel(request);
  assert.deepEqual(second.data, first.data);
  assert.equal(provider.count, 1);
  assert.equal(app.state.budget.callsStarted, 1);
  assert.equal(app.state.budget.callsCompleted, 1);
});

test("near-budget parallel fanout waits for every started branch before returning", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    parallelProblems: 1,
    branchesPerProblem: 2,
    maxConcurrentCalls: 2,
    maxCalls: 4,
    discovery: {
      poolSize: 1,
      attackCount: 1,
      minimumInterest: 1,
      minimumTractability: 1,
      minimumVerifiability: 1,
    },
  });
  const provider = new BudgetFanoutProvider();
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "responses",
    runDir: path.join(root, "run"),
  });
  await app.run();
  assert.equal(provider.activeEpochs, 0);
  assert.equal(
    app.state.problems[0].branches.reduce((sum, branch) => sum + branch.history.length, 0),
    1,
  );
  assert.equal(app.state.budget.callsStarted, 4);
});

test("the planner overgenerates and the harness suppresses duplicate strategy mechanisms", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-diverse-plan-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    parallelProblems: 1,
    branchesPerProblem: 3,
    maxConcurrentCalls: 1,
    maxCalls: 1,
    discovery: {
      poolSize: 1,
      attackCount: 1,
      minimumInterest: 1,
      minimumTractability: 1,
      minimumVerifiability: 1,
    },
  });
  const app = await Autoprover.create({
    config,
    provider: new RedundantPlannerProvider(),
    providerName: "responses",
    runDir: path.join(root, "run"),
  });
  await app.seedProblems(fixture("open_problem_discovery").problems, {
    vet: false,
  });
  await app.run();
  const problem = app.state.problems[0];
  assert.equal(problem.branches.length, 3);
  assert.equal(
    new Set(
      problem.branches.map(
        (branch) => branch.strategy.strategyFingerprint,
      ),
    ).size,
    3,
  );
  assert.equal(
    problem.plan.automaticStrategySelection.suppressedExactDuplicates,
    1,
  );
  assert.equal(problem.plan.automaticStrategySelection.proposedCount, 5);
});

test("long branches rotate to fresh sessions and repeated evidence stops counting as progress", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-rotation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    parallelProblems: 1,
    branchesPerProblem: 1,
    maxConcurrentCalls: 1,
    maxCalls: 10,
    maxTurnsPerBranch: 2,
    maxTurnsPerSession: 1,
    maxNoProgressEpochs: 5,
    maxPortfolioStagnationRounds: 5,
    discovery: {
      poolSize: 1,
      attackCount: 1,
      minimumInterest: 1,
      minimumTractability: 1,
      minimumVerifiability: 1,
    },
  });
  const provider = new LoopWithoutCandidateProvider();
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "responses",
    runDir: path.join(root, "run"),
  });
  await app.run();
  const branch = app.state.problems[0].branches[0];
  assert.deepEqual(provider.epochSessionInputs, [null, null]);
  assert.equal(branch.archivedSessions.length, 1);
  assert.equal(branch.archivedSessions[0].reason, "context-rotation");
  assert.equal(branch.noProgressEpochs, 1);
});

test("resume persists raised limits and reopens only deadline-stopped work", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-resume-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const initialConfig = await loadConfig(null, { runRoot: root, maxCalls: 5 });
  const runDir = path.join(root, "run");
  const app = await Autoprover.create({
    config: initialConfig,
    provider: new FakeProvider(),
    providerName: "responses",
    runDir,
  });
  app.state.status = "deadline-reached";
  app.state.problems = [
    {
      packet: { id: "deadline-problem", title: "Deadline problem" },
      status: "deadline-reached",
      plan: { acceptanceContract: "test" },
      branches: [],
      verificationRuns: [],
    },
    {
      packet: { id: "exhausted-problem", title: "Exhausted problem" },
      status: "exhausted-no-result",
      plan: { acceptanceContract: "test" },
      branches: [],
      verificationRuns: [],
    },
  ];
  await app.store.save(app.state);
  const raisedConfig = await loadConfig(null, { runRoot: root, maxCalls: 20 });
  const resumed = await Autoprover.resume({
    config: raisedConfig,
    provider: new FakeProvider(),
    providerName: "responses",
    runDir,
    extendHours: 12,
  });
  assert.equal(resumed.state.problems[0].status, "active");
  assert.equal(resumed.state.problems[1].status, "exhausted-no-result");
  const stored = JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8"));
  assert.equal(stored.configSnapshot.maxCalls, 20);
});

test("campaign checkpoint recovery can reopen a boundary-interrupted failed problem", async (t) => {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-interrupted-resume-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, { runRoot: root, maxCalls: 20 });
  const runDir = path.join(root, "run");
  const app = await Autoprover.create({
    config,
    provider: new FakeProvider(),
    providerName: "responses",
    runDir,
  });
  app.state.status = "completed-with-errors";
  app.state.problems = [
    {
      packet: { id: "interrupted-problem", title: "Interrupted problem" },
      status: "failed",
      stopReason: "Campaign call budget reached",
      plan: { acceptanceContract: "test" },
      branches: [],
      verificationRuns: [],
    },
  ];
  await app.store.save(app.state);

  const resumed = await Autoprover.resume({
    config,
    provider: new FakeProvider(),
    providerName: "responses",
    runDir,
    extendHours: 1,
    reopenInterrupted: true,
  });

  assert.equal(resumed.state.status, "running");
  assert.equal(resumed.state.problems[0].status, "active");
  assert.equal(resumed.state.problems[0].stopReason, "");
});
