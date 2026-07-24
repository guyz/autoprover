import { mkdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalProviderName,
  isApiBilledProvider,
} from "./config.mjs";
import {
  BASE_RESEARCH_POLICY,
  discoveryPrompt,
  epochPrompt,
  planPrompt,
  synthesisPrompt,
  verificationPrompt,
  vetPrompt,
} from "./prompts.mjs";
import {
  DISCOVERY_SCHEMA,
  EPOCH_SCHEMA,
  PLAN_SCHEMA,
  SYNTHESIS_SCHEMA,
  VERIFICATION_SCHEMA,
  VET_SCHEMA,
} from "./schemas.mjs";
import { RunStore } from "./store.mjs";
import { assertSchemaValid } from "./providers/pro-manual.mjs";
import {
  Semaphore,
  nowIso,
  sha256,
  shortId,
  sleep,
  slugify,
  writeJsonAtomic,
} from "./utils.mjs";
import {
  FALSIFICATION_TYPES,
  counterexampleOpportunity,
  resolveFalsificationProfile,
} from "./falsification.mjs";

export class Autoprover {
  constructor({ config, provider, providerName, store, state, lockHeld = false }) {
    this.config = config;
    this.provider = provider;
    this.providerName = canonicalProviderName(providerName);
    this.store = store;
    this.state = state;
    this.lockHeld = lockHeld;
    this.callSemaphore = new Semaphore(config.maxConcurrentCalls);
    this.problemSemaphore = new Semaphore(config.parallelProblems);
  }

  static async create({ config, provider, providerName, runDir }) {
    const resolvedProviderName = canonicalProviderName(providerName);
    const store = new RunStore(runDir);
    const startedAt = nowIso();
    const deadlineAt = new Date(Date.now() + config.wallClockHours * 3_600_000).toISOString();
    const state = {
      schemaVersion: 3,
      runId: path.basename(runDir),
      provider: resolvedProviderName,
      status: "created",
      startedAt,
      updatedAt: startedAt,
      deadlineAt,
      configSnapshot: config,
      budget: {
        callsStarted: 0,
        callsCompleted: 0,
        callsFailed: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
        estimatedUsd: 0,
      },
      discovery: null,
      problems: [],
      operations: {},
      stopReason: "",
    };
    await store.initialize(state);
    return new Autoprover({
      config,
      provider,
      providerName: resolvedProviderName,
      store,
      state,
    });
  }

  static async resume({
    config,
    provider,
    providerName,
    runDir,
    extendHours = 0,
    reopenInterrupted = false,
  }) {
    const store = new RunStore(runDir);
    await store.acquireLock();
    try {
      const state = await store.load();
      migrateState(state);
      const resolvedProviderName = canonicalProviderName(providerName);
      if (state.provider !== resolvedProviderName) {
        throw new Error(
          `Run provider is pinned to ${state.provider}; refusing to resume it with ${resolvedProviderName}. Start a new run to change providers.`,
        );
      }
      state.configSnapshot = structuredClone(config);
      if (extendHours > 0) {
        state.deadlineAt = new Date(
          Math.max(Date.now(), Date.parse(state.deadlineAt)) +
            extendHours * 3_600_000,
        ).toISOString();
        await store.event("run.extended", {
          extendHours,
          deadlineAt: state.deadlineAt,
        });
      }

      const callBudgetAvailable = state.budget.callsStarted < config.maxCalls;
      const costBudgetAvailable =
        !isApiBilledProvider(resolvedProviderName) ||
        state.budget.estimatedUsd < config.maxEstimatedUsd;
      const deadlineAvailable = Date.now() < Date.parse(state.deadlineAt);
      if (callBudgetAvailable && costBudgetAvailable && deadlineAvailable) {
        if (
          [
            "budget-exhausted",
            "deadline-reached",
            "failed",
            "awaiting-manual",
            ...(reopenInterrupted ? ["completed-with-errors"] : []),
          ].includes(state.status)
        ) {
          state.status = "running";
          state.stopReason = "";
        }
        for (const problem of state.problems) {
          if (
            ["budget-exhausted", "awaiting-manual"].includes(problem.status) ||
            (problem.status === "deadline-reached" && extendHours > 0) ||
            (reopenInterrupted && problem.status === "failed")
          ) {
            problem.status = problem.plan ? "active" : "queued";
            problem.stopReason = "";
          }
        }
      }
      await store.event("run.config_applied", {
        provider: resolvedProviderName,
        wallClockHours: config.wallClockHours,
        maxCalls: config.maxCalls,
        maxEstimatedUsd: config.maxEstimatedUsd,
      });
      await store.save(state);
      return new Autoprover({
        config,
        provider,
        providerName: resolvedProviderName,
        store,
        state,
        lockHeld: true,
      });
    } catch (error) {
      await store.releaseLock();
      throw error;
    }
  }

  async discover() {
    this.state.status = "discovering";
    await this.store.save(this.state);
    const currentDate = new Date().toISOString().slice(0, 10);
    const scoutWorkspace = path.join(this.store.runDir, "discovery", "scout");
    await mkdir(scoutWorkspace, { recursive: true });
    const scout = await this.callModel({
      operationKey: "discovery:scout",
      role: "scout",
      prompt: discoveryPrompt(this.config, currentDate),
      schema: DISCOVERY_SCHEMA,
      workingDir: scoutWorkspace,
      tools: { webSearch: true, codeInterpreter: false },
    });
    const rawProblems = deduplicateDiscoveredProblems(
      (scout.data.problems ?? []).map((problem) => {
        const normalized = normalizeProblem(problem);
        validateProblemPacket(normalized);
        return normalized;
      }),
    );
    const eligible = rawProblems
      .filter((problem) => problem.interest >= this.config.discovery.minimumInterest)
      .filter((problem) => problem.tractability >= this.config.discovery.minimumTractability)
      .filter((problem) => problem.verifiability >= this.config.discovery.minimumVerifiability)
      .sort((a, b) => problemScore(b) - problemScore(a));

    const vetCount = Math.min(eligible.length, Math.max(this.config.discovery.attackCount * 2, this.config.discovery.attackCount));
    const vetSettled = await Promise.allSettled(
      eligible.slice(0, vetCount).map((problem) =>
        this.callSemaphore.use(async () => {
          const workspace = path.join(this.store.runDir, "discovery", "vet", slugify(problem.id));
          await mkdir(workspace, { recursive: true });
          try {
            const result = await this.callModel({
              operationKey: `discovery:vet:${problem.id}`,
              role: "scout",
              prompt: vetPrompt(problem, currentDate),
              schema: VET_SCHEMA,
              workingDir: workspace,
              tools: { webSearch: true, codeInterpreter: false },
              alreadyLimited: true,
            });
            return applyVetting(problem, result.data);
          } catch (error) {
            if (isManualInputPending(error)) throw error;
            await this.store.event("problem.vet_failed", { problemId: problem.id, error: error.message });
            return { ...problem, vetting: { recommendation: "reject", error: error.message } };
          }
        }),
      ),
    );
    const pendingManual = vetSettled.find(
      (entry) =>
        entry.status === "rejected" &&
        isManualInputPending(entry.reason),
    );
    if (pendingManual) throw pendingManual.reason;
    const unexpectedVetFailure = vetSettled.find(
      (entry) => entry.status === "rejected",
    );
    if (unexpectedVetFailure) throw unexpectedVetFailure.reason;
    const vetted = vetSettled.map((entry) => entry.value);
    for (const problem of vetted.filter(
      (entry) => entry.vetting?.recommendation === "attack",
    )) {
      validateProblemPacket(problem);
    }

    const selected = selectDiverse(
      vetted.filter((problem) => problem.vetting?.recommendation === "attack"),
      this.config.discovery.attackCount,
    );
    if (!selected.length) {
      throw new Error("Discovery produced no problem whose exact statement and open status passed independent vetting");
    }

    this.state.discovery = {
      at: nowIso(),
      rawCount: rawProblems.length,
      eligibleCount: eligible.length,
      vetted,
      selectedIds: selected.map((problem) => problem.id),
    };
    this.state.problems = selected.map(createProblemState);
    this.state.status = "ready";
    await this.store.event("discovery.completed", {
      rawCount: rawProblems.length,
      selected: selected.map((problem) => ({ id: problem.id, title: problem.title, score: problemScore(problem) })),
    });
    await this.store.save(this.state);
    return selected;
  }

