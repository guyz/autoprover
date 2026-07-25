import { access, readFile } from "node:fs/promises";
import path from "node:path";
import {
  isApiBilledProvider,
  canonicalProviderName,
} from "./config.mjs";
import {
  Autoprover,
  normalizeProblem,
  validateProblemPacket,
} from "./orchestrator.mjs";
import {
  CampaignStore,
  emptyCatalog,
  leaseTokenMatches,
} from "./campaign-store.mjs";
import {
  Semaphore,
  advanceActiveClock,
  clamp,
  nowIso,
  readJson,
  sha256,
  shortId,
  sleep,
  slugify,
  writeJsonAtomic,
} from "./utils.mjs";
import { counterexampleOpportunity } from "./falsification.mjs";
import {
  selectProblemPortfolio,
  strategyCoverageReceipt,
} from "./diversity.mjs";
import {
  loadErdosProblemIndex,
  selectErdosProblemHints,
} from "./problem-sources/erdos.mjs";

const HOUR_MS = 60 * 60 * 1_000;
const CONTINUOUS_CHILD_MAX_CALLS = Number.MAX_SAFE_INTEGER;
const ACTIVE_CHILD_STATUSES = new Set([
  "created",
  "discovering",
  "ready",
  "running",
]);

export class CampaignController {
  constructor({
    config,
    provider,
    providerName,
    store,
    state,
    policy,
    dependencies = {},
    resumeOptions = null,
  }) {
    this.config = structuredClone(config);
    this.provider = provider;
    this.providerName = canonicalProviderName(providerName);
    this.store = store;
    this.state = state;
    this.policy = policy;
    this.dependencies = dependencies;
    this.resumeOptions = resumeOptions;
    this.activeWorkers = new Map();
    this.refreshPromise = null;
    this.operatorDiscoveryPromise = null;
    this.continuousBudgetRefillPromise = null;
    this.globalCallSemaphore = new Semaphore(
      isApiBilledProvider(this.providerName)
        ? 1
        : policy.maxConcurrentCalls,
    );
    this.gatedProvider = {
      run: (request) =>
        this.globalCallSemaphore.use(() =>
          this.runProviderCall(request),
        ),
    };
  }

  static async create({
    config,
    provider,
    providerName,
    campaignDir = defaultCampaignDir(config),
    catalogDir,
    policy = {},
    seedProblems = [],
    dependencies = {},
  }) {
    const resolvedPolicy = resolveCampaignPolicy(config, policy);
    const store = new CampaignStore(campaignDir, {
      catalogDir: catalogDir ?? path.resolve(config.runRoot, "_catalog"),
    });
    const startedAt = nowIso();
    const campaignId = path.basename(path.resolve(campaignDir));
    const state = {
      schemaVersion: 1,
      campaignId,
      provider: canonicalProviderName(providerName),
      status: "created",
      startedAt,
      updatedAt: startedAt,
      selectionSeed: sha256(
        `${campaignId}:${startedAt}:${shortId()}`,
      ),
      selectionEpoch: 0,
      deadlineAt: new Date(
        Date.now() + resolvedPolicy.durationHours * HOUR_MS,
      ).toISOString(),
      configSnapshot: structuredClone(config),
      policy: resolvedPolicy,
      cycle: 0,
      lastDiscoveryAt: null,
      nextDiscoveryAt: startedAt,
      emptyDiscoveryCycles: 0,
      discoveryRuns: {},
      budget: emptyCampaignBudget(),
      slots: Array.from(
        { length: resolvedPolicy.parallelProblems },
        (_, index) => emptySlot(index + 1),
      ),
      attempts: {},
      tournament: createTournamentState(resolvedPolicy, startedAt),
      activeClock: {
        lastHeartbeatAt: startedAt,
        suspendedMs: 0,
        lastSuspensionMs: 0,
      },
      notes: [],
      stopReason: "",
    };
    await store.initialize(state, emptyCatalog());
    const controller = new CampaignController({
      config,
      provider,
      providerName,
      store,
      state,
      policy: resolvedPolicy,
      dependencies,
    });
    if (seedProblems.length) {
      await controller.mergeCatalogProblems(seedProblems, {
        source: "seed",
        vetted: true,
      });
    }
    await controller.addNote(
      "info",
      `Campaign created with ${resolvedPolicy.parallelProblems} parallel problem slot${resolvedPolicy.parallelProblems === 1 ? "" : "s"}.`,
    );
    return controller;
  }

  static async resume({
    config,
    provider,
    providerName,
    campaignDir,
    catalogDir,
    policy = {},
    dependencies = {},
    extendHours = 0,
  }) {
    const store = new CampaignStore(campaignDir, {
      catalogDir: catalogDir ?? path.resolve(config.runRoot, "_catalog"),
    });
    const state = await store.loadCampaign();
    const canonicalStored = canonicalProviderName(state.provider);
    const canonicalRequested = canonicalProviderName(providerName);
    if (canonicalStored !== canonicalRequested) {
      throw new Error(
        `Campaign provider is pinned to ${canonicalStored}; received ${canonicalRequested}`,
      );
    }
    const resolvedPolicy = resolveCampaignPolicy(
      config,
      {
        ...(state.policy ?? {}),
        parallelProblems: config.parallelProblems,
        maxConcurrentCalls: config.maxConcurrentCalls,
        maxCalls: config.maxCalls,
        maxEstimatedUsd: config.maxEstimatedUsd,
        ...policy,
      },
    );
    state.configSnapshot = structuredClone(config);
    state.policy = resolvedPolicy;
    migrateCampaignState(state, resolvedPolicy);
    return new CampaignController({
      config,
      provider,
      providerName: canonicalStored,
      store,
      state,
      policy: resolvedPolicy,
      dependencies,
      resumeOptions: {
        extendHours: nonNegativeNumber(extendHours, "extendHours"),
      },
    });
  }

  async run() {
    await this.store.acquireCampaignLock();
    const stopActiveClock = this.startActiveClock();
    try {
      if (this.resumeOptions) {
        const extendHours = this.resumeOptions.extendHours ?? 0;
        if (
          Number.isFinite(this.state.pausedRemainingMs) &&
          this.state.pausedRemainingMs >= 0
        ) {
          this.state.deadlineAt = new Date(
            Date.now() +
              this.state.pausedRemainingMs +
              extendHours * HOUR_MS,
          ).toISOString();
        } else if (extendHours > 0) {
          this.state.deadlineAt = new Date(
            Math.max(Date.now(), Date.parse(this.state.deadlineAt)) +
              extendHours * HOUR_MS,
          ).toISOString();
        }
        this.state.pausedAt = null;
        this.state.pausedRemainingMs = null;
        await this.store.clearStopRequest();
        if (
          [
            "stopped",
            "deadline-reached",
            "budget-exhausted",
            "awaiting-manual",
            "catalog-exhausted",
          ].includes(this.state.status)
        ) {
          this.state.status = "running";
          this.state.stopReason = "";
        }
        await this.restoreLegacyBoundaryAttempts();
        await this.store.event("campaign.resumed", {
          extendHours,
          deadlineAt: this.state.deadlineAt,
        });
        await this.store.saveCampaign(this.state);
        this.resumeOptions = null;
      }
      await this.reconcile();
      if (await this.shouldStop()) return this.finishFromStop();
      this.state.status = "running";
      this.state.stopReason = "";
      await this.store.clearStopRequest();
      await this.store.event("campaign.started", {
        campaignId: this.state.campaignId,
        deadlineAt: this.state.deadlineAt,
      });
      await this.store.saveCampaign(this.state);

      while (true) {
        if (await this.shouldStop()) break;
        await this.processControlCommands();
        await this.reapFinishedWorkers();
        if (!this.policy.tournamentEnabled || this.activeWorkers.size === 0) {
          await this.resumePendingDiscovery();
        }
        await this.advanceTournamentIfReady();
        await this.fillAvailableSlots();

        const eligibleCount = await this.eligibleCount();
        if (
          !this.refreshPromise &&
          !this.operatorDiscoveryPromise &&
          !this.hasPendingDiscovery() &&
          this.freeSlotCount() > 0 &&
          eligibleCount < this.policy.catalogLowWatermark &&
          this.discoveryDue() &&
          this.canRefreshCatalog()
        ) {
          await this.refreshCatalog();
          await this.fillAvailableSlots();
        }

        if (this.activeWorkers.size === 0) {
          if (this.refreshPromise || this.operatorDiscoveryPromise) {
            await sleep(this.policy.idlePollMs);
            continue;
          }
          const waitingManual = this.state.slots.some(
            (slot) => slot.status === "awaiting-manual",
          );
          if (waitingManual || this.hasPendingManualDiscovery()) {
            this.state.status = "awaiting-manual";
            this.state.stopReason =
              "One or more research or discovery runs need imported manual Pro responses";
            break;
          }
          if (await this.shouldStop()) break;
          const afterRefreshEligible = await this.eligibleCount();
          if (
            afterRefreshEligible === 0 &&
            !this.canRefreshCatalog()
          ) {
            this.state.status = "completed";
            this.state.stopReason =
              "Configured campaign discovery-cycle limit reached";
            break;
          }
          if (
            afterRefreshEligible === 0 &&
            this.state.emptyDiscoveryCycles >=
              this.policy.maxEmptyDiscoveryCycles
          ) {
            this.state.status = "catalog-exhausted";
            this.state.stopReason =
              "No eligible vetted problems remained after repeated discovery";
            break;
          }
          await sleep(this.policy.idlePollMs);
          continue;
        }

        await Promise.race([
          ...this.activeWorkers.values(),
          sleep(this.policy.idlePollMs),
        ]).catch(() => {});
      }

      await this.reapFinishedWorkers();
      if (this.activeWorkers.size) {
        const requestedTerminalStatus = this.state.status;
        const requestedStopReason = this.state.stopReason;
        this.state.status = "stopping";
        await this.store.saveCampaign(this.state);
        await Promise.allSettled([...this.activeWorkers.values()]);
        await this.reapFinishedWorkers();
        this.state.status = requestedTerminalStatus;
        this.state.stopReason = requestedStopReason;
      }
      return this.finishFromStop();
    } finally {
      stopActiveClock();
      await this.store.releaseCampaignLock();
    }
  }

  async restoreLegacyBoundaryAttempts() {
    const catalog = await this.store.loadCatalog();
    const attempts = Object.values(this.state.attempts ?? {})
      .filter(
        (attempt) =>
          attempt.projectedAt &&
          !attempt.switchRequestedAt &&
          attempt.status === "completed",
      )
      .sort((left, right) =>
        String(right.completedAt ?? right.projectedAt).localeCompare(
          String(left.completedAt ?? left.projectedAt),
        ),
      );
    const consideredProblems = new Set();
    for (const attempt of attempts) {
      if (consideredProblems.has(attempt.problemKey)) continue;
      consideredProblems.add(attempt.problemKey);
      if (
        this.state.slots.some(
          (slot) =>
            slot.status !== "idle" && slot.problemKey === attempt.problemKey,
        ) ||
        Object.values(this.state.attempts).some(
          (other) =>
            other.attemptId !== attempt.attemptId &&
            other.problemKey === attempt.problemKey &&
            !other.projectedAt,
        )
      ) {
        continue;
      }
      const entry = catalog.entries?.[attempt.problemKey];
      const record = entry?.attempts?.find(
        (candidate) => candidate.attemptId === attempt.attemptId,
      );
      if (!record || record.hasCandidate) continue;
      const child = await readChildState(attempt.runDir);
      const stoppedAtBoundary =
        ["deadline-reached", "budget-exhausted"].includes(child?.status) ||
        child?.problems?.some((problem) =>
          ["deadline-reached", "budget-exhausted"].includes(problem.status),
        ) ||
        (
          record.outcome === "interrupted" &&
          /configured stop boundary/i.test(record.note ?? attempt.note ?? "")
        );
      if (!stoppedAtBoundary) continue;
      const slot = this.state.slots.find((candidate) => candidate.status === "idle");
      if (!slot) break;
      const lease = await this.store.acquireLease(attempt.problemKey, {
        ownerId: `${this.state.campaignId}:${slot.slotId}`,
        slotId: slot.slotId,
        attemptId: attempt.attemptId,
        runDir: attempt.runDir,
        ttlMs: this.policy.leaseTtlMs,
      });
      if (!lease) continue;
      let restored = false;
      await this.store.withCatalogLock(async (lockedCatalog) => {
        const lockedEntry = lockedCatalog.entries?.[attempt.problemKey];
        if (!lockedEntry || !leaseTokenMatches(lockedEntry, lease)) return;
        const before = lockedEntry.attempts?.length ?? 0;
        lockedEntry.attempts = (lockedEntry.attempts ?? []).filter(
          (candidate) => candidate.attemptId !== attempt.attemptId,
        );
        if (lockedEntry.attempts.length === before) return;
        lockedEntry.lifecycle = "eligible";
        lockedEntry.cooldownUntil = null;
        lockedEntry.latestNote =
          "Recovered a saved attempt that an older controller finalized at a campaign boundary.";
        lockedEntry.ranking = scoreCatalogEntry(lockedEntry);
        restored = true;
      });
      if (!restored) {
        await this.store.releaseLease(attempt.problemKey, lease);
        continue;
      }
      Object.assign(attempt, {
        status: "paused",
        completedAt: null,
        projectedAt: null,
        outcome: null,
        lease,
        pausedAt: nowIso(),
        pauseReason: "Recovered from a legacy campaign-boundary projection",
        recoveredBoundaryProjection: true,
      });
      Object.assign(slot, {
        status: "paused",
        problemKey: attempt.problemKey,
        attemptId: attempt.attemptId,
        runDir: attempt.runDir,
        startedAt: attempt.startedAt,
        latestNote:
          "Saved work recovered. Resume continues the same branches and artifacts.",
      });
      await this.addNote(
        "info",
        `Recovered ${attempt.attemptId}; it will resume from its saved run directory.`,
        { problemKey: attempt.problemKey, attemptId: attempt.attemptId },
      );
      await this.store.event("campaign.legacy_boundary_attempt_restored", {
        problemKey: attempt.problemKey,
        attemptId: attempt.attemptId,
        runDir: attempt.runDir,
      });
    }
  }

  async reconcile() {
    migrateCampaignState(this.state, this.policy);
    for (const lease of await this.store.listLeases()) {
      if (
        lease.ownerId?.startsWith(`${this.state.campaignId}:`) &&
        !this.state.attempts?.[lease.attemptId]
      ) {
        await this.store.releaseLease(lease.problemKey, lease);
        await this.addNote(
          "warning",
          `Released an orphaned lease for ${lease.problemKey} during crash recovery.`,
          { problemKey: lease.problemKey },
        );
      }
    }
    const catalog = await this.store.loadCatalog();
    for (const slot of this.state.slots) {
      if (!slot.attemptId || slot.status === "idle") continue;
      const attempt = this.state.attempts[slot.attemptId];
      const entry = catalog.entries?.[slot.problemKey];
      if (!attempt || !entry || !leaseTokenMatches(entry, attempt.lease)) {
        slot.status = "idle";
        slot.problemKey = null;
        slot.attemptId = null;
        slot.runDir = null;
        await this.addNote(
          "warning",
          `Cleared orphaned slot ${slot.slotId}; its durable lease no longer matched.`,
        );
        continue;
      }
      const childState = await readChildState(attempt.runDir);
      const pausedAttempt =
        !attempt.projectedAt &&
        ["paused", "deadline-reached", "budget-exhausted"].includes(
          attempt.status,
        );
      if (childState && isChildTerminal(childState.status) && !pausedAttempt) {
        await this.projectFinishedAttempt(attempt, childState);
        continue;
      }
      if (childState?.status === "awaiting-manual") {
        if (await hasImportedManualResponse(childState)) {
          this.launchAttemptWorker(attempt, { resume: true });
        } else {
          slot.status = "awaiting-manual";
          attempt.status = "awaiting-manual";
        }
        continue;
      }
      this.launchAttemptWorker(attempt, {
        resume: Boolean(childState),
      });
    }
    await this.store.saveCampaign(this.state);
  }

  async processControlCommands() {
    const pending = await this.store.listCommands({ statuses: ["pending"] });
    if (!pending.length) return;

    const discoveryCommands = [];
    for (const command of pending) {
      try {
        if (command.type === "discover" || command.type === "add-problem") {
          discoveryCommands.push(command);
          continue;
        }
        if (command.type === "prioritize") {
          await this.applyPrioritizeCommand(command);
          continue;
        }
        if (command.type === "switch") {
          await this.applySwitchCommand(command);
          continue;
        }
        await this.store.saveCommand(command, {
          status: "failed",
          completedAt: nowIso(),
          error: `Unsupported campaign command: ${command.type}`,
        });
      } catch (error) {
        await this.store.saveCommand(command, {
          status: "failed",
          completedAt: nowIso(),
          error: error.message,
        });
        await this.addNote(
          "warning",
          `Operator command ${command.type} failed: ${error.message}`,
        );
      }
    }

    if (
      discoveryCommands.length &&
      !this.refreshPromise &&
      !this.operatorDiscoveryPromise
    ) {
      const hints = discoveryCommands
        .filter((command) => command.type === "add-problem")
        .map((command) => String(command.query ?? "").trim())
        .filter(Boolean);
      this.operatorDiscoveryPromise = (async () => {
        for (const command of discoveryCommands) {
          await this.store.saveCommand(command, {
            status: "running",
            startedAt: nowIso(),
          });
        }
        const result = await this.refreshCatalog({
          reason: hints.length
            ? "Operator requested targeted catalog additions"
            : "Operator requested more catalog problems",
          hints,
          commandIds: discoveryCommands.map((command) => command.id),
        });
        for (const command of discoveryCommands) {
          await this.store.saveCommand(command, {
            status: result?.error ? "failed" : "completed",
            completedAt: nowIso(),
            result: {
              added: result?.added ?? 0,
              seen: result?.seen ?? 0,
            },
            error: result?.error ?? null,
          });
        }
      })()
        .catch(async (error) => {
          for (const command of discoveryCommands) {
            await this.store.saveCommand(command, {
              status: "failed",
              completedAt: nowIso(),
              error: error.message,
            });
          }
          await this.addNote(
            "warning",
            `Operator-requested discovery failed: ${error.message}`,
          );
        })
        .finally(() => {
          this.operatorDiscoveryPromise = null;
        });
    }
  }

