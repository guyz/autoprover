import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalProviderName,
  loadConfig,
  validateConfig,
} from "../src/config.mjs";
import { Autoprover } from "../src/orchestrator.mjs";
import { createProvider } from "../src/providers/index.mjs";
import {
  ProManualProvider,
  importManualResponse,
  listManualPackets,
} from "../src/providers/pro-manual.mjs";

const problem = {
  id: "manual-integration",
  title: "Manual integration problem",
  domain: "combinatorics",
  statement: "Determine whether the finite test statement holds.",
  assumptions: [],
  sourceUrls: ["https://mathworld.wolfram.com/"],
  openStatusEvidence: ["Test fixture supplied by the operator."],
  knownResults: [],
  verificationMode: "finite-witness",
  interest: 3,
  tractability: 4,
  verifiability: 5,
  sourceQuality: 3,
  whyPromising: "A finite witness would decide the test fixture.",
  risks: [],
};

test("provider names canonicalize legacy aliases and instantiate every backend", async () => {
  assert.equal(canonicalProviderName("codex"), "max");
  assert.equal(canonicalProviderName("responses"), "pro");
  assert.equal(canonicalProviderName("claude"), "fable");

  for (const provider of ["max", "pro-manual", "fable"]) {
    const config = await loadConfig(null, { provider });
    const created = createProvider(config);
    assert.equal(created.name, provider);
    assert.equal(typeof created.provider.run, "function");
  }

  const proConfig = await loadConfig(null, { provider: "pro" });
  const pro = createProvider(proConfig, {
    pro: { apiKey: "test-key", fetch: async () => new Response() },
  });
  assert.equal(pro.name, "pro");
  assert.equal(typeof pro.provider.run, "function");
});

test("provider-specific configuration rejects unsafe or malformed values", async () => {
  const config = await loadConfig(null, {});
  assert.throws(
    () =>
      validateConfig({
        ...config,
        claude: { ...config.claude, permissionMode: "unrestricted" },
      }),
    /claude.permissionMode is invalid/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        proManual: { ...config.proManual, pollIntervalSeconds: 0 },
      }),
    /proManual.pollIntervalSeconds must be positive/,
  );
});

test("subscription providers record tokens but do not consume the API dollar guard", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    runRoot: root,
    maxEstimatedUsd: 0,
  });
  const fake = {
    async run(request) {
      await request.onStarted?.("subscription-session");
      return {
        sessionId: "subscription-session",
        data: { answer: "ok" },
        usage: {
          inputTokens: 1_000_000,
          cachedInputTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 1_000_000,
          reasoningTokens: 0,
        },
        evidence: [],
      };
    },
  };
  const app = await Autoprover.create({
    config,
    provider: fake,
    providerName: "max",
    runDir: path.join(root, "run"),
  });
  await app.callModel({
    operationKey: "test:subscription-cost",
    role: "critic",
    prompt: "Return the test answer.",
    schema: {
      name: "test_answer",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { answer: { type: "string" } },
        required: ["answer"],
      },
    },
    workingDir: path.join(root, "work"),
    tools: { webSearch: false, codeInterpreter: false },
  });
  assert.equal(app.state.budget.inputTokens, 1_000_000);
  assert.equal(app.state.budget.outputTokens, 1_000_000);
  assert.equal(app.state.budget.estimatedUsd, 0);
});

test("manual provider pauses a run, accepts a strict import, and resumes the same operation", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-flow-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, {
    provider: "pro-manual",
    runRoot: root,
    parallelProblems: 1,
    branchesPerProblem: 1,
    maxConcurrentCalls: 1,
    maxCalls: 8,
    proManual: { waitForResponse: false },
  });
  const runDir = path.join(root, "run");
  const provider = new ProManualProvider(config);
  const app = await Autoprover.create({
    config,
    provider,
    providerName: "pro-manual",
    runDir,
  });
  await app.seedProblems([problem], { vet: false });

  await app.run();
  assert.equal(app.state.status, "awaiting-manual");
  let packets = await listManualPackets(path.join(runDir, "manual-pro"));
  assert.equal(packets.length, 1);
  assert.equal(packets[0].role, "planner");

  await importManualResponse(
    packets[0].packetDir,
    JSON.stringify({
      baseline: "Inspect the finite cases exactly.",
      acceptanceContract: "A complete exact witness or proof.",
      strategies: [
        {
          id: "finite-search",
          title: "Finite exact search",
          hypothesis: "A small witness exists.",
          predictedObservation: "The exact checker finds a witness.",
          falsifier: "The bounded exhaustive search is empty.",
          noveltyVector: ["exact-enumeration"],
          preferredTools: ["exact arithmetic"],
        },
      ],
    }),
    { note: "integration test" },
  );

  await app.run();
  assert.equal(app.state.status, "awaiting-manual");
  packets = await listManualPackets(path.join(runDir, "manual-pro"));
  assert.equal(packets.length, 2);
  assert.equal(
    Object.values(app.state.operations).filter(
      (operation) => operation.status === "completed",
    ).length,
    1,
  );
  assert.equal(
    Object.values(app.state.operations).filter(
      (operation) => operation.status === "waiting-input",
    ).length,
    1,
  );
  assert.equal(app.state.budget.callsStarted, 2);
});

test("all provider outputs are runtime-validated before entering research state", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-schema-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = await loadConfig(null, { runRoot: root });
  const app = await Autoprover.create({
    config,
    provider: {
      async run(request) {
        await request.onStarted?.("invalid-output-session");
        return {
          sessionId: "invalid-output-session",
          data: { wrong: true },
          usage: {},
          evidence: [],
        };
      },
    },
    providerName: "max",
    runDir: path.join(root, "run"),
  });

  await assert.rejects(
    () =>
      app.callModel({
        operationKey: "test:invalid-output",
        role: "critic",
        prompt: "Return a valid response.",
        schema: {
          name: "strict_result",
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
    /does not match.*answer is required.*wrong is not allowed/,
  );
});