  async seedProblems(problems, { vet = true } = {}) {
    if (!Array.isArray(problems) || !problems.length) throw new Error("Problem file must contain a non-empty problems array");
    if (vet && this.providerName === "pro-manual") {
      throw new Error(
        "Pro-manual seeded runs must use vet: false after the operator has audited the exact problem packet.",
      );
    }
    const normalized = problems.map((problem) => {
      validateProblemPacket(problem);
      return normalizeProblem(problem);
    });
    assertUniqueProblemIds(normalized);
    let accepted = normalized;
    if (vet) {
      const currentDate = new Date().toISOString().slice(0, 10);
      const vetted = await Promise.all(
        normalized.map((problem) =>
          this.callModel({
            operationKey: `manual:vet:${problem.id}`,
            role: "scout",
            prompt: vetPrompt(problem, currentDate),
            schema: VET_SCHEMA,
            workingDir: path.join(this.store.runDir, "discovery", "manual-vet", slugify(problem.id)),
            tools: { webSearch: true, codeInterpreter: false },
          }).then((result) => applyVetting(problem, result.data)),
        ),
      );
      const rejected = vetted.filter((problem) => problem.vetting?.recommendation !== "attack");
      if (rejected.length) {
        throw new Error(
          `Manual problem vetting rejected: ${rejected.map((problem) => problem.title).join(", ")}`,
        );
      }
      for (const problem of vetted) validateProblemPacket(problem);
      accepted = vetted;
    }
    this.state.discovery = {
      at: nowIso(),
      rawCount: accepted.length,
      eligibleCount: accepted.length,
      vetted: vet ? accepted : [],
      selectedIds: accepted.map((problem) => problem.id),
      source: "user-supplied",
      userTrustedWithoutVetting: !vet,
    };
    this.state.problems = accepted.map(createProblemState);
    this.state.status = "ready";
    await this.store.event("problems.seeded", { count: normalized.length });
    await this.store.save(this.state);
  }

  async run() {
    if (!this.lockHeld) {
      await this.store.acquireLock();
      this.lockHeld = true;
    }
    try {
      return await this.runLocked();
    } finally {
      await this.store.releaseLock();
      this.lockHeld = false;
    }
  }

  async runLocked() {
    if (!this.state.problems.length) {
      try {
        await this.discover();
      } catch (error) {
        if (!isManualInputPending(error)) throw error;
        await this.pauseForManualInput(error);
        return this.state;
      }
    }
    this.state.status = "running";
    this.state.stopReason = "";
    await this.store.event("run.started", { deadlineAt: this.state.deadlineAt });
    await this.store.save(this.state);

    await Promise.all(
      this.state.problems.map((problem) =>
        this.problemSemaphore.use(async () => {
          startProblemClock(problem);
          try {
            await this.runProblem(problem);
          } catch (error) {
            if (isManualInputPending(error)) {
              problem.status = "awaiting-manual";
            } else {
              problem.status =
                error instanceof BudgetExhaustedError
                  ? this.deadlineReached()
                    ? "deadline-reached"
                    : "budget-exhausted"
                  : "failed";
            }
            problem.stopReason = error.message;
            await this.store.event(
              isManualInputPending(error)
                ? "problem.awaiting_manual"
                : "problem.failed",
              {
              problemId: problem.packet.id,
              status: problem.status,
              error: error.message,
              },
            );
            await this.store.save(this.state);
          } finally {
            stopProblemClock(problem);
            await this.store.save(this.state);
          }
        }),
      ),
    );

    const active = this.state.problems.some((problem) => problem.status === "active");
    const hasCandidate = this.state.problems.some((problem) => problem.status.startsWith("candidate-complete"));
    const deadlineStopped = this.state.problems.some((problem) => problem.status === "deadline-reached");
    const budgetStopped = this.state.problems.some((problem) => problem.status === "budget-exhausted");
    const failed = this.state.problems.some((problem) => problem.status === "failed");
    const awaitingManual = this.state.problems.some(
      (problem) => problem.status === "awaiting-manual",
    );
    if (awaitingManual) {
      this.state.status = "awaiting-manual";
      this.state.stopReason =
        "One or more schema-validated manual ChatGPT Pro responses are required";
    } else if ((active || deadlineStopped) && this.deadlineReached()) {
      this.state.status = "deadline-reached";
      this.state.stopReason = "Wall-clock deadline reached";
    } else if ((active || budgetStopped) && !this.budgetAvailable()) {
      this.state.status = "budget-exhausted";
      this.state.stopReason = "Call or estimated-cost budget exhausted";
    } else if (failed) {
      this.state.status = hasCandidate ? "completed-with-candidate-and-errors" : "completed-with-errors";
    } else {
      this.state.status = hasCandidate ? "completed-with-candidate" : "completed-no-result";
    }
    await this.store.event("run.finished", { status: this.state.status, stopReason: this.state.stopReason });
    await this.store.save(this.state);
    return this.state;
  }