  async applyPrioritizeCommand(command) {
    let title;
    await this.store.withCatalogLock(async (catalog) => {
      const entry = catalog.entries?.[command.problemKey];
      if (!entry) throw new Error("The requested backlog problem no longer exists");
      if (
        [
          "solved",
          "human-review",
          "candidate-review",
          "retired",
          "quarantined",
        ].includes(entry.lifecycle)
      ) {
        throw new Error(
          `“${entry.packet?.title ?? command.problemKey}” is ${entry.lifecycle} and cannot be queued next`,
        );
      }
      if (entry.lease) {
        throw new Error(
          `“${entry.packet?.title ?? command.problemKey}” is already active`,
        );
      }
      title = entry.packet?.title ?? command.problemKey;
      entry.lifecycle = "eligible";
      entry.cooldownUntil = null;
      entry.operatorPriority = {
        requestedAt: nowIso(),
        commandId: command.id,
      };
      entry.latestNote = "Pinned by the operator to run next";
      entry.ranking = scoreCatalogEntry(entry);
    });
    await this.store.saveCommand(command, {
      status: "completed",
      completedAt: nowIso(),
    });
    await this.addNote("action", `“${title}” was moved to the front of the backlog.`, {
      problemKey: command.problemKey,
    });
  }

  async applySwitchCommand(command) {
    const attempt =
      this.state.attempts?.[command.attemptId] ??
      Object.values(this.state.attempts ?? {}).find(
        (candidate) =>
          candidate.problemKey === command.problemKey &&
          !candidate.projectedAt,
      );
    if (!attempt || attempt.projectedAt) {
      throw new Error("The requested problem attempt is no longer active");
    }
    attempt.switchRequestedAt ??= nowIso();
    attempt.switchCommandId ??= command.id;
    attempt.switchReason =
      String(command.reason ?? "").trim() ||
      "Operator requested a switch to another backlog problem";
    const slot = this.slotForAttempt(attempt.attemptId);
    if (slot) {
      slot.latestNote =
        "Switch requested; the current model call will checkpoint first";
    }
    await this.store.saveCampaign(this.state);
    await this.store.saveCommand(command, {
      status: "running",
      startedAt: nowIso(),
      attemptId: attempt.attemptId,
    });
    await this.addNote(
      "action",
      `Switch requested for ${attempt.problemKey}; it will leave the slot at the next safe checkpoint.`,
      {
        problemKey: attempt.problemKey,
        attemptId: attempt.attemptId,
      },
    );
  }

  async refreshCatalog({
    reason = "Scheduled catalog refresh",
    hints = [],
    commandIds = [],
  } = {}) {
    if (this.refreshPromise) return this.refreshPromise;
    if (this.hasPendingDiscovery()) {
      return this.resumePendingDiscovery();
    }
    this.state.cycle += 1;
    const cycle = this.state.cycle;
    this.state.attemptsAtLastDiscovery = this.completedAttemptCount();
    this.state.lastDiscoveryAt = nowIso();
    this.state.nextDiscoveryAt = new Date(
      Date.now() + this.policy.discoveryRefreshMs,
    ).toISOString();
    await this.addNote(
      "info",
      `Discovery cycle ${cycle} is searching for fresh, currently open problems. ${reason}`,
    );
    this.state.discoveryRuns ??= {};
    this.state.discoveryRuns[String(cycle)] = {
      cycle,
      runDir: path.join(
        this.store.campaignDir,
        "discovery",
        `cycle-${String(cycle).padStart(4, "0")}-${shortId()}`,
      ),
      status: "starting",
      startedAt: nowIso(),
      completedAt: null,
      error: null,
      reason,
      hints: [...new Set(hints.map((entry) => String(entry).trim()).filter(Boolean))],
      commandIds: [...new Set(commandIds)],
    };
    await this.store.saveCampaign(this.state);
    this.refreshPromise = this.performDiscoveryCycle(cycle)
      .finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }

  async performDiscoveryCycle(cycle) {
    const record = this.state.discoveryRuns?.[String(cycle)];
    if (!record) throw new Error(`Missing discovery record for cycle ${cycle}`);
    record.status = "running";
    record.error = null;
    await this.store.saveCampaign(this.state);
    try {
      let problems;
      if (this.dependencies.discoveryRunner) {
        problems = await this.dependencies.discoveryRunner({
          cycle,
          controller: this,
        });
      } else {
        const runDir = record.runDir;
        const discoveryConfig = this.childConfig({
          wallClockHours: this.remainingHours(),
        });
        discoveryConfig.discovery = {
          ...discoveryConfig.discovery,
          attackCount: Math.min(
            discoveryConfig.discovery.poolSize,
            Math.max(
              discoveryConfig.discovery.attackCount,
              this.policy.discoveryBatchSize,
            ),
          ),
        };
        const existingChild = await readChildState(runDir);
        let discoveryState = existingChild;
        if (
          !existingChild?.discovery ||
          existingChild.status === "awaiting-manual" ||
          ACTIVE_CHILD_STATUSES.has(existingChild.status)
        ) {
          if (
            existingChild?.status === "awaiting-manual" &&
            !(await hasImportedManualResponse(existingChild))
          ) {
            record.status = "awaiting-manual";
            this.state.discoveryAwaitingManual = true;
            await this.store.saveCampaign(this.state);
            return { added: 0, pendingManual: true };
          }
          let app;
          if (existingChild) {
            app = await Autoprover.resume({
              config: discoveryConfig,
              provider: this.discoveryCycleProvider(record.hints),
              providerName: this.providerName,
              runDir,
              extendHours: 0,
            });
          } else {
            app = await Autoprover.create({
              config: discoveryConfig,
              provider: this.discoveryCycleProvider(record.hints),
              providerName: this.providerName,
              runDir,
            });
          }
          try {
            await app.discover();
            discoveryState = app.state;
          } finally {
            if (app.lockHeld) {
              await app.store.releaseLock();
              app.lockHeld = false;
            }
          }
        }
        problems = (discoveryState?.discovery?.vetted ?? []).filter(
          (entry) => entry.vetting?.recommendation === "attack",
        );
      }
      const merged = await this.mergeCatalogProblems(problems ?? [], {
        source: `discovery-cycle-${cycle}`,
        vetted: true,
      });
      this.state.emptyDiscoveryCycles = merged.added > 0
        ? 0
        : this.state.emptyDiscoveryCycles + 1;
      if (!merged.added) {
        this.state.nextDiscoveryAt = new Date(
          Date.now() + this.policy.emptyDiscoveryBackoffMs,
        ).toISOString();
      }
      await this.addNote(
        merged.added ? "progress" : "info",
        merged.added
          ? `Discovery cycle ${cycle} added ${merged.added} eligible problem${merged.added === 1 ? "" : "s"} to the catalog.`
          : `Discovery cycle ${cycle} found no new eligible problem; the next refresh will back off.`,
      );
      await this.store.event("campaign.discovery_completed", {
        cycle,
        received: problems?.length ?? 0,
        ...merged,
      });
      record.status = "completed";
      record.completedAt = nowIso();
      this.state.discoveryAwaitingManual = false;
      await this.store.saveCampaign(this.state);
      return merged;
    } catch (error) {
      if (isManualInputPending(error)) {
        record.status = "awaiting-manual";
        record.error = error.message;
        this.state.discoveryAwaitingManual = true;
        await this.addNote(
          "action",
          `Discovery cycle ${cycle} is waiting for a manual Pro response.`,
        );
        await this.store.event("campaign.discovery_awaiting_manual", {
          cycle,
          runDir: record.runDir,
          packetId: error.packetId ?? null,
          packetDir: error.packetDir ?? null,
        });
        await this.store.saveCampaign(this.state);
        return { added: 0, pendingManual: true };
      }
      record.status = "failed";
      record.completedAt = nowIso();
      record.error = error.message;
      this.state.emptyDiscoveryCycles += 1;
      this.state.nextDiscoveryAt = new Date(
        Date.now() + this.policy.emptyDiscoveryBackoffMs,
      ).toISOString();
      await this.addNote(
        "warning",
        `Discovery cycle ${cycle} could not complete: ${error.message}`,
      );
      await this.store.event("campaign.discovery_failed", {
        cycle,
        error: error.message,
      });
      await this.store.saveCampaign(this.state);
      if (error instanceof CampaignBudgetExhaustedError) return { added: 0 };
      return { added: 0, error: error.message };
    }
  }

  async resumePendingDiscovery() {
    if (this.refreshPromise) return false;
    const pending = Object.values(this.state.discoveryRuns ?? {})
      .filter((record) =>
        ["starting", "running", "awaiting-manual"].includes(record.status),
      )
      .sort((left, right) => right.cycle - left.cycle)[0];
    if (!pending) return false;
    const child = await readChildState(pending.runDir);
    if (
      pending.status === "awaiting-manual" &&
      !(await hasImportedManualResponse(child))
    ) {
      return false;
    }
    this.refreshPromise = this.performDiscoveryCycle(pending.cycle)
      .finally(() => {
        this.refreshPromise = null;
      });
    await this.refreshPromise;
    return true;
  }

  hasPendingDiscovery() {
    return Object.values(this.state.discoveryRuns ?? {}).some((record) =>
      ["starting", "running", "awaiting-manual"].includes(record.status),
    );
  }

  hasPendingManualDiscovery() {
    return Object.values(this.state.discoveryRuns ?? {}).some(
      (record) => record.status === "awaiting-manual",
    );
  }

  discoveryCycleProvider(hints = []) {
    const erdosHintCount = Math.ceil(
      Number(this.config.discovery.erdosShare ?? 0) *
        this.config.discovery.poolSize,
    );
    const erdosHintsPromise = erdosHintCount > 0
      ? loadErdosProblemIndex({
          url: this.config.discovery.erdosIndexUrl,
          timeoutMs: 3_000,
        })
          .then((entries) =>
            selectErdosProblemHints(entries, {
              count: erdosHintCount,
              seed:
                `${this.state.selectionSeed}:` +
                `discovery-cycle-${this.state.cycle}`,
            }),
          )
          .catch(() => [])
      : Promise.resolve([]);
    return {
      run: async (request) => {
        if (request.schema?.name !== "open_problem_discovery") {
          return this.gatedProvider.run(request);
        }
        const catalog = await this.store.loadCatalog();
        const existing = Object.values(catalog.entries ?? {})
          .slice(-100)
          .map((entry) => ({
            problemKey: entry.problemKey,
            title: entry.packet?.title,
            statement: entry.packet?.statement,
          }));
        const excluded = Object.values(catalog.exclusions ?? {})
          .slice(-100)
          .map((entry) => ({
            problemKey: entry.problemKey,
            title: entry.title,
            reason: entry.reason,
          }));
        const suffix = existing.length
          ? `\n\n<existing_campaign_catalog>\n${JSON.stringify(existing, null, 2)}\n</existing_campaign_catalog>\nDo not return an equivalent statement already in this catalog. Search different sources, domains, or exact variants.`
          : "";
        const exclusionSuffix = excluded.length
          ? `\n\n<locally_excluded_problems>\n${JSON.stringify(excluded, null, 2)}\n</locally_excluded_problems>\nDo not return these problems or cosmetically reworded equivalents. The operator reviewed and removed them from this local research portfolio.`
          : "";
        const operatorRequest = hints.length
          ? `\n\n<operator_requested_problems>\n${JSON.stringify(hints, null, 2)}\n</operator_requested_problems>\nThe operator explicitly requested these problem names or source URLs. Investigate each one first. Include it only if you can recover an exact, currently open statement with reliable sources and it passes the normal tractability and verifiability requirements. Do not invent missing statements or silently substitute a different problem. Use remaining capacity for other strong open problems.`
          : "";
        const erdosHints = await erdosHintsPromise;
        const erdosSuffix = erdosHints.length
          ? `\n\n<live_erdos_problem_candidates>\n${JSON.stringify(erdosHints, null, 2)}\n</live_erdos_problem_candidates>\nThese IDs were sampled from the live teorth/erdosproblems database only from unresolved states. Investigate enough of them to return roughly ${erdosHintCount} strong Erdős packets, but keep only exact variants that independently pass current-status and operational-readiness checks.`
          : "";
        const recentEvaluations =
          (this.state.tournament?.evaluations ?? []).slice(-3);
        const evaluationSuffix = recentEvaluations.length
          ? `\n\n<recent_strategy_evaluations>\n${JSON.stringify(recentEvaluations, null, 2)}\n</recent_strategy_evaluations>\nUse these receipts to avoid repeating source types whose prior candidates produced only bounded checks, timeouts, or no decisive route.`
          : "";
        const result = await this.gatedProvider.run({
          ...request,
          prompt:
            `${request.prompt}${suffix}${exclusionSuffix}${operatorRequest}` +
            `${erdosSuffix}${evaluationSuffix}`,
        });
        const existingKeys = new Set(existing.map((entry) => entry.problemKey));
        const existingTitles = new Set(
          existing.map((entry) => normalizedCatalogTitle(entry.title)),
        );
        const excludedKeys = new Set(
          excluded.map((entry) => entry.problemKey),
        );
        const excludedTitles = new Set(
          excluded.map((entry) => normalizedCatalogTitle(entry.title)),
        );
        const seenKeys = new Set();
        const seenTitles = new Set();
        const problems = (result.data?.problems ?? []).filter((problem) => {
          try {
            const packet = normalizeProblem(problem);
            const key = catalogProblemKey(packet);
            const title = normalizedCatalogTitle(packet.title);
            if (
              existingKeys.has(key) ||
              excludedKeys.has(key) ||
              existingTitles.has(title) ||
              excludedTitles.has(title) ||
              seenKeys.has(key) ||
              seenTitles.has(title)
            ) {
              return false;
            }
            seenKeys.add(key);
            seenTitles.add(title);
            return true;
          } catch {
            return true;
          }
        });
        return {
          ...result,
          data: {
            ...result.data,
            problems,
          },
        };
      },
    };
  }

  async mergeCatalogProblems(
    problems,
    { source = "unknown", vetted = false } = {},
  ) {
    const normalized = deduplicateCatalogCandidates(
      problems.map((problem) => normalizeProblem(problem)),
    );
    const now = nowIso();
    const result = {
      added: 0,
      excluded: 0,
      seen: normalized.length,
      problemKeys: [],
    };
    await this.store.withCatalogLock(async (catalog) => {
      catalog.entries ??= {};
      catalog.exclusions ??= {};
      const excludedTitles = new Set(
        Object.values(catalog.exclusions)
          .map((entry) => normalizedCatalogTitle(entry.title))
          .filter(Boolean),
      );
      for (const packet of normalized) {
        validateProblemPacket(packet);
        const problemKey = catalogProblemKey(packet);
        result.problemKeys.push(problemKey);
        if (
          catalog.exclusions[problemKey] ||
          excludedTitles.has(normalizedCatalogTitle(packet.title))
        ) {
          result.excluded += 1;
          continue;
        }
        const existing = catalog.entries[problemKey];
        if (existing) {
          existing.lastSeenAt = now;
          existing.sources = [
            ...new Set([...(existing.sources ?? []), source]),
          ];
          if (vetted) {
            existing.vet = {
              verified: true,
              verifiedAt: now,
              expiresAt: new Date(
                Date.parse(now) + this.policy.reverifyMs,
              ).toISOString(),
            };
          }
          existing.packetVersions ??= [
            {
              version: existing.packetVersion ?? 1,
              packet: structuredClone(existing.packet),
              observedAt: existing.discoveredAt ?? now,
              source: existing.sources?.[0] ?? "legacy",
            },
          ];
          if (
            packetFingerprint(existing.packet) !==
            packetFingerprint(packet)
          ) {
            existing.packetVersion = (existing.packetVersion ?? 1) + 1;
            existing.packet = structuredClone(packet);
            existing.packetVersions.push({
              version: existing.packetVersion,
              packet: structuredClone(packet),
              observedAt: now,
              source,
            });
          }
          existing.ranking = scoreCatalogEntry(existing);
          continue;
        }
        const entry = makeCatalogEntry(packet, {
          problemKey,
          source,
          vetted,
          now,
          reverifyMs: this.policy.reverifyMs,
          maxAttempts: this.policy.maxAttemptsPerProblem,
        });
        entry.ranking = scoreCatalogEntry(entry);
        catalog.entries[problemKey] = entry;
        result.added += 1;
      }
    });
    return result;
  }

