import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CampaignStore,
  emptyCatalog,
} from "../src/campaign-store.mjs";
import { startDashboardServer } from "../src/dashboard-server.mjs";

const COMMAND_TOKEN = "dashboard-test-command-token";

async function listen(server, host = "127.0.0.1") {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object");
  return `http://${host}:${address.port}`;
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function fakeCampaignProcess() {
  const process = new EventEmitter();
  process.exitCode = null;
  process.signalCode = null;
  process.kill = () => {
    process.exitCode = 0;
    process.emit("exit", 0, null);
  };
  return process;
}

async function dashboardFixture(t, options = {}) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-dashboard-server-"),
  );
  const campaignDir = path.join(root, "campaign");
  const frontend = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        proxied: true,
        method: req.method,
        url: req.url,
        host: req.headers.host,
      }),
    );
  });
  const frontendUrl = await listen(frontend);
  const config = {
    provider: "max",
    runRoot: path.join(root, "runs"),
    wallClockHours: 24,
    parallelProblems: 2,
    maxConcurrentCalls: 4,
    maxCalls: 60,
    maxEstimatedUsd: 100,
    campaign: { maxCycles: 0 },
  };
  await options.beforeStart?.({ campaignDir, config });
  const dashboard = await startDashboardServer({
    config,
    campaignDir,
    commandToken: COMMAND_TOKEN,
    frontendUrl,
    spawnFrontend: false,
    port: 0,
    campaignSpawner: options.campaignSpawner,
    recoveryDelayMs: options.recoveryDelayMs,
    startupRecoveryDelayMs: options.startupRecoveryDelayMs,
    externalProcessPollMs: options.externalProcessPollMs,
  });
  const address = dashboard.server.address();
  assert(address && typeof address === "object");
  const dashboardUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await dashboard.close();
    await closeServer(frontend);
    await rm(root, { recursive: true, force: true });
  });
  return { campaignDir, config, dashboardUrl, frontendUrl };
}

function activeCampaignState(config, overrides = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    campaignId: "dashboard-lifecycle",
    provider: "max",
    status: "running",
    startedAt: now,
    updatedAt: now,
    deadlineAt: new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString(),
    configSnapshot: structuredClone(config),
    policy: {
      durationHours: 6,
      problemHours: 6,
      parallelProblems: 2,
      maxConcurrentCalls: 4,
      maxCalls: 60,
      callBudgetBatch: 60,
      continuous: true,
      maxEstimatedUsd: 100,
    },
    cycle: 0,
    budget: {
      callsStarted: 12,
      callsCompleted: 12,
      callsFailed: 0,
      callsWaiting: 0,
      inFlight: 0,
      estimatedUsd: 0,
    },
    slots: [
      { slotId: 1, status: "idle" },
      { slotId: 2, status: "idle" },
    ],
    attempts: {},
    notes: [],
    stopReason: "",
    ...overrides,
  };
}

async function initializeDashboardCampaign(campaignDir, config, overrides) {
  const store = new CampaignStore(campaignDir, {
    catalogDir: path.resolve(config.runRoot, "_catalog"),
  });
  await store.initialize(
    activeCampaignState(config, overrides),
    emptyCatalog(),
  );
}

test("idle dashboard has a render-safe shape and exposes its per-process command token", async (t) => {
  const { dashboardUrl } = await dashboardFixture(t);

  const response = await fetch(`${dashboardUrl}/api/dashboard`);
  assert.equal(response.status, 200);
  const snapshot = await response.json();

  assert.equal(snapshot.campaign, null);
  assert.deepEqual(snapshot.counts, {
    catalog: 0,
    queued: 0,
    active: 0,
    candidates: 0,
    reproduced: 0,
  });
  assert.deepEqual(snapshot.catalog, []);
  assert.deepEqual(snapshot.activeProblems, []);
  assert.deepEqual(snapshot.events, []);
  assert.deepEqual(snapshot.manualQueue, []);
  assert.equal(snapshot.server.local, true);
  assert.equal(snapshot.server.commandToken, COMMAND_TOKEN);
  assert.equal(snapshot.server.campaignProcessRunning, false);
});

test("mutating dashboard routes reject a missing or invalid command token", async (t) => {
  const { dashboardUrl } = await dashboardFixture(t);

  for (const token of [undefined, "wrong-token"]) {
    const response = await fetch(`${dashboardUrl}/api/campaign/stop`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(token
          ? { "x-autoprover-command-token": token }
          : {}),
      },
      body: "{}",
    });
    assert.equal(response.status, 403);
    assert.match((await response.json()).error, /command token/i);
  }
});

test("an authorized safe stop is durable and a manual response cannot name an unknown packet", async (t) => {
  const { campaignDir, dashboardUrl } = await dashboardFixture(t);
  const headers = {
    "content-type": "application/json",
    "x-autoprover-command-token": COMMAND_TOKEN,
  };

  const stopResponse = await fetch(`${dashboardUrl}/api/campaign/stop`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(stopResponse.status, 202);
  const stop = JSON.parse(
    await readFile(path.join(campaignDir, "stop-request.json"), "utf8"),
  );
  assert.match(stop.reason, /operator|stop/i);

  const manualResponse = await fetch(
    `${dashboardUrl}/api/manual/not-a-real-packet/response`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({ result: "untrusted" }),
    },
  );
  assert.equal(manualResponse.status, 404);
  assert.match((await manualResponse.json()).error, /manual packet/i);
});