  async runProblem(problemState) {
    if (isProblemTerminal(problemState.status)) return;
    problemState.status = "active";
    problemState.stopReason = "";
    const problemDir = this.store.problemDir(problemState.packet.id);
    await mkdir(problemDir, { recursive: true });

    if (!problemState.plan) {
      const planResult = await this.callModel({
        operationKey: `problem:${problemState.packet.id}:plan`,
        role: "planner",
        prompt: planPrompt(problemState.packet, this.config.branchesPerProblem),
        schema: PLAN_SCHEMA,
        workingDir: path.join(problemDir, "planner"),
        tools: { webSearch: true, codeInterpreter: true },
      });
      const strategies = planResult.data.strategies.slice(0, this.config.branchesPerProblem);
      if (!strategies.length) throw new Error(`Planner returned no strategies for ${problemState.packet.title}`);
      problemState.plan = planResult.data;
      problemState.branches = strategies.map((strategy, index) => createBranch(strategy, index));
      await Promise.all(problemState.branches.map((branch) => this.store.prepareBranch(problemState.packet.id, branch.id)));
      await this.store.event("problem.planned", {
        problemId: problemState.packet.id,
        branches: problemState.branches.map((branch) => branch.id),
      });
      await this.store.save(this.state);
    }

    problemState.pendingCandidates ??= [];
    problemState.pendingSynthesisRound ??= null;
    problemState.roundInProgress ??= false;
    problemState.roundInformationGain ??= false;
    problemState.pendingExhaustionReason ??= null;

    await this.drainPendingCandidates(problemState);
    this.applyPendingExhaustion(problemState);
    if (
      !isProblemTerminal(problemState.status) &&
      problemState.pendingSynthesisRound !== null
    ) {
      const completed = await this.completePendingSynthesis(
        problemState,
        problemDir,
      );
      if (completed) {
        await this.drainPendingCandidates(problemState);
        this.applyPendingExhaustion(problemState);
      }
    }

    while (
      !isProblemTerminal(problemState.status) &&
      this.problemCanAdvance(problemState) &&
      !this.deadlineReached()
    ) {
      if (await this.applyTwelveHourExtensionGate(problemState)) break;

      await this.drainPendingCandidates(problemState);
      this.applyPendingExhaustion(problemState);
      if (isProblemTerminal(problemState.status)) break;

      if (problemState.pendingSynthesisRound !== null) {
        const completed = await this.completePendingSynthesis(
          problemState,
          problemDir,
        );
        if (!completed) break;
        await this.drainPendingCandidates(problemState);
        this.applyPendingExhaustion(problemState);
        continue;
      }

      if (!problemState.roundInProgress) {
        const active = problemState.branches.filter(
          (branch) => branch.status === "active",
        );
        if (!active.length) {
          problemState.status = "exhausted-no-result";
          problemState.stopReason =
            problemState.stopReason || "Every research branch has stopped";
          break;
        }
        problemState.round += 1;
        problemState.roundInProgress = true;
        problemState.roundInformationGain = false;
        await this.store.save(this.state);
      }

      const activeBranches = problemState.branches.filter(
        (branch) =>
          branch.status === "active" &&
          (branch.lastCompletedRound ?? 0) < problemState.round,
      );
      if (!activeBranches.length) {
        problemState.pendingSynthesisRound = problemState.round;
        await this.store.save(this.state);
        continue;
      }

      const runnableBranches = activeBranches.filter((branch) =>
        branch.pendingOperationKey
          ? this.operationCanRun(branch.pendingOperationKey)
          : this.budgetAvailable(),
      );
      if (!runnableBranches.length) break;

      const settledEpochs = await Promise.allSettled(
        runnableBranches.map((branch) =>
          this.runBranchEpoch(problemState, branch),
        ),
      );
      const epochResults = settledEpochs
        .filter((settled) => settled.status === "fulfilled" && settled.value)
        .map((settled) => settled.value);
      problemState.roundInformationGain ||= epochResults.some(
        (entry) => entry.informationGain,
      );
      for (const entry of epochResults.filter(
        (entry) => entry?.candidate?.present,
      )) {
        this.enqueueCandidate(
          problemState,
          entry.branch?.id ?? null,
          entry.candidate,
        );
      }
      await this.store.save(this.state);

      const epochFailure = settledEpochs.find(
        (settled) =>
          settled.status === "rejected" &&
          !(settled.reason instanceof BudgetExhaustedError),
      );
      if (epochFailure) throw epochFailure.reason;

      await this.drainPendingCandidates(problemState);
      this.applyPendingExhaustion(problemState);
      if (isProblemTerminal(problemState.status)) break;
    }

    if (problemState.status === "active") {
      if (this.deadlineReached()) {
        problemState.status = "deadline-reached";
        problemState.stopReason = "Wall-clock deadline reached";
      } else if (problemState.pendingExhaustionReason && !problemState.pendingCandidates.length) {
        problemState.status = "exhausted-no-result";
        problemState.stopReason = problemState.pendingExhaustionReason;
        problemState.pendingExhaustionReason = null;
      } else {
        problemState.status = "budget-exhausted";
        problemState.stopReason = "Call or estimated-cost budget exhausted";
      }
    }
    await this.store.event("problem.finished", {
      problemId: problemState.packet.id,
      status: problemState.status,
      stopReason: problemState.stopReason,
    });
    await this.store.save(this.state);
  }

  problemCanAdvance(problemState) {
    if (
      !problemState.roundInProgress &&
      !problemState.branches?.some((branch) => branch.status === "active")
    ) {
      return true;
    }
    if (
      problemState.pendingExhaustionReason &&
      !problemState.pendingCandidates?.length
    ) {
      return true;
    }
    if (problemState.pendingCandidates?.length) {
      const queued = problemState.pendingCandidates[0];
      const verificationRun = problemState.verificationRuns.find(
        (run) => run.candidateHash === queued.candidateHash,
      );
      if (
        verificationRun &&
        !["checking", "inconclusive-budget-ended"].includes(
          verificationRun.status,
        )
      ) {
        return true;
      }
      const nextPass = (verificationRun?.passes?.length ?? 0) + 1;
      const operationKey = `problem:${problemState.packet.id}:verify:${queued.candidateHash}:pass:${nextPass}`;
      return this.operationCanRun(operationKey);
    }
    if (problemState.pendingSynthesisRound !== null) {
      return this.operationCanRun(
        `problem:${problemState.packet.id}:synthesis:${problemState.pendingSynthesisRound}`,
      );
    }
    const resumableBranch = problemState.branches?.some(
      (branch) =>
        branch.status === "active" &&
        (branch.lastCompletedRound ?? 0) < problemState.round &&
        branch.pendingOperationKey &&
        this.operationCanRun(branch.pendingOperationKey),
    );
    return resumableBranch || this.budgetAvailable();
  }

  enqueueCandidate(problemState, branchId, candidate) {
    problemState.pendingCandidates ??= [];
    const candidateHash = sha256(
      JSON.stringify({
        problem: problemState.packet.statement,
        candidate,
      }),
    );
    if (
      problemState.pendingCandidates.some(
        (entry) => entry.candidateHash === candidateHash,
      )
    ) {
      return candidateHash;
    }
    problemState.pendingCandidates.push({
      candidateHash,
      candidate,
      branchId,
      queuedAt: nowIso(),
    });
    return candidateHash;
  }

  async drainPendingCandidates(problemState) {
    problemState.pendingCandidates ??= [];
    while (
      problemState.pendingCandidates.length &&
      !isProblemTerminal(problemState.status) &&
      !this.deadlineReached()
    ) {
      const queued = problemState.pendingCandidates[0];
      const branch = queued.branchId
        ? problemState.branches.find((entry) => entry.id === queued.branchId)
        : null;
      const verificationRun = problemState.verificationRuns.find(
        (run) => run.candidateHash === queued.candidateHash,
      );
      const nextPass = (verificationRun?.passes?.length ?? 0) + 1;
      const operationKey = `problem:${problemState.packet.id}:verify:${queued.candidateHash}:pass:${nextPass}`;
      if (!this.operationCanRun(operationKey)) break;
      await this.verifyCandidate(problemState, branch, queued.candidate);
      const updatedRun = problemState.verificationRuns.find(
        (run) => run.candidateHash === queued.candidateHash,
      );
      if (
        updatedRun &&
        ["checking", "inconclusive-budget-ended"].includes(updatedRun.status)
      ) {
        break;
      }
      problemState.pendingCandidates.shift();
      await this.store.save(this.state);
    }
  }

  async completePendingSynthesis(problemState, problemDir) {
    const round = problemState.pendingSynthesisRound;
    if (round === null || round === undefined) return false;
    const operationKey = `problem:${problemState.packet.id}:synthesis:${round}`;
    if (!this.operationCanRun(operationKey)) return false;
    const synthesis = await this.callModel({
      operationKey,
      role: "synthesizer",
      prompt: synthesisPrompt(problemState.packet, problemState.branches),
      schema: SYNTHESIS_SCHEMA,
      workingDir: path.join(problemDir, "synthesis"),
      tools: { webSearch: false, codeInterpreter: true },
    });
    if (!problemState.syntheses.some((entry) => entry.round === round)) {
      problemState.syntheses.push({ round, ...synthesis.data });
      problemState.sharedState = {
        verifiedFacts: synthesis.data.sharedVerifiedFacts,
        rejectedClaims: synthesis.data.rejectedClaims,
        portfolioSummary: synthesis.data.portfolioSummary,
      };
      const synthesisInformationGain = registerPortfolioEvidence(
        problemState,
        synthesis.data,
      );
      problemState.portfolioStagnationRounds =
        problemState.roundInformationGain || synthesisInformationGain
          ? 0
          : problemState.portfolioStagnationRounds + 1;
      await this.applyDirectives(
        problemState,
        synthesis.data.branchDirectives,
      );
      if (synthesis.data.candidate?.present) {
        this.enqueueCandidate(problemState, null, {
          ...synthesis.data.candidate,
          source: "portfolio-synthesis",
          artifacts: [],
        });
      }
      this.reframeStalledBranches(problemState);
      if (
        problemState.portfolioStagnationRounds >=
        this.config.maxPortfolioStagnationRounds
      ) {
        problemState.pendingExhaustionReason =
          "Portfolio produced no information gain for the configured number of rounds";
      }
      await this.store.event("problem.round_completed", {
        problemId: problemState.packet.id,
        round,
        status: problemState.status,
        portfolioStagnationRounds:
          problemState.portfolioStagnationRounds,
      });
    }
    problemState.pendingSynthesisRound = null;
    problemState.roundInProgress = false;
    problemState.roundInformationGain = false;
    await this.store.save(this.state);
    if (this.config.roundCooldownSeconds) {
      await sleep(this.config.roundCooldownSeconds * 1000);
    }
    return true;
  }