  async fillAvailableSlots() {
    if (!this.canStartWork()) return;
    const catalog = await this.store.loadCatalog();
    const entries = Object.values(catalog.entries ?? {});
    if (this.policy.tournamentEnabled) {
      await this.fillPromotedSlots(catalog);
    }
    if (
      this.policy.tournamentEnabled &&
      this.state.tournament?.stage !== "probing"
    ) {
      return;
    }
    let ranked = rankCatalogEntries(entries);
    if (this.policy.tournamentEnabled) {
      ranked = this.tournamentEligibleEntries(ranked);
    }
    const preparedAttempts = [];
    const selectedPackets = this.state.slots
      .filter((slot) => slot.problemKey)
      .map((slot) => catalog.entries?.[slot.problemKey]?.packet)
      .filter(Boolean);
    const idleSlots = this.state.slots.filter(
      (entry) => entry.status === "idle",
    );
    const activeProbeCount = Object.values(this.state.attempts ?? {}).filter(
      (attempt) =>
        attempt.stage === "probe" &&
        attempt.tournamentRound === this.state.tournament?.round &&
        ["starting", "running", "awaiting-manual"].includes(attempt.status),
    ).length;
    const remainingProbeCapacity = this.policy.tournamentEnabled
      ? Math.max(
          0,
          this.policy.probeProblemCount -
            (this.state.tournament?.roundProbedProblemKeys?.length ?? 0) -
            activeProbeCount,
        )
      : idleSlots.length;
    const selectableSlots = idleSlots.slice(0, remainingProbeCapacity);
    if (!selectableSlots.length || !ranked.length) return;
    const portfolio = selectProblemPortfolio(ranked, {
      count: selectableSlots.length,
      seed: this.state.selectionSeed,
      cycle: `${this.state.cycle}:${this.state.selectionEpoch}`,
      selectedPackets,
      coverageEntries: entries,
    });
    this.state.selectionEpoch += 1;
    await this.store.event("campaign.portfolio_selected", {
      selectionEpoch: this.state.selectionEpoch,
      selected: portfolio.map((entry) => ({
        problemKey: entry.problemKey,
        reason: entry.selection?.reason,
        quality: entry.selection?.quality,
        coverage: entry.selection?.coverage,
        similarity: entry.selection?.similarity,
      })),
    });

    for (const slot of selectableSlots) {
      if (!this.canStartWork()) break;
      let attempt = null;
      while (!attempt && portfolio.length) {
        const entry = portfolio.shift();
        attempt = await this.startAttempt(slot, entry, {
          stage: this.policy.tournamentEnabled ? "probe" : "standard",
        });
      }
      if (attempt) preparedAttempts.push(attempt);
    }
    if (!preparedAttempts.length) {
      await this.store.saveCampaign(this.state);
    }
    for (const attempt of preparedAttempts) {
      this.launchAttemptWorker(attempt, { resume: false });
    }
  }

  async fillPromotedSlots(catalog) {
    const stage = this.state.tournament?.stage;
    if (!["probing", "semifinal", "deep"].includes(stage)) return;
    const idleSlots = this.state.slots.filter(
      (entry) => entry.status === "idle",
    );
    if (!idleSlots.length) return;
    const promoted = new Set(
      this.state.tournament?.promotedProblemKeys ?? [],
    );
    const resumable = Object.values(this.state.attempts ?? {})
      .filter(
        (attempt) =>
          attempt.tournamentRound === this.state.tournament?.round &&
          (
            stage === "probing"
              ? attempt.stage === "probe"
              : promoted.has(attempt.problemKey) && attempt.stage === stage
          ) &&
          !attempt.projectedAt &&
          ["promoted", "paused", "retryable"].includes(attempt.status) &&
          !this.slotForAttempt(attempt.attemptId),
      )
      .sort(
        (left, right) =>
          Number(right.probeScore ?? 0) - Number(left.probeScore ?? 0),
      );
    for (const slot of idleSlots) {
      if (!this.canStartWork()) break;
      let attempt = null;
      while (!attempt && resumable.length) {
        const candidate = resumable.shift();
        const entry = catalog.entries?.[candidate.problemKey];
        if (!entry) continue;
        attempt = await this.resumePromotedAttempt(slot, candidate, entry);
      }
      if (attempt) this.launchAttemptWorker(attempt, { resume: true });
    }
  }

  async resumePromotedAttempt(slot, attempt, entry) {
    const lease = await this.store.acquireLease(entry.problemKey, {
      ownerId: `${this.state.campaignId}:${slot.slotId}`,
      slotId: slot.slotId,
      attemptId: attempt.attemptId,
      runDir: attempt.runDir,
      ttlMs: this.policy.leaseTtlMs,
    });
    if (!lease) return null;
    const wasRetryable = attempt.status === "retryable";
    attempt.lease = lease;
    attempt.slotId = slot.slotId;
    attempt.status = wasRetryable ? "retrying" : "promoted";
    attempt.pauseReason =
      wasRetryable
        ? `Retrying the interrupted ${attempt.stage} stage from its saved thread`
        : `Promoted into ${attempt.stage}; resume the exact saved research thread`;
    Object.assign(slot, {
      status: "starting",
      problemKey: entry.problemKey,
      attemptId: attempt.attemptId,
      runDir: attempt.runDir,
      startedAt: attempt.startedAt,
      latestNote:
        `${tournamentStageLabel(attempt.stage)}: ${entry.packet.title}`,
    });
    await this.store.event("campaign.problem_promoted_started", {
      problemKey: entry.problemKey,
      attemptId: attempt.attemptId,
      slotId: slot.slotId,
      tournamentRound: attempt.tournamentRound,
      probeScore: attempt.probeScore,
      stage: attempt.stage,
    });
    await this.store.saveCampaign(this.state);
    return attempt;
  }

  async startAttempt(slot, entry, { stage = "standard" } = {}) {
    const attemptId = `attempt-${String(
      Object.keys(this.state.attempts).length + 1,
    ).padStart(4, "0")}-${entry.problemKey.slice(0, 10)}-${shortId()}`;
    const runDir = this.store.attemptDir(attemptId);
    const ownerId = `${this.state.campaignId}:${slot.slotId}`;
    const lease = await this.store.acquireLease(entry.problemKey, {
      ownerId,
      slotId: slot.slotId,
      attemptId,
      runDir,
      ttlMs: this.policy.leaseTtlMs,
    });
    if (!lease) return null;
    if (entry.operatorPriority) {
      await this.store.withCatalogLock(async (catalog) => {
        const leasedEntry = catalog.entries?.[entry.problemKey];
        if (leaseTokenMatches(leasedEntry, lease)) {
          leasedEntry.operatorPriority = null;
        }
      });
    }
    const attempt = {
      attemptId,
      problemKey: entry.problemKey,
      packetVersion: entry.packetVersion,
      runDir,
      slotId: slot.slotId,
      status: "starting",
      startedAt: nowIso(),
      completedAt: null,
      lease,
      projectedAt: null,
      outcome: null,
      note: "",
      stage,
      tournamentRound:
        stage === "probe" ? this.state.tournament?.round ?? 1 : null,
      probeCompletedAt: null,
      probeScore: null,
      probeScoreBreakdown: null,
      stageScores: {},
      stageRetries: {},
      solverTurnTargets: {},
      stageStartSolverTurns: {
        [stage]: 0,
      },
    };
    this.state.attempts[attemptId] = attempt;
    Object.assign(slot, {
      status: "starting",
      problemKey: entry.problemKey,
      attemptId,
      runDir,
      startedAt: attempt.startedAt,
      latestNote: `Preparing ${entry.packet.title}`,
    });
    await this.addNote(
      "progress",
      `Slot ${slot.slotId} selected “${entry.packet.title}” for ${
        stage === "probe" ? "a short probe" : "research"
      } (${entry.ranking?.rationale ?? "automatic quality-diversity selection"}).`,
      { problemKey: entry.problemKey, attemptId },
    );
    await this.store.event("campaign.problem_leased", {
      problemKey: entry.problemKey,
      attemptId,
      slotId: slot.slotId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
    });
    await this.store.saveCampaign(this.state);
    return attempt;
  }

  launchAttemptWorker(attempt, { resume }) {
    if (this.activeWorkers.has(attempt.attemptId)) return;
    const resumeFromCampaignBoundary =
      Boolean(resume) &&
      (
        Boolean(attempt.pauseReason) ||
        (
          attempt.stage === "deep" &&
          Boolean(attempt.probeCompletedAt)
        ) ||
        ["paused", "deadline-reached", "budget-exhausted"].includes(
          attempt.status,
        )
      );
    const slot = this.slotForAttempt(attempt.attemptId);
    if (slot) slot.status = "running";
    attempt.status = "running";
    attempt.pausedAt = null;
    attempt.pauseReason = "";
    const promise = this.executeAttempt(attempt, {
      resume,
      resumeFromCampaignBoundary,
    })
      .catch(async (error) => {
        attempt.status = "failed";
        attempt.completedAt = nowIso();
        attempt.outcome = "failed";
        attempt.note = error.message;
        await this.addNote(
          "warning",
          `Attempt ${attempt.attemptId} failed: ${error.message}`,
          { problemKey: attempt.problemKey, attemptId: attempt.attemptId },
        );
        const childState = await readChildState(attempt.runDir);
        await this.projectFinishedAttempt(
          attempt,
          childState ?? {
            status: "completed-with-errors",
            budget: emptyCampaignBudget(),
            problems: [],
            stopReason: error.message,
          },
        );
      })
      .finally(() => {
        this.activeWorkers.delete(attempt.attemptId);
      });
    this.activeWorkers.set(attempt.attemptId, promise);
  }

  async executeAttempt(
    attempt,
    { resume, resumeFromCampaignBoundary = false },
  ) {
    const catalog = await this.store.loadCatalog();
    const entry = catalog.entries?.[attempt.problemKey];
    if (!entry || !leaseTokenMatches(entry, attempt.lease)) {
      throw new Error("Attempt lease is no longer current");
    }
    const heartbeat = setInterval(() => {
      this.store
        .heartbeatLease(attempt.problemKey, attempt.lease, {
          ttlMs: this.policy.leaseTtlMs,
        })
        .catch(() => {});
    }, this.policy.leaseHeartbeatMs);
    heartbeat.unref?.();
    try {
      const attemptWindowHours = this.attemptWindowHours(attempt);
      const childConfig = this.childConfig({
        wallClockHours: attemptWindowHours,
      });
      if (this.policy.tournamentEnabled) {
        const solverTurnTarget = this.stageSolverTurnTarget(attempt.stage);
        childConfig.maxSolverTurnsPerProblem = solverTurnTarget;
        attempt.solverTurnTargets ??= {};
        attempt.solverTurnTargets[attempt.stage] = solverTurnTarget;
      }
      let app;
      const attemptProvider = {
        run: async (request) => {
          if (attempt.switchRequestedAt) {
            throw new CampaignProblemSwitchRequestedError(
              attempt.switchReason ||
                "Operator requested a switch to another backlog problem",
            );
          }
          return this.gatedProvider.run(request);
        },
      };
      if (resume && (await fileExists(path.join(attempt.runDir, "run.json")))) {
        const previousChildState = await readChildState(attempt.runDir);
        const childExtendHours = childResumeExtensionHours({
          childState: previousChildState,
          resumeFromCampaignBoundary,
          windowHours: attemptWindowHours,
        });
        app = await Autoprover.resume({
          config: childConfig,
          provider: attemptProvider,
          providerName: this.providerName,
          runDir: attempt.runDir,
          extendHours: childExtendHours,
          reopenInterrupted:
            resumeFromCampaignBoundary ||
            ["retrying", "retryable"].includes(attempt.status),
        });
      } else {
        app = await Autoprover.create({
          config: childConfig,
          provider: attemptProvider,
          providerName: this.providerName,
          runDir: attempt.runDir,
        });
        await app.seedProblems([packetWithPriorResearch(entry)], {
          vet: false,
        });
      }
      await app.run();
      const childState = app.state;
      if (childState.status === "awaiting-manual") {
        attempt.status = "awaiting-manual";
        const slot = this.slotForAttempt(attempt.attemptId);
        if (slot) {
          slot.status = "awaiting-manual";
          slot.latestNote = "Waiting for a manual Pro response";
        }
        await this.addNote(
          "action",
          `“${entry.packet.title}” is waiting for a manual Pro response.`,
          { problemKey: entry.problemKey, attemptId: attempt.attemptId },
        );
        await this.store.saveCampaign(this.state);
        return;
      }
      await this.projectFinishedAttempt(attempt, childState);
    } finally {
      clearInterval(heartbeat);
    }
  }

  attemptWindowHours(attempt) {
    if (
      this.policy.tournamentEnabled &&
      ["probe", "semifinal", "deep"].includes(attempt.stage)
    ) {
      const minimumCallWindowHours =
        Math.max(
          Number(this.config.codex?.turnTimeoutMinutes ?? 120),
          Number(this.config.claude?.turnTimeoutMinutes ?? 120),
          Number(this.config.responses?.requestTimeoutMinutes ?? 120),
        ) /
          60 +
        0.25;
      return Math.min(
        this.policy.stageHardHours,
        Math.max(this.remainingHours(), minimumCallWindowHours),
      );
    }
    return Math.min(this.policy.problemHours, this.remainingHours());
  }

  stageSolverTurnTarget(stage) {
    if (stage === "probe") return this.policy.probeSolverTurns;
    if (stage === "semifinal") return this.policy.semifinalSolverTurns;
    if (stage === "deep") return this.policy.deepSolverTurns;
    return Number(this.config.maxSolverTurnsPerProblem ?? 0);
  }

  async projectFinishedAttempt(attempt, childState) {
    if (attempt.projectedAt) {
      await this.releaseAttemptSlot(attempt);
      return;
    }
    // A subscription-backed continuous campaign treats maxCalls as a durable
    // renewal batch, not as a stop boundary. Renew before deciding whether the
    // child was interrupted so an attempt that ends exactly on the boundary is
    // projected normally and its slot can keep moving.
    await this.ensureContinuousCallBudget();
    const summary = summarizeChildAttempt(attempt, childState);
    summary.stageSolverTurns = Math.max(
      0,
      summary.solverTurns -
        Number(attempt.stageStartSolverTurns?.[attempt.stage] ?? 0),
    );
    const stopRequest = await this.store.readStopRequest();
    const callOrCostBudgetExhausted = !this.globalBudgetAvailable();
    const interrupted =
      Boolean(attempt.switchRequestedAt) ||
      Boolean(stopRequest) ||
      callOrCostBudgetExhausted ||
      this.deadlineReached() ||
      (this.state.stopRequestedByCandidate && this.policy.stopOnCandidate);
    const pausedByCampaignBoundary =
      !attempt.switchRequestedAt &&
      !summary.hasCandidate &&
      (
        Boolean(stopRequest) ||
        callOrCostBudgetExhausted ||
        this.deadlineReached() ||
        (this.state.stopRequestedByCandidate && this.policy.stopOnCandidate)
      );
    if (pausedByCampaignBoundary) {
      const pauseReason = stopRequest?.reason ||
        (this.deadlineReached()
          ? "Campaign deadline reached"
          : callOrCostBudgetExhausted
            ? "Campaign call budget reached"
            : "Campaign paused after another problem produced a candidate");
      attempt.status = "paused";
      attempt.pausedAt = nowIso();
      attempt.pauseReason = pauseReason;
      attempt.note = summary.note;
      attempt.checkpoint = summary;
      const slot = this.slotForAttempt(attempt.attemptId);
      if (slot) {
        slot.status = "paused";
        slot.latestNote =
          `Paused at a saved checkpoint: ${pauseReason}. Continue resumes this exact attempt.`;
      }
      await this.addNote(
        "info",
        `Paused “${childState.problems?.[0]?.packet?.title ?? attempt.problemKey}” at its saved checkpoint. Continue will resume the same branches and artifacts.`,
        { problemKey: attempt.problemKey, attemptId: attempt.attemptId },
      );
      await this.store.event("campaign.attempt_paused", {
        attemptId: attempt.attemptId,
        problemKey: attempt.problemKey,
        runDir: attempt.runDir,
        pauseReason,
        childStatus: childState.status,
      });
      await this.store.saveCampaign(this.state);
      return;
    }
    const tournamentStage =
      attempt.stage === "probe" ? "probing" : attempt.stage;
    if (
      this.policy.tournamentEnabled &&
      ["probing", "semifinal", "deep"].includes(tournamentStage) &&
      this.state.tournament?.stage === tournamentStage &&
      !summary.hasCandidate &&
      !interrupted
    ) {
      if (summary.stageSolverTurns > 0 && summary.outcome !== "failed") {
        await this.checkpointProbeAttempt(attempt, childState, summary);
      } else {
        await this.markTournamentAttemptRetryable(
          attempt,
          childState,
          summary,
        );
      }
      return;
    }
    if (attempt.switchRequestedAt && !summary.hasCandidate) {
      summary.outcome = "interrupted";
      summary.note = `${summary.note} Switched out at an operator-requested checkpoint.`;
    } else if (interrupted && summary.outcome === "failed") {
      summary.outcome = "interrupted";
      summary.note = `${summary.note} The campaign interrupted this attempt at a configured stop boundary.`;
    }
    let accepted = false;
    await this.store.withCatalogLock(async (catalog) => {
      const entry = catalog.entries?.[attempt.problemKey];
      if (!entry || !leaseTokenMatches(entry, attempt.lease)) return;
      entry.attempts ??= [];
      if (!entry.attempts.some((record) => record.attemptId === attempt.attemptId)) {
        entry.attempts.push(summary);
      }
      entry.latestNote = summary.note;
      entry.lastAttemptAt = summary.completedAt;
      if (summary.hasCandidate) {
        entry.lifecycle =
          summary.outcome === "solved" ? "solved" : "human-review";
        entry.cooldownUntil = null;
        if (this.policy.stopOnCandidate) {
          this.state.stopRequestedByCandidate = true;
        }
      } else if (summary.outcome === "interrupted") {
        entry.lifecycle = attempt.switchRequestedAt ? "cooldown" : "eligible";
        entry.cooldownUntil = attempt.switchRequestedAt
          ? new Date(
              Date.now() + this.policy.operatorSwitchCooldownMs,
            ).toISOString()
          : null;
      } else if (summary.outcome === "failed") {
        entry.failureCount = (entry.failureCount ?? 0) + 1;
        entry.lifecycle =
          entry.failureCount >= this.policy.maxAttemptFailures
            ? "quarantined"
            : "cooldown";
        entry.cooldownUntil =
          entry.lifecycle === "cooldown"
            ? new Date(Date.now() + this.policy.failureCooldownMs).toISOString()
            : null;
      } else {
        const terminalAttempts = entry.attempts.filter(
          (record) => !record.hasCandidate,
        ).length;
        entry.lifecycle =
          terminalAttempts >= (entry.maxAttempts ?? this.policy.maxAttemptsPerProblem)
            ? "retired"
            : "cooldown";
        entry.cooldownUntil =
          entry.lifecycle === "cooldown"
            ? new Date(Date.now() + this.policy.cooldownMs).toISOString()
            : null;
      }
      entry.ranking = scoreCatalogEntry(entry);
      accepted = true;
    });
    if (!accepted) {
      await this.addNote(
        "warning",
        `Ignored stale result from ${attempt.attemptId}; its lease fence changed.`,
        { problemKey: attempt.problemKey, attemptId: attempt.attemptId },
      );
      await this.releaseAttemptSlot(attempt, { releaseLease: false });
      return;
    }
    attempt.status = "completed";
    attempt.completedAt = summary.completedAt;
    attempt.projectedAt = nowIso();
    attempt.outcome = summary.outcome;
    attempt.note = summary.note;
    await this.addNote(
      summary.outcome === "solved"
        ? "solved"
        : summary.hasCandidate
          ? "candidate"
          : "result",
      summary.note,
      { problemKey: attempt.problemKey, attemptId: attempt.attemptId },
    );
    await this.store.event("campaign.attempt_projected", summary);
    if (attempt.switchCommandId) {
      const [switchCommand] = await this.store.listCommands({
        statuses: ["running", "pending"],
      }).then((commands) =>
        commands.filter((command) => command.id === attempt.switchCommandId),
      );
      if (switchCommand) {
        await this.store.saveCommand(switchCommand, {
          status: "completed",
          completedAt: nowIso(),
          result: {
            outcome: summary.outcome,
            cooldownUntil: new Date(
              Date.now() + this.policy.operatorSwitchCooldownMs,
            ).toISOString(),
          },
        });
      }
    }
    await this.releaseAttemptSlot(attempt);
    await this.store.saveCampaign(this.state);
  }

