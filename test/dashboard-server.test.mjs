import assert from "node:assert/strict";
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

async function dashboardFixture(t) {
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
    maxCalls: 60,
    campaign: { maxCycles: 0 },
  };
  const dashboard = await startDashboardServer({
    config,
    campaignDir,
    commandToken: COMMAND_TOKEN,
    frontendUrl,
    spawnFrontend: false,
    port: 0,
  });
  const address = dashboard.server.address();
  assert(address && typeof address === "object");
  const dashboardUrl = `http://127.0.0.1:${address.port}`;

  t.after(async () => {
    await dashboard.close();
    await closeServer(frontend);
    await rm(root, { recursive: true, force: true });
  });
  return { campaignDir, dashboardUrl, frontendUrl };
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