  applyPendingExhaustion(problemState) {
    if (
      problemState.pendingExhaustionReason &&
      !problemState.pendingCandidates?.length &&
      !isProblemTerminal(problemState.status)
    ) {
      problemState.status = "exhausted-no-result";
      problemState.stopReason = problemState.pendingExhaustionReason;
      problemState.pendingExhaustionReason = null;
    }
  }

  operationCanRun(operationKey) {
    const operation = this.state.operations?.[operationKey];
    if (
      ["started", "waiting-input", "completed"].includes(operation?.status)
    ) {
      return true;
    }
    return this.budgetAvailable();
  }

  async runBranchEpoch(problemState, branch) {
    branch.sessionTurns ??= 0;
    branch.evidenceKeys ??= [];
    branch.pendingOperationKey ??= null;
    if (
      !branch.pendingOperationKey &&
      (branch.pendingResponseId || branch.pendingSession) &&
      branch.turns > 0
    ) {
      branch.pendingOperationKey = `problem:${problemState.packet.id}:branch:${branch.id}:turn:${branch.turns}`;
    }
    const resumingPending = Boolean(
      branch.pendingOperationKey || branch.pendingResponseId || branch.pendingSession,
    );
    if (!resumingPending && branch.turns >= this.config.maxTurnsPerBranch) {
      branch.status = "turn-limit";
      return null;
    }
    if (!resumingPending && branch.sessionTurns >= this.config.maxTurnsPerSession) {
      archiveBranchSession(branch, "context-rotation");
    }
    if (!resumingPending) {
      branch.turns += 1;
      branch.pendingOperationKey = `problem:${problemState.packet.id}:branch:${branch.id}:turn:${branch.turns}`;
    }
    const workingDir = path.join(this.store.branchDir(problemState.packet.id, branch.id), "workspace");
    const result = await this.callModel({
      operationKey: branch.pendingOperationKey,
      role: "solver",
      prompt: epochPrompt({
        problem: problemState.packet,
        plan: problemState.plan,
        branch,
        sharedState: problemState.sharedState,
        feedback: branch.feedback,
        deadlineAt: this.state.deadlineAt,
        researchPhase: researchPhase(problemActiveHours(problemState)),
      }),
      schema: EPOCH_SCHEMA,
      workingDir,
      sessionId: branch.sessionId,
      pendingResponseId: branch.pendingResponseId,
      tools: { webSearch: true, codeInterpreter: true },
      onStarted: async (id) => {
        branch.pendingProviderOperationId = id;
        branch.pendingSession = true;
        await this.store.save(this.state);
      },
    });
    branch.sessionId = result.sessionId;
    branch.sessionTurns += 1;
    branch.pendingOperationKey = null;
    branch.pendingResponseId = null;
    branch.pendingProviderOperationId = null;
    branch.pendingSession = false;
    branch.feedback = "";
    const artifactRecords = await this.store.persistArtifacts(
      problemState.packet.id,
      branch.id,
      branch.turns,
      result.data.artifacts,
    );
    const delta = { ...result.data, artifacts: artifactRecords, at: nowIso(), turn: branch.turns };
    branch.history.push(delta);
    const novelEvidence = registerBranchEvidence(branch, result.data, artifactRecords);
    const informationGain = result.data.progressKind !== "none" && novelEvidence.length > 0;
    branch.noProgressEpochs = informationGain ? 0 : branch.noProgressEpochs + 1;
    branch.verifiedFacts.push(...result.data.verifiedFacts);
    branch.failedApproaches.push(...result.data.failedApproaches);
    branch.verifiedFacts = [...new Set(branch.verifiedFacts)];
    branch.failedApproaches = [...new Set(branch.failedApproaches)];
    if (result.data.status === "blocked" || result.data.nextAction === "stop") branch.status = "stopped";
    if (result.data.nextAction === "reframe") {
      branch.noProgressEpochs = Math.max(branch.noProgressEpochs, this.config.maxNoProgressEpochs);
    }
    if (branch.turns >= this.config.maxTurnsPerBranch) branch.status = "turn-limit";
    branch.lastCompletedRound = problemState.round;
    problemState.roundInformationGain ||= informationGain;
    const candidate = result.data.candidate.present
      ? {
          ...result.data.candidate,
          artifacts: result.data.artifacts,
          branchId: branch.id,
          turn: branch.turns,
        }
      : result.data.candidate;
    if (candidate.present) {
      this.enqueueCandidate(problemState, branch.id, candidate);
    }
    await this.store.event("branch.epoch_completed", {
      problemId: problemState.packet.id,
      branchId: branch.id,
      turn: branch.turns,
      status: result.data.status,
      progressKind: result.data.progressKind,
      novelEvidenceCount: novelEvidence.length,
      nextAction: result.data.nextAction,
    });
    await this.store.save(this.state);
    return {
      branch,
      informationGain,
      candidate,
    };
  }