  async checkpointProbeAttempt(attempt, childState, summary) {
    const score = scoreProbeAttempt({
      summary,
      childState,
    });
    const stage = attempt.stage ?? "probe";
    const stageLabel = tournamentStageLabel(stage);
    let accepted = false;
    await this.store.withCatalogLock(async (catalog) => {
      const entry = catalog.entries?.[attempt.problemKey];
      if (!entry || !leaseTokenMatches(entry, attempt.lease)) return;
      entry.probes ??= [];
      if (
        !entry.probes.some(
          (record) =>
            record.attemptId === attempt.attemptId &&
            (record.stage ?? "probe") === stage,
        )
      ) {
        entry.probes.push({
          attemptId: attempt.attemptId,
          runDir: attempt.runDir,
          tournamentRound: attempt.tournamentRound,
          stage,
          completedAt: summary.completedAt,
          activeWorkMs: summary.activeWorkMs,
          callsStarted: summary.callsStarted,
          rounds: summary.rounds,
          solverTurns: summary.stageSolverTurns,
          cumulativeSolverTurns: summary.solverTurns,
          evidenceCount: summary.evidenceCount,
          score: score.score,
          scoreBreakdown: score.breakdown,
          promotable: score.promotable,
          decisiveProgress: score.decisiveProgress,
          strategyCoverage: summary.strategyCoverage ?? [],
          note: summary.note,
        });
      }
      entry.lifecycle = "eligible";
      entry.cooldownUntil = null;
      entry.latestNote =
        `${stageLabel} complete (decisive score ${score.score.toFixed(1)}); ` +
        "awaiting automatic comparison.";
      entry.ranking = scoreCatalogEntry(entry);
      accepted = true;
    });
    if (!accepted) {
      await this.releaseAttemptSlot(attempt, { releaseLease: false });
      return;
    }
    attempt.status = "stage-complete";
    attempt.probeCompletedAt ??= summary.completedAt;
    attempt.probeScore = score.score;
    attempt.probeScoreBreakdown = score.breakdown;
    attempt.stageScores ??= {};
    attempt.stageScores[stage] = {
      score: score.score,
      breakdown: score.breakdown,
      promotable: score.promotable,
      decisiveProgress: score.decisiveProgress,
      completedAt: summary.completedAt,
      solverTurns: summary.stageSolverTurns,
      cumulativeSolverTurns: summary.solverTurns,
    };
    attempt.checkpoint = summary;
    attempt.note = summary.note;
    const completionField = tournamentCompletionField(stage);
    this.state.tournament[completionField] = [
      ...new Set([
        ...(this.state.tournament[completionField] ?? []),
        attempt.problemKey,
      ]),
    ];
    if (stage === "probe") {
      this.state.tournament.allProbedProblemKeys = [
        ...new Set([
          ...(this.state.tournament.allProbedProblemKeys ?? []),
          attempt.problemKey,
        ]),
      ];
      this.state.tournament.lastProbedRoundByProblem[attempt.problemKey] =
        attempt.tournamentRound;
    }
    await this.store.event("campaign.tournament_stage_completed", {
      attemptId: attempt.attemptId,
      problemKey: attempt.problemKey,
      tournamentRound: attempt.tournamentRound,
      stage,
      probeScore: score.score,
      scoreBreakdown: score.breakdown,
      promotable: score.promotable,
      decisiveProgress: score.decisiveProgress,
    });
    await this.addNote(
      "progress",
      `${stageLabel} saved for “${childState.problems?.[0]?.packet?.title ?? attempt.problemKey}”. Its decisive score is ${score.score.toFixed(1)}; ${score.promotable ? "it remains eligible for more compute" : "bounded or non-decisive work will not be promoted"}.`,
      { problemKey: attempt.problemKey, attemptId: attempt.attemptId },
    );
    await this.releaseAttemptSlot(attempt);
    await this.store.saveCampaign(this.state);
  }

  async markTournamentAttemptRetryable(attempt, childState, summary) {
    const stage = attempt.stage ?? "probe";
    attempt.stageRetries ??= {};
    const retries = (attempt.stageRetries[stage] ?? 0) + 1;
    attempt.stageRetries[stage] = retries;
    if (retries <= this.policy.maxStageRetries) {
      attempt.status = "retryable";
      attempt.pauseReason =
        `${tournamentStageLabel(stage)} did not complete a solver turn; ` +
        `retry ${retries}/${this.policy.maxStageRetries} will resume the saved thread`;
      attempt.note = summary.note;
      await this.store.withCatalogLock(async (catalog) => {
        const entry = catalog.entries?.[attempt.problemKey];
        if (!entry || !leaseTokenMatches(entry, attempt.lease)) return;
        entry.lifecycle = "eligible";
        entry.cooldownUntil = null;
        entry.latestNote = attempt.pauseReason;
      });
      await this.store.event("campaign.tournament_stage_retryable", {
        attemptId: attempt.attemptId,
        problemKey: attempt.problemKey,
        tournamentRound: attempt.tournamentRound,
        stage,
        retries,
        childStatus: childState.status,
      });
      await this.releaseAttemptSlot(attempt);
      await this.store.saveCampaign(this.state);
      return;
    }
    summary.note =
      `${summary.note} ${tournamentStageLabel(stage)} exhausted ` +
      `${this.policy.maxStageRetries} retries without a completed solver turn.`;
    await this.checkpointProbeAttempt(attempt, childState, summary);
  }

  async releaseAttemptSlot(attempt, { releaseLease = true } = {}) {
    if (releaseLease) {
      await this.store.releaseLease(
        attempt.problemKey,
        attempt.lease,
      ).catch(() => false);
    }
    const slot = this.slotForAttempt(attempt.attemptId);
    if (slot) Object.assign(slot, emptySlot(slot.slotId));
  }

  async reapFinishedWorkers() {
    const settled = [];
    for (const [attemptId, promise] of this.activeWorkers) {
      const marker = await Promise.race([
        promise.then(() => true, () => true),
        Promise.resolve(false),
      ]);
      if (marker) settled.push(attemptId);
    }
    for (const attemptId of settled) this.activeWorkers.delete(attemptId);
    if (settled.length) await this.store.saveCampaign(this.state);
  }

  async runProviderCall(request) {
    if (this.providerName === "pro-manual" && request.resumeId) {
      try {
        const resumed = await this.provider.run(request);
        this.state.budget.callsWaiting = Math.max(
          0,
          this.state.budget.callsWaiting - 1,
        );
        this.state.budget.callsCompleted += 1;
        recordCampaignUsage(
          this.state.budget,
          resumed.usage,
          this.providerName,
          this.config,
        );
        await this.store.saveCampaign(this.state);
        return resumed;
      } catch (error) {
        if (!isManualInputPending(error)) {
          this.state.budget.callsWaiting = Math.max(
            0,
            this.state.budget.callsWaiting - 1,
          );
          this.state.budget.callsFailed += 1;
          await this.store.saveCampaign(this.state);
        }
        throw error;
      }
    }
    await this.reserveGlobalCall(request.role);
    let result;
    try {
      result = await this.provider.run(request);
    } catch (error) {
      if (isManualInputPending(error)) {
        this.state.budget.inFlight = Math.max(
          0,
          this.state.budget.inFlight - 1,
        );
        this.state.budget.callsWaiting += 1;
        await this.store.saveCampaign(this.state);
      } else {
        await this.finishGlobalCall(error?.usage, false);
      }
      throw error;
    }
    await this.finishGlobalCall(result.usage, true);
    return result;
  }

  async reserveGlobalCall(role) {
    const stopRequest = await this.store.readStopRequest();
    if (
      stopRequest ||
      ["stopping", "stopped"].includes(this.state.status) ||
      (this.state.stopRequestedByCandidate && this.policy.stopOnCandidate)
    ) {
      throw new CampaignStopRequestedError(
        stopRequest?.reason || "Campaign stop requested",
      );
    }
    await this.ensureContinuousCallBudget();
    if (!this.globalBudgetAvailable() || this.deadlineReached()) {
      throw new CampaignBudgetExhaustedError(
        `Campaign budget or deadline exhausted before ${role ?? "model"} call`,
      );
    }
    this.state.budget.callsStarted += 1;
    this.state.budget.inFlight += 1;
    await this.store.saveCampaign(this.state);
  }

  async finishGlobalCall(usage = {}, completed) {
    this.state.budget.inFlight = Math.max(0, this.state.budget.inFlight - 1);
    this.state.budget[completed ? "callsCompleted" : "callsFailed"] += 1;
    recordCampaignUsage(
      this.state.budget,
      usage,
      this.providerName,
      this.config,
    );
    await this.store.saveCampaign(this.state);
  }

  async eligibleCount() {
    const catalog = await this.store.loadCatalog();
    return this.tournamentEligibleEntries(
      Object.values(catalog.entries ?? {}),
    ).length;
  }

  tournamentEligibleEntries(entries) {
    const eligible = (entries ?? []).filter((entry) =>
      isCampaignCandidateEligible(entry),
    );
    if (!this.policy.tournamentEnabled) return eligible;
    const tournament = this.state.tournament;
    if (["semifinal", "deep"].includes(tournament?.stage)) {
      const promoted = new Set(tournament.promotedProblemKeys ?? []);
      return eligible.filter((entry) => promoted.has(entry.problemKey));
    }
    return eligible.filter(
      (entry) => {
        if (entry.operatorPriority) return true;
        const lastRound = Number(
          tournament?.lastProbedRoundByProblem?.[entry.problemKey] ?? 0,
        );
        return (
          !lastRound ||
          Number(tournament?.round ?? 1) - lastRound >=
            this.policy.retryAfterRounds
        );
      },
    );
  }

  async advanceTournamentIfReady() {
    if (!this.policy.tournamentEnabled) return false;
    const tournament = this.state.tournament;
    if (!tournament) return false;
    if (!["probing", "semifinal", "deep"].includes(tournament.stage)) {
      return false;
    }
    if (this.activeWorkers.size > 0) return false;
    const stage = tournament.stage === "probing" ? "probe" : tournament.stage;
    const attempts = this.tournamentStageAttempts(stage).filter(
      (attempt) => attempt.status === "stage-complete",
    );
    if (!attempts.length) return false;

    if (stage === "probe") {
      const catalog = await this.store.loadCatalog();
      const unprobed = this.tournamentEligibleEntries(
        Object.values(catalog.entries ?? {}),
      );
      const enough = attempts.length >= this.policy.probeProblemCount;
      const timePressure = this.remainingHours() <= 2.5;
      const discoveryExhausted =
        unprobed.length === 0 &&
        (
          !this.canRefreshCatalog() ||
          this.state.emptyDiscoveryCycles >=
            this.policy.maxEmptyDiscoveryCycles
        );
      const minimumRequired =
        timePressure || discoveryExhausted
          ? 1
          : this.policy.minimumPromotableProbes;
      if (
        attempts.length < minimumRequired ||
        (!enough && !timePressure && !discoveryExhausted)
      ) {
        return false;
      }
      await this.recordTournamentEvaluation(stage, attempts);
      const promoted = await this.promoteTournamentStage(attempts, {
        fromStage: "probe",
        toStage: "semifinal",
        count: this.policy.semifinalProblemCount,
        minimumScore: this.policy.probePromotionScore,
      });
      if (!promoted.length) {
        await this.startNextTournamentRound(
          "The probe strategy produced no decisive lead, so no arbitrary finalist received more compute.",
        );
      }
      return true;
    }

    const expectedKeys = new Set(tournament.promotedProblemKeys ?? []);
    if (
      attempts.length < expectedKeys.size ||
      attempts.some((attempt) => !expectedKeys.has(attempt.problemKey))
    ) {
      return false;
    }
    await this.recordTournamentEvaluation(stage, attempts);

    if (stage === "semifinal") {
      const promoted = await this.promoteTournamentStage(attempts, {
        fromStage: "semifinal",
        toStage: "deep",
        count: this.policy.deepProblemCount,
        minimumScore: this.policy.deepPromotionScore,
      });
      if (!promoted.length) {
        await this.startNextTournamentRound(
          "The semifinal follow-ups did not turn any probe into a decisive route.",
        );
      }
      return true;
    }

    await this.finalizeTournamentAttempts(attempts, {
      stage: "deep",
      promotedIds: new Set(),
      terminal: true,
    });
    await this.startNextTournamentRound(
      "Deep finalists completed four solver turns without an accepted proof or counterexample.",
    );
    return true;
  }

  tournamentStageAttempts(stage) {
    return Object.values(this.state.attempts ?? {}).filter(
      (attempt) =>
        attempt.stage === stage &&
        attempt.tournamentRound === this.state.tournament?.round &&
        !attempt.projectedAt,
    );
  }

  async promoteTournamentStage(
    attempts,
    { fromStage, toStage, count, minimumScore },
  ) {
    const promotedAttempts = [...attempts]
      .filter((attempt) => {
        const score = attempt.stageScores?.[fromStage];
        return score?.promotable && Number(score.score ?? 0) >= minimumScore;
      })
      .sort(
        (left, right) =>
          Number(right.stageScores?.[fromStage]?.score ?? 0) -
            Number(left.stageScores?.[fromStage]?.score ?? 0) ||
          left.problemKey.localeCompare(right.problemKey),
      )
      .slice(0, count);
    const promotedIds = new Set(
      promotedAttempts.map((attempt) => attempt.attemptId),
    );
    await this.finalizeTournamentAttempts(attempts, {
      stage: fromStage,
      promotedIds,
      terminal: false,
    });
    const promotedAt = nowIso();
    for (const attempt of promotedAttempts) {
      attempt.stageStartSolverTurns ??= {};
      attempt.stageStartSolverTurns[toStage] =
        attempt.checkpoint?.solverTurns ?? 0;
      attempt.stage = toStage;
      attempt.status = "promoted";
      attempt.projectedAt = null;
      attempt.completedAt = null;
      attempt.outcome = null;
      attempt.pauseReason =
        `Promoted from ${tournamentStageLabel(fromStage)} to ` +
        `${tournamentStageLabel(toStage)} using decisive progress, not raw activity`;
    }
    this.state.tournament.stage = toStage;
    this.state.tournament.promotedAt = promotedAt;
    this.state.tournament.promotedProblemKeys = promotedAttempts.map(
      (attempt) => attempt.problemKey,
    );
    this.state.tournament[tournamentCompletionField(toStage)] = [];
    this.state.tournament.stageStartedAt = promotedAt;
    this.state.tournament.stageStartedCalls =
      this.state.budget.callsStarted;
    await this.store.withCatalogLock(async (catalog) => {
      for (const attempt of promotedAttempts) {
        const entry = catalog.entries?.[attempt.problemKey];
        if (!entry) continue;
        entry.lifecycle = "eligible";
        entry.cooldownUntil = null;
        entry.latestNote =
          `Promoted to ${tournamentStageLabel(toStage)} with decisive score ` +
          `${Number(attempt.stageScores?.[fromStage]?.score ?? 0).toFixed(1)}.`;
        entry.ranking = scoreCatalogEntry(entry);
      }
    });
    await this.store.event("campaign.tournament_promoted", {
      tournamentRound: this.state.tournament.round,
      fromStage,
      toStage,
      minimumScore,
      promoted: promotedAttempts.map((attempt) => ({
        attemptId: attempt.attemptId,
        problemKey: attempt.problemKey,
        score: attempt.stageScores?.[fromStage]?.score ?? 0,
        decisiveProgress:
          attempt.stageScores?.[fromStage]?.decisiveProgress ?? "none",
      })),
    });
    await this.addNote(
      promotedAttempts.length ? "progress" : "info",
      promotedAttempts.length
        ? `${tournamentStageLabel(fromStage)} promoted ${promotedAttempts.length} problem${promotedAttempts.length === 1 ? "" : "s"} to ${tournamentStageLabel(toStage)}.`
        : `${tournamentStageLabel(fromStage)} produced no lead above the decisive threshold.`,
    );
    await this.store.saveCampaign(this.state);
    return promotedAttempts;
  }

