import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CampaignController,
  buildCampaignSnapshot,
} from "../src/campaign.mjs";
import { loadConfig } from "../src/config.mjs";

function discoveredProblem() {
  return {
    id: "manual-discovery-problem",
    title: "Manual discovery problem",
    domain: "combinatorics",
    statement: "Every finite object in class C has property P.",
    assumptions: [],
    sourceUrls: ["https://oeis.org/A000045"],
    openStatusEvidence: ["The canonical source records this exact variant as open."],
    knownResults: [],
    verificationMode: "finite-witness",
    interest: 4,
    tractability: 4,
    verifiability: 5,
    sourceQuality: 5,
    falsificationType: "finite-counterexample",
    counterexampleSearchability: 5,
    counterexampleVerificationPlan:
      "Enumerate exact finite objects and independently check property P.",
    minimumDecisiveArtifact:
      "One explicit finite object with a reproducible exact property check.",
    artifactReadiness: 5,
    blockingDependencies: [],
    whyPromising: "A finite witness would settle the statement.",
    risks: [],
  };
}

class ManualDiscoveryFixtureProvider {
  constructor(packetDir) {
    this.packetDir = packetDir;
    this.scoutPending = true;
  }

  async run(request) {
    if (
      request.schema.name === "open_problem_discovery" &&
      this.scoutPending &&
      !request.resumeId
    ) {
      this.scoutPending = false;
      await mkdir(this.packetDir, { recursive: true });
      await writeFile(path.join(this.packetDir, "prompt.md"), request.prompt);
      await writeFile(
        path.join(this.packetDir, "status.json"),
        `${JSON.stringify({ state: "waiting-input" })}\n`,
      );
      await request.onStarted?.("manual-scout-packet");
      const error = new Error("Manual scout response is pending");
      error.code = "AUTOPROVER_MANUAL_RESPONSE_PENDING";
      error.resumable = true;
      error.packetId = "manual-scout-packet";
      error.packetDir = this.packetDir;
      throw error;
    }

    const sessionId =
      request.resumeId ?? `manual-fixture-${request.schema.name}`;
    await request.onStarted?.(sessionId);
    if (request.schema.name === "open_problem_discovery") {
      return {
        sessionId,
        usage: {},
        evidence: [],
        data: { problems: [discoveredProblem()] },
      };
    }
    if (request.schema.name === "problem_vetting") {
      const packet = discoveredProblem();
      return {
        sessionId,
        usage: {},
        evidence: [],
        data: {
          exactStatementVerified: true,
          openStatusVerified: true,
          sourceQualityVerified: true,
          substantiveHumanStudyVerified: true,
          correctedStatement: packet.statement,
          correctedAssumptions: packet.assumptions,
          canonicalSourceUrls: packet.sourceUrls,
          statusEvidence: packet.openStatusEvidence,
          materialErrors: [],
          literatureRisks: [],
          correctedFalsificationType: "finite-counterexample",
          correctedCounterexampleSearchability: 5,
          counterexampleAssessment:
            "A finite witness would be decisive and independently checkable.",
          correctedMinimumDecisiveArtifact:
            packet.minimumDecisiveArtifact,
          correctedArtifactReadiness: packet.artifactReadiness,
          blockingDependencies: packet.blockingDependencies,
          recommendation: "attack",
        },
      };
    }
    throw new Error(`Unexpected schema ${request.schema.name}`);
  }
}

test(
  "manual discovery persists its packet and resumes the same campaign call",
  { timeout: 5_000 },
  async (t) => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "autoprover-campaign-manual-discovery-"),
    );
    t.after(() => rm(root, { recursive: true, force: true }));
    const config = await loadConfig(null, {
      runRoot: root,
      provider: "pro-manual",
      wallClockHours: 1,
      parallelProblems: 1,
      maxConcurrentCalls: 1,
      maxCalls: 10,
      discovery: {
        poolSize: 1,
        attackCount: 1,
        minimumInterest: 1,
        minimumTractability: 1,
        minimumVerifiability: 1,
      },
    });
    const campaignDir = path.join(root, "campaigns", "manual");
    const packetDir = path.join(root, "manual-packet");
    const provider = new ManualDiscoveryFixtureProvider(packetDir);
    const controller = await CampaignController.create({
      config,
      provider,
      providerName: "pro-manual",
      campaignDir,
      policy: {
        maxCycles: 1,
        catalogLowWatermark: 1,
        discoveryRefreshMs: 0,
        idlePollMs: 2,
      },
    });

    const first = await controller.refreshCatalog();
    assert.equal(first.pendingManual, true);
    assert.equal(controller.state.budget.callsStarted, 1);
    assert.equal(controller.state.budget.callsWaiting, 1);
    assert.equal(controller.state.budget.callsFailed, 0);
    assert.equal(
      Object.values(controller.state.discoveryRuns)[0].status,
      "awaiting-manual",
    );
    const waiting = await buildCampaignSnapshot({
      campaignDir,
      runRoot: root,
    });
    assert.equal(waiting.manualQueue.length, 1);
    assert.equal(waiting.manualQueue[0].packetId, "manual-scout-packet");

    await writeFile(
      path.join(packetDir, "status.json"),
      `${JSON.stringify({ state: "response-imported" })}\n`,
    );
    const resumed = await CampaignController.resume({
      config,
      provider,
      providerName: "pro-manual",
      campaignDir,
    });
    assert.equal(await resumed.resumePendingDiscovery(), true);
    assert.equal(resumed.state.budget.callsStarted, 2);
    assert.equal(resumed.state.budget.callsCompleted, 2);
    assert.equal(resumed.state.budget.callsWaiting, 0);
    const catalog = await resumed.store.loadCatalog();
    assert.equal(Object.keys(catalog.entries).length, 1);
    assert.equal(
      Object.values(resumed.state.discoveryRuns)[0].status,
      "completed",
    );
  },
);