  async verifyCandidate(problemState, branch, candidate) {
    const candidateHash = sha256(JSON.stringify({ problem: problemState.packet.statement, candidate }));
    let verificationRun = problemState.verificationRuns.find(
      (run) => run.candidateHash === candidateHash,
    );
    if (verificationRun && verificationRun.status !== "checking" && verificationRun.status !== "inconclusive-budget-ended") {
      return verificationRun.status === "agent-reproduced-candidate" || verificationRun.status === "candidate-needs-expert";
    }
    if (!verificationRun) {
      verificationRun = {
        candidateHash,
        candidate,
        startedAt: nowIso(),
        passes: [],
        status: "checking",
      };
      problemState.verificationRuns.push(verificationRun);
      await this.store.event("candidate.verification_started", {
        problemId: problemState.packet.id,
        branchId: branch?.id ?? null,
        candidateHash,
      });
      await this.store.save(this.state);
    } else {
      verificationRun.status = "checking";
    }

    for (
      let pass = verificationRun.passes.length + 1;
      pass <= this.config.independentVerificationPasses;
      pass += 1
    ) {
      const operationKey = `problem:${problemState.packet.id}:verify:${candidateHash}:pass:${pass}`;
      if (this.deadlineReached() || !this.operationCanRun(operationKey)) {
        verificationRun.status = "inconclusive-budget-ended";
        await this.store.save(this.state);
        return false;
      }
      const workspace = path.join(this.store.problemDir(problemState.packet.id), "verification", candidateHash.slice(0, 12), `pass-${pass}`);
      await mkdir(workspace, { recursive: true });
      const result = await this.callModel({
        operationKey,
        role: "critic",
        prompt: verificationPrompt(problemState.packet, candidate, pass),
        schema: VERIFICATION_SCHEMA,
        workingDir: workspace,
        tools: { webSearch: true, codeInterpreter: true },
      });
      verificationRun.passes.push({
        ...result.data,
        independentArtifactHash: sha256(result.data.independentArtifact),
        evidencePath: result.evidencePath ?? null,
      });
      await this.store.save(this.state);
      if (result.data.verdict !== "pass") break;
    }

    const allPasses =
      verificationRun.passes.length === this.config.independentVerificationPasses &&
      verificationRun.passes.every(
        (pass) =>
          pass.verdict === "pass" &&
          pass.fatalIssues.length === 0 &&
          !["rejected", "candidate-only"].includes(pass.recommendedStatus),
      );
    const mechanicalRecommendations = verificationRun.passes.every(
      (pass) => pass.recommendedStatus === "mechanically-verified-candidate",
    );
    const isCompleteClaim = ["proof", "disproof"].includes(candidate.kind);
    if (allPasses && isCompleteClaim) {
      const artifactBacked =
        Array.isArray(candidate.artifacts) &&
        candidate.artifacts.some(
          (artifact) =>
            ["counterexample", "code", "data", "proof"].includes(artifact.kind) &&
            artifact.content?.trim() &&
            artifact.verification?.trim(),
        );
      const exactMode = ["finite-witness", "exact-computation"].includes(
        problemState.packet.verificationMode,
      );
      const strongReproductions = verificationRun.passes.every(
        (pass) => pass.reproducedChecks.length > 0 && pass.independentArtifact.trim().length > 0,
      );
      const agentReproduced =
        artifactBacked && exactMode && strongReproductions && mechanicalRecommendations;
      const requiresExpert = !agentReproduced;
      verificationRun.status = requiresExpert ? "candidate-needs-expert" : "agent-reproduced-candidate";
      verificationRun.completedAt = nowIso();
      problemState.bestCandidate = { candidateHash, candidate, verification: verificationRun };
      problemState.status = requiresExpert
        ? "candidate-complete-needs-expert"
        : "candidate-complete-agent-reproduced";
      await this.store.event("candidate.verification_passed", {
        problemId: problemState.packet.id,
        candidateHash,
        status: problemState.status,
      });
      await this.store.save(this.state);
      return true;
    }

    if (allPasses && !isCompleteClaim && mechanicalRecommendations) {
      verificationRun.status = "verified-partial-lead";
      verificationRun.completedAt = nowIso();
      problemState.sharedState.verifiedFacts = [
        ...new Set([
          ...problemState.sharedState.verifiedFacts,
          `Verified partial lead: ${candidate.claim}`,
        ]),
      ];
      if (branch) branch.feedback = "The partial lead survived checking. Use it as a lemma, but continue toward the full problem.";
      await this.store.event("candidate.partial_verified", {
        problemId: problemState.packet.id,
        branchId: branch?.id ?? null,
        candidateHash,
      });
      await this.store.save(this.state);
      return false;
    }

    if (allPasses && !isCompleteClaim) {
      verificationRun.status = "partial-needs-expert";
      verificationRun.completedAt = nowIso();
      if (branch) {
        branch.feedback =
          "The partial lead was not rejected, but the independent checks require expert review. Do not treat it as a verified lemma.";
      }
      await this.store.event("candidate.partial_needs_expert", {
        problemId: problemState.packet.id,
        branchId: branch?.id ?? null,
        candidateHash,
      });
      await this.store.save(this.state);
      return false;
    }

    if (verificationRun.status === "checking") {
      verificationRun.status = verificationRun.passes.at(-1)?.verdict === "fail" ? "rejected" : "inconclusive";
    }
    verificationRun.completedAt = nowIso();
    if (branch) {
      branch.repairCycles += 1;
      branch.feedback = verificationRun.passes.at(-1)?.feedbackToResearcher ?? "Independent verification did not pass.";
      if (branch.repairCycles > this.config.maxRepairCycles) branch.status = "candidate-rejected";
    }
    await this.store.event("candidate.verification_failed", {
      problemId: problemState.packet.id,
      branchId: branch?.id ?? null,
      candidateHash,
      status: verificationRun.status,
    });
    await this.store.save(this.state);
    return false;
  }

  async applyDirectives(problemState, directives) {
    for (const directive of directives) {
      const branch = problemState.branches.find((item) => item.id === directive.branchId);
      if (!branch) continue;
      branch.feedback = directive.instruction;
      if (directive.action === "stop") branch.status = "stopped";
      if (directive.action === "reframe") branch.noProgressEpochs = Math.max(branch.noProgressEpochs, this.config.maxNoProgressEpochs);
      if (
        directive.action === "branch" &&
        problemState.branches.length < this.config.maxBranchesPerProblem
      ) {
        const forkIndex = branch.forks + 1;
        branch.forks = forkIndex;
        const fork = createBranch(
          {
            ...branch.strategy,
            id: `${branch.id}-fork-${forkIndex}`,
            title: `Fork ${forkIndex}: ${branch.strategy.title}`,
            hypothesis: directive.instruction,
            noveltyVector: [
              ...branch.strategy.noveltyVector,
              `coordinator-fork-${forkIndex}`,
            ],
          },
          problemState.branches.length,
        );
        // A coordinator-created fork begins on the next round, not midway
        // through the synthesis round that created it.
        fork.lastCompletedRound = problemState.round;
        problemState.branches.push(fork);
        await this.store.prepareBranch(problemState.packet.id, fork.id);
      }
    }
  }

  reframeStalledBranches(problemState) {
    for (const branch of problemState.branches) {
      if (branch.status !== "active" || branch.noProgressEpochs < this.config.maxNoProgressEpochs) continue;
      archiveBranchSession(branch, "stagnation-reframe");
      branch.reframes += 1;
      if (branch.reframes > this.config.maxReframesPerBranch) {
        branch.status = "reframe-limit";
        continue;
      }
      branch.noProgressEpochs = 0;
      branch.strategy = {
        ...branch.strategy,
        id: `${branch.strategy.id}-reframe-${branch.reframes}`,
        title: `Reframe ${branch.reframes}: ${branch.strategy.title}`,
        hypothesis: branch.feedback || `Abandon the prior representation and attack the unresolved gap from a genuinely different mathematical viewpoint.`,
        noveltyVector: [...branch.strategy.noveltyVector, `fresh-context-reframe-${branch.reframes}`],
      };
      branch.feedback = `This is a fresh context. Do not reconstruct the previous failed narrative. Start from the exact problem, verified shared facts, and negative registry.`;
    }
  }