  async finalizeTournamentAttempts(
    attempts,
    { stage, promotedIds, terminal },
  ) {
    const completedAt = nowIso();
    await this.store.withCatalogLock(async (catalog) => {
      for (const attempt of attempts) {
        if (promotedIds.has(attempt.attemptId)) continue;
        const entry = catalog.entries?.[attempt.problemKey];
        attempt.status = terminal ? "completed" : "not-promoted";
        attempt.completedAt =
          attempt.checkpoint?.completedAt ?? completedAt;
        attempt.projectedAt = completedAt;
        attempt.outcome = terminal ? "not-solved" : `${stage}-deferred`;
        if (!entry) continue;
        if (terminal && attempt.checkpoint) {
          entry.attempts ??= [];
          if (
            !entry.attempts.some(
              (record) => record.attemptId === attempt.attemptId,
            )
          ) {
            entry.attempts.push({
              ...attempt.checkpoint,
              outcome: "not-solved",
            });
          }
          entry.lastAttemptAt = completedAt;
        }
        entry.lifecycle = "eligible";
        entry.cooldownUntil = null;
        entry.latestNote = terminal
          ? "No proof or counterexample after the configured deep solver turns; saved for a later reframed retry."
          : `${tournamentStageLabel(stage)} saved but not promoted because its work was less decisive than the alternatives.`;
        entry.ranking = scoreCatalogEntry(entry);
      }
    });
  }

  async recordTournamentEvaluation(stage, attempts) {
    const scores = attempts.map(
      (attempt) => attempt.stageScores?.[stage]?.score ?? 0,
    );
    const solverTurns = attempts.reduce(
      (sum, attempt) =>
        sum + Number(attempt.stageScores?.[stage]?.solverTurns ?? 0),
      0,
    );
    const decisiveLeads = attempts.filter((attempt) =>
      ["reusable-lemma", "exact-reduction", "complete-candidate"].includes(
        attempt.stageScores?.[stage]?.decisiveProgress,
      ),
    ).length;
    const zeroTurnAttempts = attempts.filter(
      (attempt) =>
        Number(attempt.stageScores?.[stage]?.solverTurns ?? 0) === 0,
    ).length;
    const evaluation = {
      at: nowIso(),
      round: this.state.tournament.round,
      stage,
      problemsCompared: attempts.length,
      solverTurns,
      zeroTurnAttempts,
      decisiveLeads,
      meanDecisiveScore: Number(
        (
          scores.reduce((sum, value) => sum + Number(value), 0) /
          Math.max(1, scores.length)
        ).toFixed(2),
      ),
      bestDecisiveScore: Number(Math.max(0, ...scores).toFixed(2)),
      callsUsed:
        this.state.budget.callsStarted -
        Number(this.state.tournament.stageStartedCalls ?? 0),
      verdict:
        zeroTurnAttempts > attempts.length / 3
          ? "mechanically-unhealthy"
          : decisiveLeads > 0
            ? "promising"
            : "weak",
    };
    this.state.tournament.evaluations ??= [];
    this.state.tournament.evaluations.push(evaluation);
    await this.store.event("campaign.strategy_evaluated", evaluation);
    await this.addNote(
      evaluation.verdict === "promising" ? "progress" : "info",
      `Strategy check: ${tournamentStageLabel(stage)} compared ${attempts.length} problems across ${solverTurns} completed solver turns; ${decisiveLeads} decisive lead${decisiveLeads === 1 ? "" : "s"}. Verdict: ${evaluation.verdict}.`,
    );
    return evaluation;
  }

  async startNextTournamentRound(reason) {
    if (this.remainingHours() <= 0.25) return false;
    const tournament = this.state.tournament;
    tournament.rounds ??= [];
    tournament.rounds.push({
      round: tournament.round,
      startedAt: tournament.roundStartedAt,
      completedAt: nowIso(),
      reason,
      probedProblemKeys: [...tournament.roundProbedProblemKeys],
      semifinalProblemKeys: [...tournament.roundSemifinalProblemKeys],
      deepProblemKeys: [...tournament.roundDeepProblemKeys],
    });
    tournament.round += 1;
    tournament.stage = "probing";
    tournament.roundStartedAt = nowIso();
    tournament.stageStartedAt = tournament.roundStartedAt;
    tournament.stageStartedCalls = this.state.budget.callsStarted;
    tournament.roundProbedProblemKeys = [];
    tournament.roundSemifinalProblemKeys = [];
    tournament.roundDeepProblemKeys = [];
    tournament.promotedProblemKeys = [];
    tournament.promotedAt = null;
    this.state.nextDiscoveryAt = nowIso();
    await this.store.event("campaign.tournament_round_started", {
      tournamentRound: tournament.round,
      reason,
    });
    await this.addNote(
      "info",
      `${reason} Round ${tournament.round} will discover and test different problems; saved work remains eligible after its automatic retry gap.`,
    );
    await this.store.saveCampaign(this.state);
    return true;
  }

  canStartWork() {
    return (
      !this.deadlineReached() &&
      (
        this.globalBudgetAvailable() ||
        this.canRefillContinuousCallBudget()
      ) &&
      this.state.status !== "stopping"
    );
  }

  globalBudgetAvailable() {
    return (
      this.callBudgetAvailable() &&
      (!isApiBilledProvider(this.providerName) ||
        this.state.budget.estimatedUsd < this.policy.maxEstimatedUsd)
    );
  }

  callBudgetAvailable() {
    return this.state.budget.callsStarted < this.policy.maxCalls;
  }

  canRefillContinuousCallBudget() {
    return (
      this.policy.continuous === true &&
      !isApiBilledProvider(this.providerName) &&
      !this.deadlineReached() &&
      !["stopping", "stopped"].includes(this.state.status)
    );
  }

  async ensureContinuousCallBudget() {
    if (this.callBudgetAvailable()) return false;
    if (!this.canRefillContinuousCallBudget()) return false;
    if (this.continuousBudgetRefillPromise) {
      return this.continuousBudgetRefillPromise;
    }
    this.continuousBudgetRefillPromise = (async () => {
      if (this.callBudgetAvailable()) return false;
      const previousLimit = this.policy.maxCalls;
      const batch = Math.max(
        this.policy.callBudgetBatch,
        this.policy.maxConcurrentCalls,
      );
      const nextLimit = Math.max(
        previousLimit + batch,
        this.state.budget.callsStarted + batch,
      );
      this.policy.maxCalls = nextLimit;
      this.state.policy.maxCalls = nextLimit;
      this.state.configSnapshot.maxCalls = nextLimit;
      await this.addNote(
        "info",
        `Continuous run renewed its call allowance from ${previousLimit} to ${nextLimit}; the wall-clock deadline is unchanged.`,
      );
      await this.store.event("campaign.call_budget_renewed", {
        previousLimit,
        nextLimit,
        callsStarted: this.state.budget.callsStarted,
        deadlineAt: this.state.deadlineAt,
      });
      return true;
    })().finally(() => {
      this.continuousBudgetRefillPromise = null;
    });
    return this.continuousBudgetRefillPromise;
  }

  deadlineReached() {
    this.tickActiveClock();
    return Date.now() >= Date.parse(this.state.deadlineAt);
  }

  startActiveClock() {
    this.activeClockUsers ??= 0;
    this.activeClockUsers += 1;
    if (!this.activeClockTimer) {
      this.tickActiveClock();
      this.activeClockTimer = setInterval(
        () => this.tickActiveClock(),
        1_000,
      );
      this.activeClockTimer.unref?.();
    }
    return () => {
      this.activeClockUsers = Math.max(0, (this.activeClockUsers ?? 1) - 1);
      if (this.activeClockUsers || !this.activeClockTimer) return;
      clearInterval(this.activeClockTimer);
      this.activeClockTimer = null;
    };
  }

  tickActiveClock() {
    const advanced = advanceActiveClock(
      this.state.activeClock,
      this.state.deadlineAt,
    );
    this.state.activeClock = advanced.clock;
    this.state.deadlineAt = advanced.deadlineAt;
    if (advanced.suspendedMs > 0) {
      this.state.lastSuspension = {
        at: nowIso(),
        durationMs: advanced.suspendedMs,
      };
    }
    return advanced.suspendedMs;
  }

  remainingHours() {
    return Math.max(
      1 / 60,
      (Date.parse(this.state.deadlineAt) - Date.now()) / HOUR_MS,
    );
  }

  discoveryDue() {
    if (this.policy.tournamentEnabled) {
      if (["semifinal", "deep"].includes(this.state.tournament?.stage)) {
        return false;
      }
      if (this.activeWorkers.size > 0) return false;
      const probed =
        this.state.tournament?.roundProbedProblemKeys?.length ?? 0;
      if (probed < this.policy.probeProblemCount) return true;
    }
    const attemptsSinceRefresh =
      this.completedAttemptCount() -
      (this.state.attemptsAtLastDiscovery ?? 0);
    return (
      Date.now() >= Date.parse(this.state.nextDiscoveryAt ?? 0) ||
      attemptsSinceRefresh >= this.policy.refreshEveryCycles
    );
  }

  canRefreshCatalog() {
    return (
      (
        !this.policy.tournamentEnabled ||
        (
          this.state.tournament?.stage === "probing" &&
          this.activeWorkers.size === 0
        )
      ) &&
      (
        this.policy.maxCycles === 0 ||
        this.state.cycle < this.policy.maxCycles
      )
    );
  }

  completedAttemptCount() {
    return Object.values(this.state.attempts ?? {}).filter(
      (attempt) => Boolean(attempt.projectedAt),
    ).length;
  }

  freeSlotCount() {
    return this.state.slots.filter((slot) => slot.status === "idle").length;
  }

  slotForAttempt(attemptId) {
    return this.state.slots.find((slot) => slot.attemptId === attemptId);
  }

  childConfig({ wallClockHours }) {
    return {
      ...structuredClone(this.config),
      provider: this.providerName,
      wallClockHours: Math.max(1 / 60, wallClockHours),
      parallelProblems: 1,
      // The campaign owns the shared call gate. Continuous subscription runs
      // must not also inherit a per-child copy of the renewal-batch boundary,
      // or every problem would stop independently at that arbitrary number.
      maxCalls: this.canRefillContinuousCallBudget()
        ? CONTINUOUS_CHILD_MAX_CALLS
        : this.policy.maxCalls,
      maxEstimatedUsd: this.policy.maxEstimatedUsd,
    };
  }

  async shouldStop() {
    if (this.state.stopRequestedByCandidate && this.policy.stopOnCandidate) {
      this.state.status = "completed-with-candidate";
      this.state.stopReason =
        "Campaign stopped after producing a candidate, as configured";
      return true;
    }
    const request = await this.store.readStopRequest();
    if (request) {
      this.state.status = "stopped";
      this.state.stopReason = request.reason || "Stop requested by operator";
      return true;
    }
    if (this.deadlineReached()) {
      this.state.status = "deadline-reached";
      this.state.stopReason = "Campaign wall-clock deadline reached";
      return true;
    }
    await this.ensureContinuousCallBudget();
    if (!this.globalBudgetAvailable()) {
      this.state.status = "budget-exhausted";
      this.state.stopReason = "Campaign call or estimated API-cost budget exhausted";
      return true;
    }
    return false;
  }

  async finishFromStop() {
    if (
      ![
        "awaiting-manual",
        "catalog-exhausted",
        "completed",
        "completed-with-candidate",
        "stopped",
        "deadline-reached",
        "budget-exhausted",
      ].includes(this.state.status)
    ) {
      const catalog = await this.store.loadCatalog();
      const hasCandidate = Object.values(catalog.entries ?? {}).some(
        (entry) =>
          ["solved", "human-review", "candidate-review"].includes(
            entry.lifecycle,
          ),
      );
      this.state.status = hasCandidate ? "completed-with-candidate" : "completed";
    }
    if (!this.state.stopReason) this.state.stopReason = "Campaign finished";
    if (
      this.state.status !== "deadline-reached" &&
      Date.parse(this.state.deadlineAt) > Date.now()
    ) {
      this.state.pausedAt = nowIso();
      this.state.pausedRemainingMs = Math.max(
        0,
        Date.parse(this.state.deadlineAt) - Date.now(),
      );
    }
    await this.addNote("result", this.state.stopReason);
    await this.store.event("campaign.finished", {
      status: this.state.status,
      stopReason: this.state.stopReason,
      budget: this.state.budget,
    });
    await this.store.saveCampaign(this.state);
    return buildCampaignSnapshot({
      campaignDir: this.store.campaignDir,
      runRoot: this.config.runRoot,
    });
  }

  async addNote(level, message, context = {}) {
    const note = {
      at: nowIso(),
      level,
      message,
      ...context,
    };
    this.state.notes ??= [];
    this.state.notes.push(note);
    if (this.state.notes.length > this.policy.maxSnapshotNotes) {
      this.state.notes.splice(
        0,
        this.state.notes.length - this.policy.maxSnapshotNotes,
      );
    }
    await this.store.event("campaign.note", note);
    await this.store.saveCampaign(this.state);
    return note;
  }
}

export class CampaignBudgetExhaustedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CampaignBudgetExhaustedError";
    this.code = "AUTOPROVER_CAMPAIGN_BUDGET_EXHAUSTED";
  }
}

export class CampaignStopRequestedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CampaignStopRequestedError";
    this.code = "AUTOPROVER_CAMPAIGN_STOP_REQUESTED";
  }
}

export class CampaignProblemSwitchRequestedError extends Error {
  constructor(message) {
    super(message);
    this.name = "CampaignProblemSwitchRequestedError";
    this.code = "AUTOPROVER_CAMPAIGN_PROBLEM_SWITCH_REQUESTED";
  }
}

export function defaultCampaignDir(config, campaignId = "default") {
  return path.resolve(
    config.runRoot,
    "campaigns",
    slugify(campaignId),
  );
}

export async function requestCampaignStop(
  campaignDir,
  reason = "Stop requested by operator",
) {
  const store = new CampaignStore(campaignDir);
  return store.requestStop(reason);
}