test("start and resume routes preserve generic lifecycle settings", async (t) => {
  const launches = [];
  const first = await dashboardFixture(t, {
    campaignSpawner: (options) => {
      launches.push(options.launch);
      return fakeCampaignProcess();
    },
  });
  const headers = {
    "content-type": "application/json",
    "x-autoprover-command-token": COMMAND_TOKEN,
  };

  const startResponse = await fetch(
    `${first.dashboardUrl}/api/campaign/start`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        provider: "max",
        wallClockHours: 12,
        parallelProblems: 6,
        maxCalls: 40,
        maxEstimatedUsd: 75,
        continuous: true,
      }),
    },
  );
  assert.equal(startResponse.status, 202);
  assert.deepEqual(launches[0], {
    provider: "max",
    wallClockHours: 12,
    extendHours: undefined,
    parallelProblems: 6,
    maxCalls: 40,
    maxEstimatedUsd: 75,
    continuous: true,
    resume: false,
  });

  const resumeLaunches = [];
  const second = await dashboardFixture(t, {
    beforeStart: ({ campaignDir, config }) =>
      initializeDashboardCampaign(campaignDir, config, {
        status: "stopped",
        pausedAt: new Date().toISOString(),
        pausedRemainingMs: 3 * 60 * 60 * 1_000,
      }),
    campaignSpawner: (options) => {
      resumeLaunches.push(options.launch);
      return fakeCampaignProcess();
    },
  });
  const resumeResponse = await fetch(
    `${second.dashboardUrl}/api/campaign/resume`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        extendHours: 5,
        parallelProblems: 3,
        continuous: true,
      }),
    },
  );
  assert.equal(resumeResponse.status, 202);
  assert.deepEqual(resumeLaunches[0], {
    provider: "max",
    wallClockHours: undefined,
    extendHours: 5,
    parallelProblems: 3,
    maxCalls: 60,
    maxEstimatedUsd: 100,
    continuous: true,
    resume: true,
  });
});

test("a continuous campaign restarts from durable state at startup and after a signal", async (t) => {
  const launches = [];
  const children = [];
  const { dashboardUrl } = await dashboardFixture(t, {
    beforeStart: ({ campaignDir, config }) =>
      initializeDashboardCampaign(campaignDir, config),
    campaignSpawner: (options) => {
      launches.push(options.launch);
      const child = fakeCampaignProcess();
      children.push(child);
      return child;
    },
    recoveryDelayMs: 25,
    startupRecoveryDelayMs: 25,
  });

  const deadline = Date.now() + 2_000;
  while (!launches.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0], {
    provider: "max",
    wallClockHours: undefined,
    extendHours: 0,
    parallelProblems: 2,
    maxCalls: 60,
    maxEstimatedUsd: 100,
    continuous: true,
    resume: true,
  });
  const snapshot = await (await fetch(`${dashboardUrl}/api/dashboard`)).json();
  assert.equal(snapshot.server.campaignProcessRunning, true);

  children[0].signalCode = "SIGKILL";
  children[0].emit("exit", null, "SIGKILL");
  const restartDeadline = Date.now() + 2_000;
  while (launches.length < 2 && Date.now() < restartDeadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[1], launches[0]);
});

test("a restarted dashboard attaches to a live locked campaign instead of duplicating it", async (t) => {
  const launches = [];
  let liveStore;
  const { dashboardUrl } = await dashboardFixture(t, {
    beforeStart: async ({ campaignDir, config }) => {
      await initializeDashboardCampaign(campaignDir, config);
      liveStore = new CampaignStore(campaignDir, {
        catalogDir: path.resolve(config.runRoot, "_catalog"),
      });
      await liveStore.acquireCampaignLock();
    },
    campaignSpawner: (options) => {
      launches.push(options.launch);
      return fakeCampaignProcess();
    },
    recoveryDelayMs: 25,
    startupRecoveryDelayMs: 25,
    externalProcessPollMs: 25,
  });

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(launches.length, 0);
  const attached = await (
    await fetch(`${dashboardUrl}/api/dashboard`)
  ).json();
  assert.equal(attached.server.campaignProcessRunning, true);

  await liveStore.releaseCampaignLock();
  const deadline = Date.now() + 2_000;
  while (!launches.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(launches.length, 1);
  assert.equal(launches[0].resume, true);
});

test("catalog nudge routes persist discovery, suggestion, priority, and switch commands", async (t) => {
  const { campaignDir, dashboardUrl } = await dashboardFixture(t);
  const store = new CampaignStore(campaignDir);
  await store.initialize(
    {
      schemaVersion: 1,
      campaignId: "dashboard-nudges",
      status: "running",
      updatedAt: new Date().toISOString(),
    },
    emptyCatalog(),
  );
  const headers = {
    "content-type": "application/json",
    "x-autoprover-command-token": COMMAND_TOKEN,
  };
  const requests = [
    ["/api/catalog/discover", {}],
    ["/api/catalog/suggest", { query: "A named open problem" }],
    ["/api/catalog/prioritize", { problemKey: "problem-key" }],
    [
      "/api/attempt/switch",
      {
        attemptId: "attempt-key",
        problemKey: "problem-key",
        reason: "stalled",
      },
    ],
  ];
  for (const [route, body] of requests) {
    const response = await fetch(`${dashboardUrl}${route}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    assert.equal(response.status, 202);
    assert.equal((await response.json()).accepted, true);
  }

  assert.deepEqual(
    (await store.listCommands()).map((command) => command.type),
    ["discover", "add-problem", "prioritize", "switch"],
  );
});

test("non-API requests are proxied to the configured frontend without losing the request target", async (t) => {
  const { dashboardUrl, frontendUrl } = await dashboardFixture(t);

  const response = await fetch(
    `${dashboardUrl}/research?view=queue&domain=number-theory`,
  );
  assert.equal(response.status, 200);
  const result = await response.json();

  assert.deepEqual(result, {
    proxied: true,
    method: "GET",
    url: "/research?view=queue&domain=number-theory",
    host: new URL(frontendUrl).host,
  });
});