  async callModel({ alreadyLimited = false, ...request }) {
    const execute = async () => {
      this.state.operations ??= {};
      const operationKey = request.operationKey ?? `ephemeral:${request.role}:${shortId()}`;
      let operation = this.state.operations[operationKey];
      if (operation?.status === "completed" && operation.result) {
        await this.store.event("model.call_replayed", { operationKey, role: request.role });
        return structuredClone(operation.result);
      }

      const canResume =
        ["started", "waiting-input"].includes(operation?.status) &&
        sameProvider(operation.provider, this.providerName) &&
        Boolean(operation.sessionId);
      if (!canResume) {
        this.reserveCall(request.role);
        operation = {
          operationKey,
          role: request.role,
          provider: this.providerName,
          status: "reserved",
          attempts: (operation?.attempts ?? 0) + 1,
          reservedAt: nowIso(),
          sessionId: null,
        };
        this.state.operations[operationKey] = operation;
      }

      const model = this.config.models[request.role];
      const effectiveMode =
        this.providerName === "pro"
          ? model.mode
          : this.providerName === "max"
            ? "max-reasoning"
            : this.providerName === "fable"
              ? "claude-fable-5"
              : "manual-pro";
      await this.store.event(canResume ? "model.call_resuming" : "model.call_started", {
        operationKey,
        role: request.role,
        provider: this.providerName,
        model: model.model,
        mode: effectiveMode,
        effort: model.effort,
        sessionId: operation.sessionId,
      });
      await this.store.save(this.state);
      try {
        await mkdir(request.workingDir, { recursive: true });
        const originalOnStarted = request.onStarted;
        const result = await this.provider.run({
          ...request,
          operationKey,
          model,
          instructions: BASE_RESEARCH_POLICY,
          timeoutMs: Math.max(1_000, Date.parse(this.state.deadlineAt) - Date.now()),
          sessionId: request.sessionId,
          resumeId: canResume ? operation.sessionId : null,
          pendingResponseId: request.pendingResponseId,
          onStarted: async (sessionId) => {
            operation.status = "started";
            operation.sessionId = sessionId;
            operation.startedAt ??= nowIso();
            await originalOnStarted?.(sessionId);
            await this.store.save(this.state);
          },
        });
        this.recordOperationUsage(operation, result.usage);
        await this.store.save(this.state);
        assertSchemaValid(result.data, request.schema.schema);
        assertSemanticModelOutput(result.data, request.schema.name);
        result.evidencePath = await this.store.persistModelEvidence(
          request.role,
          result.sessionId,
          result.evidence,
        );
        this.state.budget.callsCompleted += 1;
        operation.status = "completed";
        operation.completedAt = nowIso();
        operation.sessionId = result.sessionId;
        operation.result = {
          sessionId: result.sessionId,
          data: result.data,
          usage: result.usage,
          evidencePath: result.evidencePath,
        };
        await this.store.event("model.call_completed", {
          operationKey,
          role: request.role,
          sessionId: result.sessionId,
          usage: result.usage,
          evidencePath: result.evidencePath,
          estimatedUsd: this.state.budget.estimatedUsd,
        });
        await this.store.save(this.state);
        return result;
      } catch (error) {
        this.recordOperationUsage(operation, error?.usage);
        if (isManualInputPending(error)) {
          operation.status = "waiting-input";
          operation.sessionId = error.packetId ?? operation.sessionId;
          operation.waitingSince ??= nowIso();
          operation.error = error.message;
          operation.packetId = error.packetId ?? null;
          operation.packetDir = error.packetDir ?? null;
          await this.store.event("model.call_waiting_input", {
            operationKey,
            role: request.role,
            packetId: error.packetId ?? null,
            packetDir: error.packetDir ?? null,
          });
          await this.store.save(this.state);
          throw error;
        }
        this.state.budget.callsFailed += 1;
        operation.status = "failed";
        operation.failedAt = nowIso();
        operation.error = error.message;
        await this.store.event("model.call_failed", {
          operationKey,
          role: request.role,
          error: error.message,
        });
        await this.store.save(this.state);
        throw error;
      }
    };
    return alreadyLimited ? execute() : this.callSemaphore.use(execute);
  }

  reserveCall(role) {
    if (!this.budgetAvailable() || this.deadlineReached()) {
      throw new BudgetExhaustedError(`Budget or deadline exhausted before ${role} call`);
    }
    this.state.budget.callsStarted += 1;
  }

  recordUsage(usage = {}, providerName = this.providerName) {
    for (const key of ["inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens"]) {
      this.state.budget[key] += usage[key] ?? 0;
    }
    if (!isApiBilledProvider(providerName)) return;
    const pricing = this.config.pricingPerMillionTokens;
    const uncached = Math.max(
      0,
      (usage.inputTokens ?? 0) -
        (usage.cachedInputTokens ?? 0) -
        (usage.cacheWriteTokens ?? 0),
    );
    const cost =
      (uncached * pricing.input +
        (usage.cachedInputTokens ?? 0) * pricing.cachedInput +
        (usage.cacheWriteTokens ?? 0) * pricing.cacheWrite +
        (usage.outputTokens ?? 0) * pricing.output) /
      1_000_000;
    this.state.budget.estimatedUsd = Number((this.state.budget.estimatedUsd + cost).toFixed(6));
  }

  recordOperationUsage(operation, usage) {
    if (!usage || operation.usageRecorded) return;
    this.recordUsage(usage, this.providerName);
    operation.usageRecorded = true;
    operation.usage = structuredClone(usage);
  }

  budgetAvailable() {
    return (
      this.state.budget.callsStarted < this.config.maxCalls &&
      (!isApiBilledProvider(this.providerName) ||
        this.state.budget.estimatedUsd < this.config.maxEstimatedUsd)
    );
  }

  deadlineReached() {
    return Date.now() >= Date.parse(this.state.deadlineAt);
  }

  async applyTwelveHourExtensionGate(problemState) {
    if (
      this.config.wallClockHours <= 12 ||
      problemActiveHours(problemState) < 12
    ) {
      return false;
    }
    if (problemState.extensionGate) return !problemState.extensionGate.passed;
    const artifactCount = problemState.branches.reduce(
      (count, branch) =>
        count +
        branch.history.reduce(
          (sum, delta) =>
            sum +
            (delta.artifacts ?? []).filter(
              (artifact) =>
                artifact.sha256 &&
                artifact.verification?.trim() &&
                ["counterexample", "code", "data", "proof"].includes(artifact.kind),
            ).length,
          0,
        ),
      0,
    );
    const reproducedVerificationPasses = problemState.verificationRuns.reduce(
      (count, run) =>
        count +
        (run.passes ?? []).filter(
          (pass) =>
            pass.verdict === "pass" &&
            pass.reproducedChecks?.length > 0 &&
            pass.independentArtifact?.trim(),
        ).length,
      0,
    );
    const passed = reproducedVerificationPasses > 0 || artifactCount > 0;
    problemState.extensionGate = {
      evaluatedAt: nowIso(),
      passed,
      evidence: { reproducedVerificationPasses, artifactCount },
    };
    if (!passed) {
      problemState.status = "exhausted-no-result";
      problemState.stopReason = "The 12-hour extension gate found no reproducible candidate, verified partial result, or evidence-bearing anomaly";
    }
    await this.store.event("problem.extension_gate", {
      problemId: problemState.packet.id,
      passed,
      evidence: problemState.extensionGate.evidence,
    });
    await this.store.save(this.state);
    return !passed;
  }

  async pauseForManualInput(error) {
    this.state.status = "awaiting-manual";
    this.state.stopReason = error.message;
    await this.store.event("run.awaiting_manual", {
      packetId: error.packetId ?? null,
      packetDir: error.packetDir ?? null,
    });
    await this.store.save(this.state);
  }
}

class BudgetExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

export function normalizeProblem(problem) {
  const title = String(problem.title ?? "Untitled problem");
  const statement = String(problem.statement ?? "");
  const falsification = resolveFalsificationProfile(problem);
  return {
    id: slugify(problem.id || title),
    title,
    domain: String(problem.domain ?? "unknown"),
    statement,
    statementHash: sha256(statement),
    assumptions: Array.isArray(problem.assumptions) ? problem.assumptions : [],
    sourceUrls: Array.isArray(problem.sourceUrls) ? problem.sourceUrls : [],
    openStatusEvidence: Array.isArray(problem.openStatusEvidence) ? problem.openStatusEvidence : [],
    knownResults: Array.isArray(problem.knownResults) ? problem.knownResults : [],
    verificationMode: problem.verificationMode ?? "unknown",
    interest: Number(problem.interest ?? 3),
    tractability: Number(problem.tractability ?? 3),
    verifiability: Number(problem.verifiability ?? 3),
    sourceQuality: Number(problem.sourceQuality ?? 3),
    falsificationType: falsification.type,
    counterexampleSearchability: falsification.searchability,
    counterexampleVerificationPlan: falsification.assessment,
    whyPromising: String(problem.whyPromising ?? ""),
    risks: Array.isArray(problem.risks) ? problem.risks : [],
    priorResearch: Array.isArray(problem.priorResearch)
      ? problem.priorResearch
      : [],
    statusAsOf: new Date().toISOString().slice(0, 10),
  };
}