export async function buildCampaignSnapshot({ campaignDir, runRoot } = {}) {
  if (!campaignDir) throw new Error("campaignDir is required");
  const campaignPath = path.join(path.resolve(campaignDir), "campaign.json");
  const initialCampaign = await readJson(campaignPath);
  const resolvedRunRoot =
    runRoot ??
    initialCampaign.configSnapshot?.runRoot ??
    path.dirname(path.dirname(path.resolve(campaignDir)));
  const store = new CampaignStore(campaignDir, {
    catalogDir: path.resolve(resolvedRunRoot, "_catalog"),
  });
  const [campaign, catalog, operatorCommands] = await Promise.all([
    Promise.resolve(initialCampaign),
    store.loadCatalog(),
    store.listCommands(),
  ]);
  const entries = Object.values(catalog.entries ?? {});
  const displayRanked = entries
    .map((entry) => ({ entry, ranking: scoreCatalogEntry(entry) }))
    .sort(
      (left, right) =>
        Number(Boolean(right.entry.operatorPriority)) -
          Number(Boolean(left.entry.operatorPriority)) ||
        String(
          right.entry.operatorPriority?.requestedAt ?? "",
        ).localeCompare(
          String(left.entry.operatorPriority?.requestedAt ?? ""),
        ) ||
        right.ranking.priority - left.ranking.priority ||
        left.entry.problemKey.localeCompare(right.entry.problemKey),
    );
  const rankByKey = new Map(
    displayRanked.map(({ entry }, index) => [entry.problemKey, index + 1]),
  );
  const slotByKey = new Map(
    campaign.slots
      .filter((slot) => slot.problemKey)
      .map((slot) => [slot.problemKey, slot]),
  );
  const catalogItems = entries
    .map((entry) => {
      const ranking = scoreCatalogEntry(entry);
      const attemptHistory = (entry.attempts ?? []).map((attempt) => ({
        attemptId: attempt.attemptId,
        outcome: attempt.outcome,
        problemStatus: attempt.problemStatus ?? null,
        hasCandidate: Boolean(attempt.hasCandidate),
        hasVerifiedPartial: Boolean(attempt.hasVerifiedPartial),
        startedAt: attempt.startedAt,
        completedAt: attempt.completedAt,
        activeWorkMs: attempt.activeWorkMs ?? 0,
        callsStarted: attempt.callsStarted ?? 0,
        solverTurns: attempt.solverTurns ?? 0,
        rounds: attempt.rounds ?? 0,
        evidenceCount: attempt.evidenceCount ?? 0,
        candidateKind: attempt.candidateKind ?? null,
        note: attempt.note ?? "",
      }));
      const slot = slotByKey.get(entry.problemKey);
      const tournamentAttempt = Object.values(campaign.attempts ?? {})
        .filter((attempt) => attempt.problemKey === entry.problemKey)
        .sort((left, right) =>
          String(right.probeCompletedAt ?? right.completedAt ?? "").localeCompare(
            String(left.probeCompletedAt ?? left.completedAt ?? ""),
          ),
        )[0];
      const state = slot
        ? slot.status
        : ["probed", "stage-complete", "not-promoted"].includes(
              tournamentAttempt?.status,
            )
          ? "saved"
        : isCampaignCandidateEligible(entry)
          ? "queued"
          : entry.lifecycle ?? "deferred";
      return {
        id: entry.problemKey,
        title: entry.packet.title,
        domain: entry.packet.domain,
        rank: rankByKey.get(entry.problemKey) ?? 0,
        state,
        interest: entry.packet.interest,
        solvability: Number((ranking.solvability * 5).toFixed(2)),
        priority: Number((ranking.priority * 100).toFixed(1)),
        falsificationType: ranking.falsificationType,
        counterexampleSearchability: ranking.counterexampleSearchability,
        counterexampleOpportunity: Number(
          (ranking.counterexampleOpportunity * 5).toFixed(2),
        ),
        counterexampleBonus: Number(
          (ranking.counterexampleBonus * 100).toFixed(1),
        ),
        counterexampleVerificationPlan:
          entry.packet.counterexampleVerificationPlan ?? "",
        artifactReadiness: entry.packet.artifactReadiness ?? null,
        minimumDecisiveArtifact:
          entry.packet.minimumDecisiveArtifact ?? "",
        blockingDependencies:
          entry.packet.blockingDependencies ?? [],
        probeScore: tournamentAttempt?.probeScore ?? null,
        selectionReason: entry.operatorPriority
          ? "Pinned by the operator to run next"
          : ranking.rationale,
        lastVettedAt: entry.vet?.verifiedAt ?? null,
        attemptCount: entry.attempts?.length ?? 0,
        lastOutcome: entry.attempts?.at(-1)?.outcome ?? null,
        attemptHistory,
        lifecycle: entry.lifecycle ?? "eligible",
        cooldownUntil: entry.cooldownUntil ?? null,
        totalActiveWorkMs: attemptHistory.reduce(
          (sum, attempt) => sum + attempt.activeWorkMs,
          0,
        ),
        totalCalls: attemptHistory.reduce(
          (sum, attempt) => sum + attempt.callsStarted,
          0,
        ),
        failedAttemptCount: attemptHistory.filter(
          (attempt) => attempt.outcome === "failed",
        ).length,
        interruptedAttemptCount: attemptHistory.filter(
          (attempt) => attempt.outcome === "interrupted",
        ).length,
        operatorPinned: Boolean(entry.operatorPriority),
        workerSlot: slot ? `Worker slot ${slot.slotId}` : undefined,
        latestNote: entry.latestNote ?? "",
      };
    })
    .sort(
      (left, right) =>
        Number(!left.workerSlot) - Number(!right.workerSlot) ||
        left.rank - right.rank ||
        right.priority - left.priority ||
        left.id.localeCompare(right.id),
    );
  const runningSlots = campaign.slots
    .filter((slot) => slot.status !== "idle")
    .map((slot) => ({ ...slot }));
  const activeProblems = [];
  const completedProblems = [];
  const manualQueue = [];
  const childEvents = [];
  for (const slot of runningSlots) {
    const entry = catalog.entries?.[slot.problemKey];
    const attempt = campaign.attempts?.[slot.attemptId];
    const child = attempt ? await readChildState(attempt.runDir) : null;
    const problem = child?.problems?.[0];
    const previousAttempts = [];
    for (const previousAttempt of entry?.attempts ?? []) {
      const previousChild = await readChildState(previousAttempt.runDir);
      previousAttempts.push(
        projectCompletedProblem(entry, previousAttempt, previousChild),
      );
    }
    const coordinatorNote =
      problem?.syntheses?.at(-1)?.portfolioSummary ||
      problem?.sharedState?.portfolioSummary ||
      slot.latestNote ||
      entry?.latestNote ||
      "";
    const verificationRuns = (problem?.verificationRuns ?? []).map(
      (run) => ({
        candidateHash: run.candidateHash,
        candidateClaim: run.candidate?.claim ?? "",
        candidateKind: run.candidate?.kind ?? null,
        status: run.status,
        passes: (run.passes ?? []).map((pass, index) => ({
          pass: index + 1,
          verdict: pass.verdict,
          note:
            pass.feedbackToResearcher ||
            pass.fatalIssues?.[0] ||
            pass.exactnessAssessment ||
            "",
        })),
      }),
    );
    const activeVerificationRuns = verificationRuns.filter((run) =>
      ["checking", "running", "pending", "verifying"].includes(run.status),
    );
    const activeSolutionCheck = activeVerificationRuns.some((run) =>
      ["proof", "disproof"].includes(run.candidateKind),
    );
    const activePartialCheck = activeVerificationRuns.some(
      (run) => run.candidateKind === "partial",
    );
    activeProblems.push({
      id: slot.problemKey,
      attemptId: attempt?.attemptId ?? slot.attemptId,
      title: entry?.packet?.title ?? problem?.packet?.title ?? slot.problemKey,
      domain: entry?.packet?.domain ?? problem?.packet?.domain ?? "unknown",
      status:
        slot.status === "paused"
          ? "paused"
          : problem?.status ?? attempt?.status ?? slot.status,
      stage:
        slot.status === "paused"
          ? "paused at checkpoint"
          : activeSolutionCheck
            ? "checking a proposed solution"
            : activePartialCheck
              ? "checking a partial result"
              : activeVerificationRuns.length
                ? "checking an unclassified research claim"
            : attempt?.stage === "probe"
              ? "probing solution potential"
              : attempt?.stage === "semifinal"
                ? "testing a promising lead"
              : attempt?.stage === "deep"
                ? "deep solving"
            : (problem?.branches?.length ?? 0) > 0
              ? "researching approaches"
              : "planning approaches",
      round: problem?.round ?? 0,
      activeWorkMs: problem?.activeWorkMs ?? 0,
      callsStarted: child?.budget?.callsStarted ?? 0,
      pauseReason: attempt?.pauseReason ?? null,
      switchRequestedAt: attempt?.switchRequestedAt ?? null,
      coordinatorNote,
      statement: entry?.packet?.statement ?? problem?.packet?.statement ?? "",
      sourceUrls:
        entry?.packet?.sourceUrls ?? problem?.packet?.sourceUrls ?? [],
      workerSlot: `Worker slot ${slot.slotId}`,
      runDir: attempt?.runDir ?? slot.runDir,
      branches: (problem?.branches ?? []).map((branch) => {
        const latest = branch.history?.at(-1);
        return {
          id: branch.id,
          title: branch.strategy?.title ?? branch.id,
          hypothesis: branch.strategy?.hypothesis ?? "",
          falsifier: branch.strategy?.falsifier ?? "",
          status: branch.status,
          turn: branch.turns ?? 0,
          round: branch.lastCompletedRound ?? problem?.round ?? 0,
          latestSummary: latest?.summary ?? branch.feedback ?? "",
          progressKind: latest?.progressKind ?? "",
          nextAction: latest?.nextAction ?? "",
          feedback: branch.feedback ?? "",
          verifiedFactsCount: branch.verifiedFacts?.length ?? 0,
          failedApproachesCount: branch.failedApproaches?.length ?? 0,
          noProgressEpochs: branch.noProgressEpochs ?? 0,
          history: (branch.history ?? []).slice(-5).map((delta) => ({
            summary: delta.summary,
            progressKind: delta.progressKind,
            nextAction: delta.nextAction,
          })),
        };
      }),
      verification: verificationRuns,
      verificationRuns,
      previousAttempts,
    });
    for (const branch of problem?.branches ?? []) {
      for (const delta of (branch.history ?? []).slice(-5)) {
        childEvents.push({
          id: `${slot.problemKey}-${branch.id}-${delta.turn ?? delta.at}`,
          at: delta.at ?? child?.updatedAt ?? campaign.updatedAt,
          level:
            delta.progressKind === "none" ? "diagnostic" : "success",
          kind: "branch-epoch",
          title: `${branch.strategy?.title ?? branch.id}: ${delta.progressKind ?? "update"}`,
          note: delta.summary ?? delta.nextActionReason ?? "Branch checkpoint saved.",
          problemId: slot.problemKey,
          branchId: branch.id,
        });
      }
    }
    for (const synthesis of (problem?.syntheses ?? []).slice(-3)) {
      childEvents.push({
        id: `${slot.problemKey}-synthesis-${synthesis.round}`,
        at: child?.updatedAt ?? campaign.updatedAt,
        level: synthesis.informationGain ? "success" : "diagnostic",
        kind: "portfolio-synthesis",
        title: `Coordinator round ${synthesis.round}`,
        note: synthesis.portfolioSummary,
        problemId: slot.problemKey,
      });
    }
    for (const operation of Object.values(child?.operations ?? {})) {
      if (operation.status !== "waiting-input") continue;
      let prompt;
      if (operation.packetDir) {
        prompt = await readFile(
          path.join(operation.packetDir, "prompt.md"),
          "utf8",
        ).catch(() => undefined);
      }
      manualQueue.push({
        packetId: operation.packetId ?? operation.sessionId,
        role: operation.role,
        prompt,
        waitingSince: operation.waitingSince,
        packetDir: operation.packetDir ?? null,
        problemId: slot.problemKey,
      });
    }
  }
  for (const entry of entries) {
    const latestAttempt = entry.attempts?.at(-1);
    if (!latestAttempt || slotByKey.has(entry.problemKey)) continue;
    const child = await readChildState(latestAttempt.runDir);
    completedProblems.push(
      projectCompletedProblem(entry, latestAttempt, child),
    );
  }
  completedProblems.sort(
    (left, right) =>
      Number(right.status?.startsWith("candidate-complete")) -
        Number(left.status?.startsWith("candidate-complete")) ||
      String(right.completedAt).localeCompare(String(left.completedAt)),
  );
  const discoveryActivity = {
    active: false,
    cycle: null,
    callsRunning: 0,
    callsCompleted: 0,
    callsFailed: 0,
    phase: null,
  };
  for (const record of Object.values(campaign.discoveryRuns ?? {})) {
    if (
      !["starting", "running", "awaiting-manual"].includes(record.status)
    ) {
      continue;
    }
    const child = await readChildState(record.runDir);
    discoveryActivity.active = true;
    discoveryActivity.cycle = record.cycle;
    discoveryActivity.phase = child?.status ?? record.status;
    const discoveryOperations = Object.values(child?.operations ?? {});
    discoveryActivity.callsRunning += discoveryOperations.filter((operation) =>
      ["started", "waiting-input"].includes(operation.status),
    ).length;
    discoveryActivity.callsCompleted += discoveryOperations.filter(
      (operation) => operation.status === "completed",
    ).length;
    discoveryActivity.callsFailed += discoveryOperations.filter(
      (operation) => operation.status === "failed",
    ).length;
    for (const operation of Object.values(child?.operations ?? {})) {
      if (operation.status !== "waiting-input") continue;
      let prompt;
      if (operation.packetDir) {
        prompt = await readFile(
          path.join(operation.packetDir, "prompt.md"),
          "utf8",
        ).catch(() => undefined);
      }
      manualQueue.push({
        packetId: operation.packetId ?? operation.sessionId,
        role: operation.role,
        prompt,
        waitingSince: operation.waitingSince,
        packetDir: operation.packetDir ?? null,
        problemId: `discovery-cycle-${record.cycle}`,
      });
    }
  }
  const latestNote = campaign.notes?.at(-1);
  const eventNotes = (campaign.notes ?? []).map((note, index) => ({
    id: `${note.at}-${index}`,
    at: note.at,
    level: dashboardEventLevel(note.level),
    kind: note.level ?? "info",
    title: dashboardEventTitle(note.level),
    note: note.message,
    problemId: note.problemKey,
    branchId: note.branchId,
  }));
  const events = [...eventNotes, ...childEvents]
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
    .slice(-200);
  const candidateEntries = entries.filter(
    (entry) =>
      ["solved", "human-review", "candidate-review"].includes(
        entry.lifecycle,
      ),
  );
  const activeVerificationRuns = activeProblems.flatMap(
    (problem) => problem.verification ?? [],
  );
  const activeSolutionCandidates = activeVerificationRuns.filter((run) =>
    ["proof", "disproof"].includes(run.candidateKind),
  );
  const partialResults = activeVerificationRuns.filter(
    (run) => run.candidateKind === "partial",
  );
  const unclassifiedClaims = activeVerificationRuns.filter(
    (run) => !["proof", "disproof", "partial"].includes(run.candidateKind),
  );
  const rejectedClaims = activeVerificationRuns.filter((run) =>
    /reject|fail|refut/i.test(run.status),
  );
  const reproduced = entries.filter((entry) =>
    entry.attempts?.some(
      (attempt) =>
        attempt.problemStatus === "candidate-complete-agent-reproduced",
    ),
  );
  const timeLeftMs =
    Number.isFinite(campaign.pausedRemainingMs) &&
    campaign.pausedRemainingMs >= 0
      ? campaign.pausedRemainingMs
      : Math.max(0, Date.parse(campaign.deadlineAt) - Date.now());
  const snapshot = {
    schemaVersion: 1,
    generatedAt: nowIso(),
    campaignDir: path.resolve(campaignDir),
    campaign: {
      id: campaign.campaignId,
      provider: campaign.provider,
      status: campaign.status,
      phase: campaignPhase(campaign, activeProblems),
      startedAt: campaign.startedAt,
      updatedAt: campaign.updatedAt,
      deadlineAt: campaign.deadlineAt,
      timeLeftMs,
      pausedAt: campaign.pausedAt ?? null,
      stopRequestedAt:
        campaign.status === "stopping" || campaign.status === "stopped"
          ? latestNote?.at ?? null
          : null,
      latestNote: latestNote?.message ?? campaign.stopReason ?? "",
      stopReason: campaign.stopReason,
      cycle: campaign.cycle,
      tournament: campaign.tournament
        ? {
            enabled: campaign.tournament.enabled === true,
            stage: campaign.tournament.stage,
            round: campaign.tournament.round,
            probeTarget:
              campaign.policy?.probeProblemCount ?? null,
            probesCompleted:
              campaign.tournament.roundProbedProblemKeys?.length ?? 0,
            semifinalTarget:
              campaign.tournament.stage === "semifinal"
                ? campaign.tournament.promotedProblemKeys?.length ?? 0
                : campaign.policy?.semifinalProblemCount ?? null,
            semifinalsCompleted:
              campaign.tournament.roundSemifinalProblemKeys?.length ?? 0,
            deepTarget:
              campaign.tournament.stage === "deep"
                ? campaign.tournament.promotedProblemKeys?.length ?? 0
                : campaign.policy?.deepProblemCount ?? null,
            deepCompleted:
              campaign.tournament.roundDeepProblemKeys?.length ?? 0,
            finalists:
              campaign.tournament.promotedProblemKeys?.length ?? 0,
            latestEvaluation:
              campaign.tournament.evaluations?.at(-1) ?? null,
          }
        : null,
      continuous: campaign.policy?.continuous === true,
      parallelProblems:
        campaign.policy?.parallelProblems ??
        campaign.configSnapshot?.parallelProblems ??
        1,
      maxConcurrentCalls:
        campaign.policy?.maxConcurrentCalls ??
        campaign.configSnapshot?.maxConcurrentCalls ??
        1,
      discovery: discoveryActivity,
      problemSlots: {
        configured:
          campaign.policy?.parallelProblems ??
          campaign.configSnapshot?.parallelProblems ??
          campaign.slots.length,
        occupied: campaign.slots.filter((slot) => slot.status !== "idle").length,
        running: campaign.slots.filter((slot) =>
          ["starting", "running"].includes(slot.status),
        ).length,
        paused: campaign.slots.filter((slot) => slot.status === "paused").length,
        awaitingManual: campaign.slots.filter(
          (slot) => slot.status === "awaiting-manual",
        ).length,
        idle: campaign.slots.filter((slot) => slot.status === "idle").length,
      },
      budget: {
        ...campaign.budget,
        callBudgetBatch:
          campaign.policy?.callBudgetBatch ??
          campaign.policy?.maxCalls ??
          campaign.configSnapshot?.maxCalls ??
          0,
        maxCalls:
          campaign.policy?.maxCalls ??
          campaign.configSnapshot?.maxCalls ??
          0,
        maxEstimatedUsd:
          campaign.policy?.maxEstimatedUsd ??
          campaign.configSnapshot?.maxEstimatedUsd ??
          0,
      },
    },
    counts: {
      catalog: entries.length,
      queued: entries.filter((entry) =>
        isCampaignCandidateEligible(entry),
      ).length,
      active: campaign.slots.filter((slot) =>
        ["starting", "running"].includes(slot.status),
      ).length,
      paused: campaign.slots.filter((slot) => slot.status === "paused").length,
      cooldown: entries.filter(
        (entry) => !slotByKey.has(entry.problemKey) && entry.lifecycle === "cooldown",
      ).length,
      finished: entries.filter((entry) =>
        ["retired", "quarantined"].includes(entry.lifecycle),
      ).length,
      candidates: candidateEntries.length + activeSolutionCandidates.length,
      partialResults: partialResults.length,
      unclassifiedClaims: unclassifiedClaims.length,
      rejectedClaims: rejectedClaims.length,
      reproduced: reproduced.length,
    },
    catalog: catalogItems,
    activeProblems,
    completedProblems,
    events,
    notes: events,
    manualQueue,
    operatorCommands: operatorCommands.slice(-30).map((command) => ({
      id: command.id,
      type: command.type,
      status: command.status,
      createdAt: command.createdAt,
      updatedAt: command.updatedAt,
      problemKey: command.problemKey ?? null,
      query: command.query ?? null,
      error: command.error ?? null,
      result: command.result ?? null,
    })),
  };
  await writeJsonAtomic(
    path.join(path.resolve(campaignDir), "snapshot.json"),
    snapshot,
  );
  return snapshot;
}