export function validateProblemPacket(problem) {
  if (!problem || typeof problem !== "object" || Array.isArray(problem)) {
    throw new Error("Each problem must be an object");
  }
  for (const field of ["id", "title", "domain", "statement", "whyPromising"]) {
    if (typeof problem[field] !== "string" || !problem[field].trim()) {
      throw new Error(`Problem field ${field} must be a non-empty string`);
    }
  }
  if (/replace|insert the exact statement|untitled problem/i.test(`${problem.title} ${problem.statement}`)) {
    throw new Error(`Problem ${problem.id} still contains placeholder text`);
  }
  for (const field of ["assumptions", "sourceUrls", "openStatusEvidence", "knownResults", "risks"]) {
    if (!Array.isArray(problem[field])) throw new Error(`Problem field ${field} must be an array`);
  }
  if (!problem.sourceUrls.length || !problem.openStatusEvidence.length) {
    throw new Error(`Problem ${problem.id} needs a canonical source URL and open-status evidence`);
  }
  for (const rawUrl of problem.sourceUrls) {
    let url;
    try {
      url = new URL(rawUrl);
    } catch {
      throw new Error(`Problem ${problem.id} has an invalid source URL: ${rawUrl}`);
    }
    if (!url.protocol.startsWith("http") || url.hostname === "example.com") {
      throw new Error(`Problem ${problem.id} source URL is not a real HTTP source: ${rawUrl}`);
    }
  }
  if (!["finite-witness", "exact-computation", "formalizable", "informal-proof", "unknown"].includes(problem.verificationMode)) {
    throw new Error(`Problem ${problem.id} has an invalid verificationMode`);
  }
  for (const field of ["interest", "tractability", "verifiability", "sourceQuality"]) {
    if (!Number.isInteger(problem[field]) || problem[field] < 1 || problem[field] > 5) {
      throw new Error(`Problem ${problem.id} score ${field} must be an integer from 1 to 5`);
    }
  }
  const hasFalsificationMetadata =
    problem.falsificationType !== undefined ||
    problem.counterexampleSearchability !== undefined ||
    problem.counterexampleVerificationPlan !== undefined;
  if (hasFalsificationMetadata) {
    if (!FALSIFICATION_TYPES.includes(problem.falsificationType)) {
      throw new Error(`Problem ${problem.id} has an invalid falsificationType`);
    }
    if (
      !Number.isInteger(problem.counterexampleSearchability) ||
      problem.counterexampleSearchability < 0 ||
      problem.counterexampleSearchability > 5
    ) {
      throw new Error(
        `Problem ${problem.id} counterexampleSearchability must be an integer from 0 to 5`,
      );
    }
    if (
      typeof problem.counterexampleVerificationPlan !== "string" ||
      !problem.counterexampleVerificationPlan.trim()
    ) {
      throw new Error(
        `Problem ${problem.id} needs a counterexampleVerificationPlan`,
      );
    }
  }
  return true;
}

function applyVetting(problem, vetting) {
  const corrected = {
    ...problem,
    statement: vetting.correctedStatement || problem.statement,
    assumptions: vetting.correctedAssumptions?.length ? vetting.correctedAssumptions : problem.assumptions,
    sourceUrls: vetting.canonicalSourceUrls?.length ? vetting.canonicalSourceUrls : problem.sourceUrls,
    openStatusEvidence: vetting.statusEvidence?.length ? vetting.statusEvidence : problem.openStatusEvidence,
    falsificationType:
      vetting.correctedFalsificationType ?? problem.falsificationType,
    counterexampleSearchability:
      vetting.correctedCounterexampleSearchability ??
      problem.counterexampleSearchability,
    counterexampleVerificationPlan:
      vetting.counterexampleAssessment ??
      problem.counterexampleVerificationPlan,
    vetting,
  };
  corrected.statementHash = sha256(corrected.statement);
  if (!vetting.exactStatementVerified || !vetting.openStatusVerified || !vetting.sourceQualityVerified) {
    corrected.vetting = { ...vetting, recommendation: "reject" };
  }
  return corrected;
}

export function problemScore(problem) {
  const falsification = counterexampleOpportunity(problem);
  return (
    0.32 * problem.tractability +
    0.28 * problem.verifiability +
    0.2 * problem.interest +
    0.2 * problem.sourceQuality +
    0.4 * falsification.opportunity
  );
}

function selectDiverse(problems, count) {
  const sorted = [...problems].sort((a, b) => problemScore(b) - problemScore(a));
  const selected = [];
  const usedDomains = new Set();
  for (const problem of sorted) {
    if (selected.length >= count) break;
    if (!usedDomains.has(problem.domain)) {
      selected.push(problem);
      usedDomains.add(problem.domain);
    }
  }
  for (const problem of sorted) {
    if (selected.length >= count) break;
    if (!selected.includes(problem)) selected.push(problem);
  }
  return selected;
}

function deduplicateDiscoveredProblems(problems) {
  const ids = new Set();
  const statements = new Set();
  return problems.filter((problem) => {
    if (ids.has(problem.id) || statements.has(problem.statementHash)) return false;
    ids.add(problem.id);
    statements.add(problem.statementHash);
    return true;
  });
}

function assertUniqueProblemIds(problems) {
  const ids = new Set();
  for (const problem of problems) {
    if (ids.has(problem.id)) {
      throw new Error(`Problem IDs must be unique after normalization; duplicate: ${problem.id}`);
    }
    ids.add(problem.id);
  }
}

function createProblemState(packet) {
  return {
    packet,
    status: "queued",
    stopReason: "",
    round: 0,
    portfolioStagnationRounds: 0,
    evidenceKeys: [],
    plan: null,
    sharedState: { verifiedFacts: [], rejectedClaims: [], portfolioSummary: "" },
    branches: [],
    syntheses: [],
    verificationRuns: [],
    bestCandidate: null,
    pendingCandidates: [],
    pendingSynthesisRound: null,
    roundInProgress: false,
    roundInformationGain: false,
    pendingExhaustionReason: null,
    extensionGate: null,
    activeWorkMs: 0,
    activeWorkStartedAt: null,
  };
}

function createBranch(strategy, index) {
  const baseId = slugify(strategy.id || `branch-${index + 1}`);
  const identity = sha256(JSON.stringify({ strategy, index })).slice(0, 8);
  return {
    id: `${baseId}-${index + 1}-${identity}`,
    strategy,
    status: "active",
    sessionId: null,
    sessionTurns: 0,
    pendingOperationKey: null,
    pendingResponseId: null,
    pendingProviderOperationId: null,
    pendingSession: false,
    lastCompletedRound: 0,
    turns: 0,
    noProgressEpochs: 0,
    repairCycles: 0,
    reframes: 0,
    forks: 0,
    feedback: "",
    verifiedFacts: [],
    failedApproaches: [],
    evidenceKeys: [],
    history: [],
    archivedSessions: [],
  };
}

function registerBranchEvidence(branch, result, artifactRecords) {
  branch.evidenceKeys ??= [];
  const existing = new Set(branch.evidenceKeys);
  const proposed = [
    ...result.verifiedFacts.map((value) => evidenceKey("fact", value)),
    ...result.failedApproaches.map((value) => evidenceKey("failed", value)),
    ...artifactRecords.map((artifact) => `artifact:${artifact.sha256}`),
  ];
  if (result.candidate.present) {
    proposed.push(
      evidenceKey(
        "candidate",
        JSON.stringify({
          kind: result.candidate.kind,
          claim: result.candidate.claim,
          solution: result.candidate.solution,
        }),
      ),
    );
  }
  const novel = proposed.filter((key) => !existing.has(key));
  branch.evidenceKeys.push(...novel);
  return novel;
}