export function catalogProblemKey(problem) {
  const packet = problem.packet ?? problem;
  const statement = String(packet.statement ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  const assumptions = [...(packet.assumptions ?? [])]
    .map((entry) =>
      String(entry).normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase(),
    )
    .sort();
  return sha256(JSON.stringify({ statement, assumptions }));
}

export function packetWithPriorResearch(entry) {
  const priorResearch = (entry.attempts ?? []).slice(-4).map((attempt) => ({
    outcome: attempt.outcome,
    completedAt: attempt.completedAt,
    report: attempt.note,
    evidenceCount: attempt.evidenceCount ?? 0,
    strategyCoverage: attempt.strategyCoverage ?? [],
    instruction:
      "Treat this as untrusted saved research: verify before reuse and do not repeat a refuted path without a new representation or test.",
  }));
  const stageResearch = (entry.probes ?? []).slice(-6).map((probe) => ({
    outcome: `${probe.stage ?? "probe"}-checkpoint`,
    completedAt: probe.completedAt,
    report: probe.note,
    evidenceCount: probe.evidenceCount ?? 0,
    decisiveProgress: probe.decisiveProgress ?? "none",
    decisiveScore: probe.score ?? 0,
    strategyCoverage: probe.strategyCoverage ?? [],
    instruction:
      "This was a bounded tournament checkpoint. Reuse verified artifacts, but change representation when the decisive score was low and never treat the checkpoint as a solution.",
  }));
  return {
    ...entry.packet,
    priorResearch: [
      ...(entry.packet.priorResearch ?? []),
      ...priorResearch,
      ...stageResearch,
    ],
  };
}

export function deduplicateCatalogCandidates(entries) {
  const selected = new Map();
  for (const input of entries ?? []) {
    const entry = structuredClone(input);
    const key =
      entry.problemKey ||
      catalogProblemKey(entry);
    entry.problemKey ??= key;
    const current = selected.get(key);
    if (!current || catalogCandidateQuality(entry) > catalogCandidateQuality(current)) {
      selected.set(key, entry);
    }
  }
  return [...selected.values()];
}

export const deduplicateCampaignCandidates = deduplicateCatalogCandidates;

export function childResumeExtensionHours({
  childState,
  resumeFromCampaignBoundary = false,
  windowHours,
  now = Date.now(),
}) {
  const deadlineMs = Date.parse(childState?.deadlineAt ?? "");
  const deadlineExpired =
    childState?.status === "deadline-reached" ||
    (Number.isFinite(deadlineMs) && now >= deadlineMs);
  if (!resumeFromCampaignBoundary && !deadlineExpired) return 0;

  const availableWindowHours = Math.max(0, Number(windowHours) || 0);
  if (!availableWindowHours) return 0;
  const baseDeadlineMs = Number.isFinite(deadlineMs)
    ? Math.max(now, deadlineMs)
    : now;
  const targetDeadlineMs = now + availableWindowHours * HOUR_MS;
  return Math.max(
    0,
    (targetDeadlineMs - baseDeadlineMs) / HOUR_MS,
  );
}

export function isCampaignCandidateEligible(entry, { now = new Date() } = {}) {
  const instant = now instanceof Date ? now : new Date(now);
  const lifecycle = entry.lifecycle ?? entry.status ?? "eligible";
  if (!["eligible", "cooldown"].includes(lifecycle)) return false;
  if (
    entry.cooldownUntil &&
    Date.parse(entry.cooldownUntil) > instant.getTime()
  ) {
    return false;
  }
  if (
    entry.lease?.expiresAt &&
    Date.parse(entry.lease.expiresAt) > instant.getTime()
  ) {
    return false;
  }
  if (
    entry.vet?.expiresAt &&
    Date.parse(entry.vet.expiresAt) <= instant.getTime()
  ) {
    return false;
  }
  const attempts = (entry.attempts ?? []).filter(
    (attempt) => attempt.outcome !== "failed",
  ).length;
  if (entry.maxAttempts && attempts >= entry.maxAttempts) return false;
  return true;
}

export function scoreCatalogEntry(entry) {
  const packet = entry.packet ?? entry;
  const attempts = entry.attempts ?? [];
  const probes = entry.probes ?? [];
  const completedAttempts = attempts.filter(
    (attempt) => attempt.outcome !== "failed",
  );
  const progressValues = completedAttempts.map((attempt) => {
    if (attempt.hasCandidate) return 1;
    if (attempt.hasVerifiedPartial) return 0.75;
    if ((attempt.evidenceCount ?? 0) > 0) return 0.45;
    return 0.05;
  });
  const completedProgress = progressValues.length
    ? progressValues.reduce((sum, value) => sum + value, 0) /
      progressValues.length
    : 0.5;
  const latestProbeProgress = probes.length
    ? clamp(Number(probes.at(-1)?.score ?? 0) / 100, 0, 1)
    : null;
  const empiricalProgress =
    latestProbeProgress === null
      ? completedProgress
      : 0.35 * completedProgress + 0.65 * latestProbeProgress;
  const noResultAttempts = attempts.filter(
    (attempt) => !attempt.hasCandidate && attempt.outcome !== "failed",
  ).length;
  const interest = clamp(Number(packet.interest ?? 3) / 5, 0.01, 1);
  const tractability = clamp(
    Number(packet.tractability ?? entry.tractability ?? 3) / 5,
    0.01,
    1,
  );
  const verifiability = clamp(
    Number(packet.verifiability ?? entry.verifiability ?? 3) / 5,
    0.01,
    1,
  );
  const sourceQuality = clamp(
    Number(packet.sourceQuality ?? entry.sourceQuality ?? 3) / 5,
    0.01,
    1,
  );
  const artifactReadiness = clamp(
    Number(packet.artifactReadiness ?? 3) / 5,
    0.01,
    1,
  );
  const blockingPenalty = Math.min(
    0.3,
    (packet.blockingDependencies?.length ?? 0) * 0.1,
  );
  const falsification = counterexampleOpportunity(packet);
  const solvability = clamp(
    0.45 * tractability +
      0.2 * verifiability +
      0.2 * artifactReadiness +
      0.15 * empiricalProgress -
      0.12 * noResultAttempts -
      blockingPenalty,
    0.02,
    0.95,
  );
  const explorationBonus = attempts.length
    ? Math.min(0.04, 0.04 / Math.sqrt(attempts.length + 1))
    : 0.06;
  const counterexampleBonus = Number(
    (0.08 * falsification.opportunity).toFixed(6),
  );
  const priority = Number(
    (
      Math.sqrt(interest * solvability) *
        (0.8 + 0.2 * sourceQuality) +
      explorationBonus +
      counterexampleBonus
    ).toFixed(6),
  );
  return {
    scoreVersion: 2,
    interest,
    tractability,
    verifiability,
    sourceQuality,
    artifactReadiness,
    blockingPenalty,
    empiricalProgress: Number(empiricalProgress.toFixed(4)),
    noResultAttempts,
    solvability: Number(solvability.toFixed(4)),
    explorationBonus,
    falsificationType: falsification.type,
    counterexampleSearchability: falsification.searchability,
    counterexampleSignalSource: falsification.source,
    counterexampleOpportunity: falsification.opportunity,
    counterexampleBonus,
    priority,
    rationale:
      `interest ${Math.round(interest * 100)}%, predicted solvability ` +
      `${Math.round(solvability * 100)}%, ${attempts.length} prior attempt` +
      `${attempts.length === 1 ? "" : "s"}` +
      (counterexampleBonus > 0
        ? `, checkable counterexample opportunity +${Number(
            (counterexampleBonus * 100).toFixed(1),
          )} priority`
        : ""),
  };
}

export function rankCatalogEntries(entries, options = {}) {
  return deduplicateCatalogCandidates(entries)
    .filter((entry) => isCampaignCandidateEligible(entry, options))
    .map((entry) => ({
      ...entry,
      ranking: scoreCatalogEntry(entry),
    }))
    .sort(
      (left, right) =>
        Number(Boolean(right.operatorPriority)) -
          Number(Boolean(left.operatorPriority)) ||
        String(right.operatorPriority?.requestedAt ?? "").localeCompare(
          String(left.operatorPriority?.requestedAt ?? ""),
        ) ||
        right.ranking.priority - left.ranking.priority ||
        right.packet.interest - left.packet.interest ||
        left.problemKey.localeCompare(right.problemKey),
    );
}

export const rankCampaignCandidates = rankCatalogEntries;

function resolveCampaignPolicy(config, override) {
  const configured = config.campaign ?? {};
  const configuredTournament = configured.tournament ?? {};
  const parallelProblems = positiveInteger(
    override.parallelProblems ?? config.parallelProblems,
    "parallelProblems",
  );
  const maxCalls = positiveInteger(
    override.maxCalls ?? config.maxCalls,
    "maxCalls",
  );
  const policy = {
    durationHours: positiveNumber(
      override.durationHours ?? config.wallClockHours,
      "durationHours",
    ),
    problemHours: positiveNumber(
      override.problemHours ?? Math.min(12, config.wallClockHours),
      "problemHours",
    ),
    parallelProblems,
    maxConcurrentCalls: positiveInteger(
      override.maxConcurrentCalls ?? config.maxConcurrentCalls,
      "maxConcurrentCalls",
    ),
    maxCalls,
    callBudgetBatch: positiveInteger(
      override.callBudgetBatch ?? maxCalls,
      "callBudgetBatch",
    ),
    continuous: override.continuous === true,
    maxEstimatedUsd: nonNegativeNumber(
      override.maxEstimatedUsd ?? config.maxEstimatedUsd,
      "maxEstimatedUsd",
    ),
    catalogLowWatermark: positiveInteger(
      override.catalogLowWatermark ?? Math.max(4, parallelProblems * 2),
      "catalogLowWatermark",
    ),
    discoveryBatchSize: positiveInteger(
      override.discoveryBatchSize ??
        Math.max(config.discovery.attackCount, parallelProblems * 2),
      "discoveryBatchSize",
    ),
    discoveryRefreshMs: nonNegativeNumber(
      override.discoveryRefreshMs ?? 6 * HOUR_MS,
      "discoveryRefreshMs",
    ),
    maxCycles: nonNegativeInteger(
      override.maxCycles ?? configured.maxCycles ?? 0,
      "maxCycles",
    ),
    refreshEveryCycles: positiveInteger(
      override.refreshEveryCycles ??
        configured.refreshEveryCycles ??
        1,
      "refreshEveryCycles",
    ),
    emptyDiscoveryBackoffMs: nonNegativeNumber(
      override.emptyDiscoveryBackoffMs ??
        (configured.refreshBackoffMinutes ?? 0.5) * 60_000,
      "emptyDiscoveryBackoffMs",
    ),
    maxEmptyDiscoveryCycles: positiveInteger(
      override.maxEmptyDiscoveryCycles ?? 3,
      "maxEmptyDiscoveryCycles",
    ),
    reverifyMs: positiveNumber(
      override.reverifyMs ??
        (configured.catalogTtlHours ?? 168) * HOUR_MS,
      "reverifyMs",
    ),
    cooldownMs: nonNegativeNumber(
      override.cooldownMs ??
        (configured.retryCooldownHours ?? 24) * HOUR_MS,
      "cooldownMs",
    ),
    failureCooldownMs: nonNegativeNumber(
      override.failureCooldownMs ?? HOUR_MS,
      "failureCooldownMs",
    ),
    operatorSwitchCooldownMs: nonNegativeNumber(
      override.operatorSwitchCooldownMs ??
        (configured.switchCooldownMinutes ?? 60) * 60_000,
      "operatorSwitchCooldownMs",
    ),
    maxAttemptsPerProblem: positiveInteger(
      override.maxAttemptsPerProblem ??
        configured.maxAttemptsPerProblem ??
        2,
      "maxAttemptsPerProblem",
    ),
    maxAttemptFailures: positiveInteger(
      override.maxAttemptFailures ?? 3,
      "maxAttemptFailures",
    ),
    leaseTtlMs: positiveNumber(
      override.leaseTtlMs ??
        (configured.leaseMinutes ?? 180) * 60_000,
      "leaseTtlMs",
    ),
    leaseHeartbeatMs: positiveNumber(
      override.leaseHeartbeatMs ?? 30_000,
      "leaseHeartbeatMs",
    ),
    idlePollMs: positiveNumber(
      override.idlePollMs ?? 1_000,
      "idlePollMs",
    ),
    maxSnapshotNotes: positiveInteger(
      override.maxSnapshotNotes ?? 200,
      "maxSnapshotNotes",
    ),
    stopOnCandidate:
      override.stopOnCandidate ??
      configured.stopOnCandidate ??
      false,
    tournamentEnabled:
      override.tournamentEnabled ??
      configuredTournament.enabled ??
      false,
    probeProblemCount: positiveInteger(
      override.probeProblemCount ??
        configuredTournament.probeProblemCount ??
        Math.max(8, parallelProblems * 2),
      "probeProblemCount",
    ),
    probeHours: positiveNumber(
      override.probeHours ??
        configuredTournament.probeHours ??
        0.5,
      "probeHours",
    ),
    probeSolverTurns: positiveInteger(
      override.probeSolverTurns ??
        configuredTournament.probeSolverTurns ??
        1,
      "probeSolverTurns",
    ),
    minimumPromotableProbes: positiveInteger(
      override.minimumPromotableProbes ??
        configuredTournament.minimumPromotableProbes ??
        Math.min(4, Math.max(1, parallelProblems)),
      "minimumPromotableProbes",
    ),
    semifinalProblemCount: positiveInteger(
      override.semifinalProblemCount ??
        Math.min(
          configuredTournament.semifinalProblemCount ??
            Math.min(6, Math.max(2, parallelProblems)),
          override.probeProblemCount ??
            configuredTournament.probeProblemCount ??
            Math.max(8, parallelProblems * 2),
        ),
      "semifinalProblemCount",
    ),
    semifinalSolverTurns: positiveInteger(
      override.semifinalSolverTurns ??
        configuredTournament.semifinalSolverTurns ??
        2,
      "semifinalSolverTurns",
    ),
    deepProblemCount: positiveInteger(
      override.deepProblemCount ??
        Math.min(
          configuredTournament.deepProblemCount ??
            Math.min(2, parallelProblems),
          override.semifinalProblemCount ??
            configuredTournament.semifinalProblemCount ??
            Math.min(6, Math.max(2, parallelProblems)),
          override.probeProblemCount ??
            configuredTournament.probeProblemCount ??
            Math.max(8, parallelProblems * 2),
        ),
      "deepProblemCount",
    ),
    deepSolverTurns: positiveInteger(
      override.deepSolverTurns ??
        configuredTournament.deepSolverTurns ??
        4,
      "deepSolverTurns",
    ),
    probePromotionScore: boundedNumber(
      override.probePromotionScore ??
        configuredTournament.probePromotionScore ??
        30,
      0,
      100,
      "probePromotionScore",
    ),
    deepPromotionScore: boundedNumber(
      override.deepPromotionScore ??
        configuredTournament.deepPromotionScore ??
        50,
      0,
      100,
      "deepPromotionScore",
    ),
    retryAfterRounds: positiveInteger(
      override.retryAfterRounds ??
        configuredTournament.retryAfterRounds ??
        2,
      "retryAfterRounds",
    ),
    maxStageRetries: nonNegativeInteger(
      override.maxStageRetries ??
        configuredTournament.maxStageRetries ??
        2,
      "maxStageRetries",
    ),
    stageHardHours: positiveNumber(
      override.stageHardHours ??
        configuredTournament.stageHardHours ??
        8,
      "stageHardHours",
    ),
  };
  if (policy.minimumPromotableProbes > policy.probeProblemCount) {
    throw new Error(
      "minimumPromotableProbes cannot exceed probeProblemCount",
    );
  }
  if (policy.semifinalProblemCount > policy.probeProblemCount) {
    throw new Error("semifinalProblemCount cannot exceed probeProblemCount");
  }
  if (policy.deepProblemCount > policy.semifinalProblemCount) {
    throw new Error("deepProblemCount cannot exceed semifinalProblemCount");
  }
  if (
    policy.semifinalSolverTurns < policy.probeSolverTurns ||
    policy.deepSolverTurns < policy.semifinalSolverTurns
  ) {
    throw new Error(
      "tournament solver-turn targets must increase by stage",
    );
  }
  return policy;
}

function makeCatalogEntry(
  packet,
  {
    problemKey,
    source,
    vetted,
    now,
    reverifyMs,
    maxAttempts,
  },
) {
  return {
    problemKey,
    packetVersion: 1,
    packet: structuredClone(packet),
    packetVersions: [
      {
        version: 1,
        packet: structuredClone(packet),
        observedAt: now,
        source,
      },
    ],
    lifecycle: "eligible",
    discoveredAt: now,
    lastSeenAt: now,
    lastAttemptAt: null,
    sources: [source],
    vet: {
      verified: vetted,
      verifiedAt: vetted ? now : null,
      expiresAt: vetted
        ? new Date(Date.parse(now) + reverifyMs).toISOString()
        : now,
    },
    attempts: [],
    probes: [],
    maxAttempts,
    cooldownUntil: null,
    lease: null,
    failureCount: 0,
    latestNote: "Vetted and ready for selection",
    ranking: null,
  };
}

export function summarizeChildAttempt(attempt, childState) {
  const problem = childState.problems?.[0];
  const solverTurns = (problem?.branches ?? []).reduce(
    (sum, branch) => sum + (branch.history?.length ?? 0),
    0,
  );
  const evidenceCount =
    (problem?.evidenceKeys?.length ?? 0) +
    (problem?.branches ?? []).reduce(
      (sum, branch) => sum + (branch.evidenceKeys?.length ?? 0),
      0,
    );
  const hasCandidate = Boolean(problem?.bestCandidate) ||
    String(problem?.status ?? "").startsWith("candidate-complete");
  const candidateKind =
    problem?.bestCandidate?.candidate?.kind ??
    problem?.bestCandidate?.kind ??
    null;
  const hasVerifiedPartial = (problem?.verificationRuns ?? []).some(
    (run) => run.status === "verified-partial-lead",
  );
  const problemStatus = String(problem?.status ?? "");
  const solved =
    problemStatus === "candidate-complete-agent-reproduced";
  const needsHumanReview = hasCandidate && !solved;
  const latestSynthesis = problem?.syntheses?.at(-1);
  const latestBranch = (problem?.branches ?? [])
    .flatMap((branch) =>
      (branch.history ?? []).map((history) => ({
        ...history,
        branchId: branch.id,
      })),
    )
    .sort((left, right) => String(right.at).localeCompare(String(left.at)))[0];
  const outcome = solved
    ? "solved"
    : needsHumanReview
      ? "human-review"
    : childState.status?.includes("error") || problem?.status === "failed"
      ? "failed"
      : "not-solved";
  const title = problem?.packet?.title ?? attempt.problemKey;
  const detail =
    latestSynthesis?.portfolioSummary ||
    latestBranch?.summary ||
    problem?.stopReason ||
    childState.stopReason ||
    "The attempt ended without a detailed coordinator note.";
  return {
    attemptId: attempt.attemptId,
    runDir: attempt.runDir,
    problemKey: attempt.problemKey,
    startedAt: attempt.startedAt,
    completedAt: nowIso(),
    outcome,
    hasCandidate,
    candidateKind,
    hasVerifiedPartial,
    evidenceCount,
    rounds: problem?.round ?? 0,
    solverTurns,
    callsStarted: childState.budget?.callsStarted ?? 0,
    activeWorkMs: problem?.activeWorkMs ?? 0,
    strategyCoverage: strategyCoverageReceipt(problem),
    childStatus: childState.status,
    problemStatus: problem?.status ?? null,
    note: solved
      ? `Solved “${title}”: the proof or counterexample passed the configured independent checks. ${detail}`
      : needsHumanReview
        ? `Human review recommended for “${title}”: a complete proof or counterexample passed the agent checks, but the automated system could not make a decisive final validation. ${detail}`
        : outcome === "failed"
          ? `Run error for “${title}”: no mathematical outcome was produced. ${detail}`
          : `Not solved: “${title}”. ${detail}`,
  };
}

export function scoreProbeAttempt({ summary, childState }) {
  const problem = childState?.problems?.[0];
  const allDeltas = (problem?.branches ?? [])
    .flatMap((branch) => branch.history ?? [])
    .sort((left, right) => String(left.at ?? "").localeCompare(String(right.at ?? "")));
  const stageTurnCount = Number(
    summary?.stageSolverTurns ?? summary?.solverTurns ?? allDeltas.length,
  );
  const deltas =
    stageTurnCount > 0 ? allDeltas.slice(-stageTurnCount) : [];
  const checkableArtifacts = deltas
    .flatMap((delta) => delta.artifacts ?? [])
    .filter(
      (artifact) =>
        ["proof", "counterexample", "code", "data"].includes(
          artifact.kind,
        ) &&
        String(artifact.verification ?? "").trim(),
    ).length;
  const verifiedFacts = (problem?.branches ?? []).reduce(
    (count, branch) => count + (branch.verifiedFacts?.length ?? 0),
    0,
  );
  const productiveDeltas = deltas.filter(
    (delta) =>
      ["verified-fact", "refuted-path", "search-pruning", "candidate"].includes(
        delta.progressKind,
      ),
  ).length;
  const noProgressDeltas = deltas.filter(
    (delta) => delta.progressKind === "none",
  ).length;
  const concreteNextActions = deltas.filter(
    (delta) =>
      ["deepen", "branch", "verify"].includes(delta.nextAction) &&
      String(delta.nextActionReason ?? "").trim(),
  ).length;
  const packet = problem?.packet ?? {};
  const artifactReadiness = clamp(
    Number(packet.artifactReadiness ?? 3),
    1,
    5,
  );
  const interest = clamp(Number(packet.interest ?? 3), 1, 5);
  const blockerText = [
    summary?.note,
    problem?.stopReason,
    ...deltas.map((delta) => delta.summary),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const dependencyBlocked =
    /unavailable|cannot acquire|missing (?:dataset|incumbent|definition)|paywall|access blocked/.test(
      blockerText,
    );
  const decisiveProgress = strongestDecisiveProgress(deltas);
  const exactProblemStillOpen =
    /(?:exact|original|unrestricted|universal|asymptotic).{0,45}(?:remains|is still)\s+open|no (?:completeness|global|unbounded) (?:argument|certificate|proof)|only (?:bounded|finite|small) cases?/i.test(
      blockerText,
    );
  const solverTurns = Number(
    summary?.stageSolverTurns ?? summary?.solverTurns ?? deltas.length,
  );
  const failedRun =
    summary?.outcome === "failed" ||
    String(summary?.childStatus ?? "").includes("error") ||
    solverTurns <= 0;
  const decisivePoints = {
    none: 0,
    "bounded-check": 8,
    "proper-subcase": 20,
    "reusable-lemma": 42,
    "exact-reduction": 65,
    "complete-candidate": 90,
  }[decisiveProgress] ?? 0;
  const decisiveCap = {
    none: 15,
    "bounded-check": 25,
    "proper-subcase": 40,
    "reusable-lemma": 70,
    "exact-reduction": 90,
    "complete-candidate": 100,
  }[decisiveProgress] ?? 15;
  const breakdown = {
    checkableArtifacts,
    verifiedFacts,
    productiveDeltas,
    noProgressDeltas,
    concreteNextActions,
    artifactReadiness,
    interest,
    dependencyBlocked,
    exactProblemStillOpen,
    decisiveProgress,
    solverTurns,
    failedRun,
  };
  const rawScore =
    decisivePoints +
    4 * Math.min(checkableArtifacts, 3) +
    Math.min(verifiedFacts, 8) +
    2 * Math.min(productiveDeltas, 4) +
    Math.min(concreteNextActions, 2) +
    artifactReadiness +
    0.5 * interest -
    3 * noProgressDeltas -
    (dependencyBlocked ? 25 : 0) -
    (
      exactProblemStillOpen &&
      !["exact-reduction", "complete-candidate"].includes(decisiveProgress)
        ? 12
        : 0
    );
  const score = failedRun
    ? 0
    : clamp(rawScore, 0, decisiveCap);
  const promotable =
    !failedRun &&
    !dependencyBlocked &&
    score >= 30 &&
    ["proper-subcase", "reusable-lemma", "exact-reduction", "complete-candidate"]
      .includes(decisiveProgress);
  return {
    score: Number(score.toFixed(3)),
    breakdown,
    promotable,
    decisiveProgress,
  };
}

function strongestDecisiveProgress(deltas) {
  const order = [
    "none",
    "bounded-check",
    "proper-subcase",
    "reusable-lemma",
    "exact-reduction",
    "complete-candidate",
  ];
  return (deltas ?? []).reduce((best, delta) => {
    const candidate = order.includes(delta.decisiveProgress)
      ? delta.decisiveProgress
      : delta.progressKind === "candidate"
        ? "complete-candidate"
        : delta.progressKind === "search-pruning"
          ? "bounded-check"
          : delta.progressKind === "verified-fact"
            ? "proper-subcase"
            : "none";
    return order.indexOf(candidate) > order.indexOf(best)
      ? candidate
      : best;
  }, "none");
}

function recordCampaignUsage(
  budget,
  usage = {},
  providerName,
  config,
) {
  for (const key of [
    "inputTokens",
    "cachedInputTokens",
    "cacheWriteTokens",
    "outputTokens",
    "reasoningTokens",
  ]) {
    budget[key] += usage?.[key] ?? 0;
  }
  if (!isApiBilledProvider(providerName)) return;
  const pricing = config.pricingPerMillionTokens;
  const uncached = Math.max(
    0,
    (usage?.inputTokens ?? 0) -
      (usage?.cachedInputTokens ?? 0) -
      (usage?.cacheWriteTokens ?? 0),
  );
  const cost =
    (uncached * pricing.input +
      (usage?.cachedInputTokens ?? 0) * pricing.cachedInput +
      (usage?.cacheWriteTokens ?? 0) * pricing.cacheWrite +
      (usage?.outputTokens ?? 0) * pricing.output) /
    1_000_000;
  budget.estimatedUsd = Number((budget.estimatedUsd + cost).toFixed(6));
}

function emptyCampaignBudget() {
  return {
    callsStarted: 0,
    callsCompleted: 0,
    callsFailed: 0,
    callsWaiting: 0,
    inFlight: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    estimatedUsd: 0,
  };
}

function emptySlot(slotId) {
  return {
    slotId,
    status: "idle",
    problemKey: null,
    attemptId: null,
    runDir: null,
    startedAt: null,
    latestNote: "",
  };
}

function tournamentCompletionField(stage) {
  if (stage === "probe" || stage === "probing") {
    return "roundProbedProblemKeys";
  }
  if (stage === "semifinal") return "roundSemifinalProblemKeys";
  if (stage === "deep") return "roundDeepProblemKeys";
  throw new Error(`Unknown tournament stage: ${stage}`);
}

function tournamentStageLabel(stage) {
  if (stage === "probe" || stage === "probing") return "Probe";
  if (stage === "semifinal") return "Follow-up";
  if (stage === "deep") return "Deep run";
  return String(stage || "Research");
}

function createTournamentState(policy, startedAt = nowIso()) {
  return {
    enabled: policy.tournamentEnabled === true,
    stage: policy.tournamentEnabled ? "probing" : "disabled",
    round: 1,
    roundStartedAt: startedAt,
    roundProbedProblemKeys: [],
    allProbedProblemKeys: [],
    roundSemifinalProblemKeys: [],
    roundDeepProblemKeys: [],
    lastProbedRoundByProblem: {},
    promotedProblemKeys: [],
    promotedAt: null,
    stageStartedAt: startedAt,
    stageStartedCalls: 0,
    rounds: [],
    evaluations: [],
  };
}

function migrateCampaignState(state, policy) {
  state.schemaVersion = 1;
  state.activeClock ??= {
    lastHeartbeatAt: state.updatedAt ?? nowIso(),
    suspendedMs: 0,
    lastSuspensionMs: 0,
  };
  state.selectionSeed ??= sha256(
    `${state.campaignId ?? "campaign"}:${state.startedAt ?? "legacy"}`,
  );
  state.selectionEpoch ??= 0;
  state.budget = { ...emptyCampaignBudget(), ...(state.budget ?? {}) };
  state.budget.inFlight = 0;
  state.notes ??= [];
  state.attempts ??= {};
  state.slots ??= [];
  while (state.slots.length < policy.parallelProblems) {
    state.slots.push(emptySlot(state.slots.length + 1));
  }
  state.cycle ??= 0;
  state.emptyDiscoveryCycles ??= 0;
  state.discoveryRuns ??= {};
  state.discoveryAwaitingManual ??= false;
  state.nextDiscoveryAt ??= nowIso();
  state.attemptsAtLastDiscovery ??= 0;
  state.stopRequestedByCandidate ??= false;
  state.stopReason ??= "";
  if (!state.tournament) {
    state.tournament = createTournamentState(
      policy,
      state.startedAt ?? nowIso(),
    );
    if (
      policy.tournamentEnabled &&
      Object.keys(state.attempts).length > 0
    ) {
      // Existing campaigns keep their pre-tournament scheduling semantics.
      // A fresh campaign opts into the new lifecycle without mutating saved
      // attempts from older releases.
      state.tournament.enabled = false;
      state.tournament.stage = "legacy";
    }
  }
  state.tournament.round ??= 1;
  state.tournament.roundStartedAt ??= state.startedAt ?? nowIso();
  state.tournament.roundProbedProblemKeys ??= [];
  state.tournament.allProbedProblemKeys ??= [];
  state.tournament.roundSemifinalProblemKeys ??= [];
  state.tournament.roundDeepProblemKeys ??= [];
  state.tournament.lastProbedRoundByProblem ??= Object.fromEntries(
    (state.tournament.allProbedProblemKeys ?? []).map((problemKey) => [
      problemKey,
      state.tournament.round ?? 1,
    ]),
  );
  state.tournament.promotedProblemKeys ??= [];
  state.tournament.promotedAt ??= null;
  state.tournament.stageStartedAt ??=
    state.tournament.roundStartedAt ?? state.startedAt ?? nowIso();
  state.tournament.stageStartedCalls ??= state.budget.callsStarted ?? 0;
  state.tournament.rounds ??= [];
  state.tournament.evaluations ??= [];
  if (state.tournament.stage === "legacy") {
    policy.tournamentEnabled = false;
    state.policy.tournamentEnabled = false;
  }
}

function isChildTerminal(status) {
  return Boolean(status && !ACTIVE_CHILD_STATUSES.has(status) && status !== "awaiting-manual");
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

async function readChildState(runDir) {
  try {
    return await readJson(path.join(runDir, "run.json"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function hasImportedManualResponse(childState) {
  const waiting = Object.values(childState?.operations ?? {}).filter(
    (operation) => operation.status === "waiting-input",
  );
  if (!waiting.length) return false;
  for (const operation of waiting) {
    if (!operation.packetDir) continue;
    try {
      const status = await readJson(
        path.join(operation.packetDir, "status.json"),
      );
      if (["response-imported", "completed"].includes(status.state)) return true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return false;
}

function projectCompletedProblem(entry, attempt, child) {
  const problem = child?.problems?.[0];
  const verificationRuns = (problem?.verificationRuns ?? []).map((run) => ({
    candidateHash: run.candidateHash,
    candidateClaim: run.candidate?.claim ?? "",
    candidateKind: run.candidate?.kind ?? null,
    status: run.status,
    passes: (run.passes ?? []).map((pass, index) => ({
      pass: index + 1,
      verdict: pass.verdict,
      note:
        pass.feedbackToResearcher ||
        pass.fatalIssues?.[0] ||
        pass.exactnessAssessment ||
        "",
    })),
  }));
  return {
    id: entry.problemKey,
    attemptId: attempt.attemptId,
    title: entry.packet?.title ?? problem?.packet?.title ?? entry.problemKey,
    domain: entry.packet?.domain ?? problem?.packet?.domain ?? "unknown",
    status: problem?.status ?? attempt.problemStatus ?? attempt.outcome,
    outcome: attempt.outcome,
    completedAt: attempt.completedAt,
    round: problem?.round ?? attempt.rounds ?? 0,
    activeWorkMs: problem?.activeWorkMs ?? attempt.activeWorkMs ?? 0,
    callsStarted: child?.budget?.callsStarted ?? attempt.callsStarted ?? 0,
    coordinatorNote:
      problem?.syntheses?.at(-1)?.portfolioSummary ||
      problem?.sharedState?.portfolioSummary ||
      attempt.note ||
      entry.latestNote ||
      "",
    statement: entry.packet?.statement ?? problem?.packet?.statement ?? "",
    sourceUrls: entry.packet?.sourceUrls ?? problem?.packet?.sourceUrls ?? [],
    runDir: attempt.runDir,
    branches: (problem?.branches ?? []).map((branch) => {
      const latest = branch.history?.at(-1);
      return {
        id: branch.id,
        title: branch.strategy?.title ?? branch.id,
        hypothesis: branch.strategy?.hypothesis ?? "",
        falsifier: branch.strategy?.falsifier ?? "",
        status: branch.status,
        turn: branch.turns ?? 0,
        round: branch.lastCompletedRound ?? problem?.round ?? 0,
        latestSummary: latest?.summary ?? branch.feedback ?? "",
        progressKind: latest?.progressKind ?? "",
        nextAction: latest?.nextAction ?? "",
        feedback: branch.feedback ?? "",
        verifiedFactsCount: branch.verifiedFacts?.length ?? 0,
        failedApproachesCount: branch.failedApproaches?.length ?? 0,
        noProgressEpochs: branch.noProgressEpochs ?? 0,
        history: (branch.history ?? []).slice(-5).map((delta) => ({
          summary: delta.summary,
          progressKind: delta.progressKind,
          nextAction: delta.nextAction,
        })),
      };
    }),
    verification: verificationRuns,
    verificationRuns,
  };
}

function campaignPhase(campaign, activeProblems) {
  if (campaign.status === "awaiting-manual") return "awaiting manual input";
  if (campaign.status !== "running") return campaign.status;
  if (activeProblems.some((problem) => problem.verification?.length)) {
    return "verifying";
  }
  if (
    campaign.tournament?.enabled &&
    campaign.tournament.stage === "probing"
  ) {
    return activeProblems.length ? "probing" : "scouting";
  }
  if (
    campaign.tournament?.enabled &&
    campaign.tournament.stage === "semifinal"
  ) {
    return "testing leads";
  }
  if (
    campaign.tournament?.enabled &&
    campaign.tournament.stage === "deep"
  ) {
    return "deep solving";
  }
  if (activeProblems.length) return "attacking";
  return "discovering";
}

function dashboardEventLevel(level) {
  if (["warning", "error", "diagnostic", "info", "success"].includes(level)) {
    return level;
  }
  if (["progress", "candidate", "result", "solved"].includes(level)) {
    return "success";
  }
  return "info";
}

function dashboardEventTitle(level) {
  if (level === "solved") return "Solved";
  if (level === "candidate") return "Candidate found";
  if (level === "progress") return "Progress";
  if (level === "warning" || level === "error") return "Needs attention";
  if (level === "action") return "Action required";
  if (level === "result") return "Campaign update";
  return "Research update";
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function catalogCandidateQuality(entry) {
  const packet = entry.packet ?? entry;
  return (
    Number(packet.sourceQuality ?? 0) * 10 +
    Number(packet.verifiability ?? 0) +
    (entry.vet?.verified ? 100 : 0)
  );
}

function packetFingerprint(packet) {
  const copy = structuredClone(packet ?? {});
  delete copy.statusAsOf;
  delete copy.vetting;
  return sha256(JSON.stringify(copy));
}

function normalizedCatalogTitle(value) {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function positiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function positiveNumber(value, name) {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be positive`);
  }
  return value;
}

function nonNegativeNumber(value, name) {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be non-negative`);
  }
  return value;
}

function boundedNumber(value, min, max, name) {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${name} must be between ${min} and ${max}`);
  }
  return value;
}

function nonNegativeInteger(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}