function registerPortfolioEvidence(problemState, synthesis) {
  problemState.evidenceKeys ??= [];
  const existing = new Set(problemState.evidenceKeys);
  const proposed = [
    ...synthesis.sharedVerifiedFacts.map((value) => evidenceKey("shared-fact", value)),
    ...synthesis.rejectedClaims.map((value) => evidenceKey("rejected", value)),
  ];
  const novel = proposed.filter((key) => !existing.has(key));
  problemState.evidenceKeys.push(...novel);
  return novel.length > 0;
}

function evidenceKey(kind, value) {
  const normalized = String(value).trim().toLowerCase().replace(/\s+/g, " ");
  return `${kind}:${sha256(normalized)}`;
}

function archiveBranchSession(branch, reason) {
  branch.archivedSessions ??= [];
  if (branch.sessionId) {
    branch.archivedSessions.push({
      sessionId: branch.sessionId,
      strategy: branch.strategy,
      turns: branch.turns,
      sessionTurns: branch.sessionTurns ?? 0,
      reason,
      at: nowIso(),
    });
  }
  branch.sessionId = null;
  branch.sessionTurns = 0;
  branch.pendingOperationKey = null;
  branch.pendingResponseId = null;
  branch.pendingProviderOperationId = null;
  branch.pendingSession = false;
}

function migrateState(state) {
  state.schemaVersion = 3;
  state.provider = canonicalProviderName(state.provider);
  state.operations ??= {};
  for (const operation of Object.values(state.operations)) {
    if (operation.provider) {
      operation.provider = canonicalProviderName(operation.provider);
    }
  }
  state.budget ??= {};
  for (const key of [
    "callsStarted",
    "callsCompleted",
    "callsFailed",
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
    "estimatedUsd",
  ]) {
    state.budget[key] ??= 0;
  }
  state.problems ??= [];
  for (const problem of state.problems) {
    problem.evidenceKeys ??= [];
    problem.verificationRuns ??= [];
    problem.pendingCandidates ??= [];
    problem.pendingSynthesisRound ??= null;
    problem.roundInProgress ??= false;
    problem.roundInformationGain ??= false;
    problem.pendingExhaustionReason ??= null;
    problem.activeWorkMs ??= 0;
    // Never count time while the harness process was offline.
    problem.activeWorkStartedAt = null;
    for (const branch of problem.branches ?? []) {
      branch.sessionTurns ??= 0;
      branch.pendingOperationKey ??= null;
      branch.pendingProviderOperationId ??= null;
      branch.pendingSession ??= false;
      branch.lastCompletedRound ??= 0;
      branch.evidenceKeys ??= [];
      branch.archivedSessions ??= [];
    }
  }
}

function sameProvider(left, right) {
  try {
    return canonicalProviderName(left) === canonicalProviderName(right);
  } catch {
    return false;
  }
}

function isManualInputPending(error) {
  return (
    [
      "AUTOPROVER_MANUAL_RESPONSE_PENDING",
      "AUTOPROVER_MANUAL_RESPONSE_INVALID",
    ].includes(error?.code) &&
    error?.resumable === true
  );
}

function assertSemanticModelOutput(data, schemaName) {
  if (["research_epoch_result", "portfolio_synthesis"].includes(schemaName)) {
    const candidate = data?.candidate;
    if (!candidate?.present) {
      if (candidate?.kind !== "none") {
        throw new Error(
          `${schemaName} candidate with present=false must use kind=none`,
        );
      }
    } else {
      if (!["proof", "disproof", "partial"].includes(candidate.kind)) {
        throw new Error(
          `${schemaName} candidate with present=true must be a proof, disproof, or partial result`,
        );
      }
      for (const field of ["claim", "solution", "verificationPlan"]) {
        if (typeof candidate[field] !== "string" || !candidate[field].trim()) {
          throw new Error(
            `${schemaName} present candidate requires a non-empty ${field}`,
          );
        }
      }
    }
  }
  if (schemaName === "candidate_verification" && data?.verdict === "pass") {
    if (!Array.isArray(data.reproducedChecks) || !data.reproducedChecks.length) {
      throw new Error(
        "A passing candidate verification requires at least one reproduced check",
      );
    }
    if (
      data.reproducedChecks.some(
        (check) => typeof check !== "string" || !check.trim(),
      ) ||
      typeof data.independentArtifact !== "string" ||
      !data.independentArtifact.trim()
    ) {
      throw new Error(
        "A passing candidate verification requires concrete non-empty checker evidence",
      );
    }
    if (data.fatalIssues?.length) {
      throw new Error("A passing candidate verification cannot report fatal issues");
    }
  }
}

function isProblemTerminal(status) {
  return [
    "candidate-complete-needs-expert",
    "candidate-complete-agent-reproduced",
    "exhausted-no-result",
    "deadline-reached",
    "budget-exhausted",
    "blocked",
  ].includes(status);
}

function startProblemClock(problem) {
  problem.activeWorkMs ??= 0;
  problem.activeWorkStartedAt ??= nowIso();
}

function stopProblemClock(problem) {
  if (!problem.activeWorkStartedAt) return;
  problem.activeWorkMs =
    (problem.activeWorkMs ?? 0) +
    Math.max(0, Date.now() - Date.parse(problem.activeWorkStartedAt));
  problem.activeWorkStartedAt = null;
}

function problemActiveHours(problem) {
  const current = problem.activeWorkStartedAt
    ? Math.max(0, Date.now() - Date.parse(problem.activeWorkStartedAt))
    : 0;
  return ((problem.activeWorkMs ?? 0) + current) / 3_600_000;
}

function researchPhase(elapsed) {
  if (elapsed < 1) {
    return {
      name: "SPEC_LOCK_AND_BASELINE",
      instruction: "Audit the exact statement, establish known cases, and define a falsifiable baseline before building on it.",
    };
  }
  if (elapsed < 4) {
    return {
      name: "DIVERGE",
      instruction: "Probe genuinely different representations and archive negative results quickly; preserve branch diversity.",
    };
  }
  if (elapsed < 8) {
    return {
      name: "DEPTH",
      instruction: "Deepen only evidence-bearing branches and demand exact lemmas, reductions, or reproducible computations.",
    };
  }
  if (elapsed < 12) {
    return {
      name: "CANDIDATE_AND_RED_TEAM",
      instruction: "Turn the strongest lead into a complete artifact and try to falsify it before spending effort on presentation.",
    };
  }
  if (elapsed < 18) {
    return {
      name: "SECOND_WAVE",
      instruction: "Use a fresh representation to repair or independently attack the evidence that justified extending past 12 hours.",
    };
  }
  if (elapsed < 22) {
    return {
      name: "REPRODUCE_OR_FORMALIZE",
      instruction: "Prioritize independent reproduction, exactness, assumption audits, and formalization over new speculative branches.",
    };
  }
  return {
    name: "DOSSIER",
    instruction: "Freeze speculative discovery. Verify what can still be checked and produce a precise partial-result and failure dossier.",
  };
}

export function makeRunDir(runRoot) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.resolve(runRoot, `${stamp}-${shortId()}`);
}

export async function exportSummary(state, runDir) {
  const summary = {
    runId: state.runId,
    status: state.status,
    startedAt: state.startedAt,
    deadlineAt: state.deadlineAt,
    provider: state.provider,
    budget: state.budget,
    problems: state.problems.map((problem) => ({
      id: problem.packet.id,
      title: problem.packet.title,
      status: problem.status,
      rounds: problem.round,
      branches: problem.branches.map((branch) => ({
        id: branch.id,
        status: branch.status,
        turns: branch.turns,
        noProgressEpochs: branch.noProgressEpochs,
      })),
      bestCandidate: problem.bestCandidate,
      stopReason: problem.stopReason,
    })),
  };
  await writeJsonAtomic(path.join(runDir, "summary.json"), summary);
  return summary;
}
