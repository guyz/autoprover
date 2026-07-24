#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalProviderName,
  loadConfig,
  PROVIDER_INPUT_NAMES,
} from "./config.mjs";
import {
  buildCampaignSnapshot,
  defaultCampaignDir,
  requestCampaignStop,
} from "./campaign.mjs";
import { CampaignStore } from "./campaign-store.mjs";
import { importManualResponse } from "./providers/pro-manual.mjs";
import { numberFlag, parseArgs } from "./utils.mjs";

const sourceDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(sourceDir, "..");
const dashboardRoot = path.join(projectRoot, "dashboard");
const cliPath = path.join(sourceDir, "cli.mjs");
const MAX_BODY_BYTES = 64 * 1024;

export async function startDashboardServer(options = {}) {
  const config = options.config ?? (await loadConfig(options.configPath));
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4317;
  const frontendHost = "127.0.0.1";
  const frontendPort = options.frontendPort ?? 4320;
  const frontendUrl =
    options.frontendUrl ?? `http://${frontendHost}:${frontendPort}`;
  const campaignDir =
    options.campaignDir ?? defaultCampaignDir(config, "default");
  const commandToken =
    options.commandToken ?? randomBytes(24).toString("base64url");
  const recentProcessNotes = [];
  let campaignProcess = null;
  let frontendProcess = null;
  let resumeScheduled = false;
  let recoveryTimer = null;
  let closing = false;
  const campaignSpawner = options.campaignSpawner ?? spawnCampaign;
  const recoveryDelayMs = options.recoveryDelayMs ?? 2_000;
  const startupRecoveryDelayMs = options.startupRecoveryDelayMs ?? 250;

  const note = (level, message) => {
    recentProcessNotes.push({
      at: new Date().toISOString(),
      level,
      message: String(message).slice(0, 2_000),
    });
    if (recentProcessNotes.length > 80) recentProcessNotes.shift();
  };

  const launchCampaign = (launch) => {
    const child = campaignSpawner({
      campaignDir,
      configPath: options.configPath,
      launch,
      note,
    });
    campaignProcess = child;
    child.on("error", (error) => {
      note("error", `Campaign process could not start: ${error.message}`);
      if (campaignProcess === child) campaignProcess = null;
      scheduleContinuousRecovery();
    });
    child.on("exit", (code, signal) => {
      note(
        code === 0 ? "info" : "error",
        `Campaign process exited (${code ?? signal ?? "unknown"}).`,
      );
      scheduleContinuousRecovery();
    });
    return child;
  };

  const scheduleContinuousRecovery = (delayMs = recoveryDelayMs) => {
    if (closing || recoveryTimer) return;
    recoveryTimer = setTimeout(async () => {
      recoveryTimer = null;
      if (closing || processIsRunning(campaignProcess)) return;
      try {
        const snapshot = await buildCampaignSnapshot({
          campaignDir,
          runRoot: config.runRoot,
        });
        const campaign = snapshot.campaign;
        if (
          campaign?.continuous !== true ||
          campaign.timeLeftMs <= 0 ||
          ![
            "running",
            "discovering",
            "ranking",
            "attacking",
            "verifying",
            "budget-exhausted",
          ].includes(campaign.status)
        ) {
          return;
        }
        note(
          "warning",
          "Continuous campaign was not running; restarting it from the last saved checkpoint.",
        );
        launchCampaign(
          normalizeLaunch(
            {
              provider: campaign.provider,
              extendHours: 0,
              parallelProblems:
                campaign.parallelProblems ?? config.parallelProblems,
              maxCalls:
                campaign.budget?.maxCalls ?? config.maxCalls,
              maxEstimatedUsd:
                campaign.budget?.maxEstimatedUsd ??
                config.maxEstimatedUsd,
              continuous: true,
            },
            config,
            { resume: true },
          ),
        );
      } catch (error) {
        if (error.code !== "ENOENT") {
          note("error", `Continuous recovery failed: ${error.message}`);
          scheduleContinuousRecovery(10_000);
        }
      }
    }, delayMs);
  };

  const scheduleCampaignResume = (launch) => {
    if (processIsRunning(campaignProcess)) {
      if (!resumeScheduled) {
        resumeScheduled = true;
        campaignProcess.once("exit", () => {
          resumeScheduled = false;
          launchCampaign(launch);
        });
      }
      return false;
    }
    launchCampaign(launch);
    return true;
  };

  const enqueueOperatorCommand = async (type, payload = {}) => {
    const store = new CampaignStore(campaignDir, {
      catalogDir: path.resolve(config.runRoot, "_catalog"),
    });
    try {
      await store.loadCampaign();
    } catch (error) {
      if (error.code === "ENOENT") {
        throw httpError(409, "Start a campaign before nudging its catalog");
      }
      throw error;
    }
    return store.enqueueCommand(type, payload);
  };

  if (options.spawnFrontend !== false && !options.frontendUrl) {
    frontendProcess = spawn(
      "npm",
      [
        "run",
        "dev",
        "--",
        "--hostname",
        frontendHost,
        "--port",
        String(frontendPort),
      ],
      {
        cwd: dashboardRoot,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    frontendProcess.stdout.on("data", (chunk) =>
      note("info", chunk.toString()),
    );
    frontendProcess.stderr.on("data", (chunk) =>
      note("warning", chunk.toString()),
    );
    frontendProcess.on("exit", (code, signal) => {
      note(
        code === 0 ? "info" : "error",
        `Dashboard frontend exited (${code ?? signal ?? "unknown"}).`,
      );
      frontendProcess = null;
    });
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${host}:${port}`);
      if (url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }
      if (url.pathname.startsWith("/api/")) {
        if (!sameLocalOrigin(req, host, port)) {
          return sendJson(res, 403, { error: "Cross-origin request refused" });
        }
        if (req.method === "GET" && url.pathname === "/api/dashboard") {
          let snapshot;
          try {
            snapshot = await buildCampaignSnapshot({
              campaignDir,
              runRoot: config.runRoot,
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            snapshot = {
              campaign: null,
              counts: {
                catalog: 0,
                queued: 0,
                active: 0,
                candidates: 0,
                reproduced: 0,
              },
              catalog: [],
              activeProblems: [],
              events: [],
              notes: [],
              manualQueue: [],
            };
          }
          return sendJson(res, 200, {
            ...snapshot,
            server: {
              local: true,
              commandToken,
              campaignProcessRunning: processIsRunning(campaignProcess),
              recentProcessNotes,
            },
          });
        }
        if (req.method === "POST" && url.pathname === "/api/campaign/start") {
          requireCommandToken(req, commandToken);
          if (processIsRunning(campaignProcess)) {
            return sendJson(res, 409, {
              error: "A campaign process is already running",
            });
          }
          try {
            await buildCampaignSnapshot({
              campaignDir,
              runRoot: config.runRoot,
            });
            return sendJson(res, 409, {
              error:
                "A campaign already exists here. Use Continue to resume it.",
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
          const body = await readJsonBody(req);
          const launch = normalizeLaunch(body, config);
          launchCampaign(launch);
          return sendJson(res, 202, {
            accepted: true,
            message: "Campaign started",
          });
        }
        if (req.method === "POST" && url.pathname === "/api/campaign/resume") {
          requireCommandToken(req, commandToken);
          if (processIsRunning(campaignProcess)) {
            return sendJson(res, 409, {
              error: "The campaign process is already running",
            });
          }
          const body = await readJsonBody(req);
          let current;
          try {
            current = await buildCampaignSnapshot({
              campaignDir,
              runRoot: config.runRoot,
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            throw httpError(404, "No campaign exists to resume");
          }
          const launch = normalizeLaunch(
            {
              ...body,
              provider: body.provider ?? current.campaign.provider,
              parallelProblems:
                body.parallelProblems ??
                current.campaign.parallelProblems ??
                config.parallelProblems,
              maxCalls:
                body.maxCalls ??
                current.campaign.budget.maxCalls ??
                config.maxCalls,
              maxEstimatedUsd:
                body.maxEstimatedUsd ??
                current.campaign.budget.maxEstimatedUsd ??
                config.maxEstimatedUsd,
              continuous:
                body.continuous ??
                current.campaign.continuous ??
                true,
            },
            config,
            { resume: true },
          );
          launchCampaign(launch);
          return sendJson(res, 202, {
            accepted: true,
            message: "Campaign resumed",
          });
        }
        if (req.method === "POST" && url.pathname === "/api/campaign/stop") {
          requireCommandToken(req, commandToken);
          await readJsonBody(req);
          await requestCampaignStop(campaignDir);
          return sendJson(res, 202, {
            accepted: true,
            message:
              "Safe stop requested. Active model calls will checkpoint before the campaign releases its leases.",
          });
        }
        if (req.method === "POST" && url.pathname === "/api/catalog/discover") {
          requireCommandToken(req, commandToken);
          await readJsonBody(req);
          const command = await enqueueOperatorCommand("discover");
          return sendJson(res, 202, {
            accepted: true,
            commandId: command.id,
            message:
              processIsRunning(campaignProcess)
                ? "Fresh catalog discovery queued."
                : "Fresh catalog discovery queued; press Continue to process it.",
          });
        }
        if (req.method === "POST" && url.pathname === "/api/catalog/suggest") {
          requireCommandToken(req, commandToken);
          const body = await readJsonBody(req);
          const query = boundedText(
            body.query,
            500,
            "Problem name or source URL",
          );
          const command = await enqueueOperatorCommand("add-problem", {
            query,
          });
          return sendJson(res, 202, {
            accepted: true,
            commandId: command.id,
            message:
              processIsRunning(campaignProcess)
                ? "Requested problem queued for sourcing and independent vetting."
                : "Requested problem saved; press Continue to source and vet it.",
          });
        }
        if (
          req.method === "POST" &&
          url.pathname === "/api/catalog/prioritize"
        ) {
          requireCommandToken(req, commandToken);
          const body = await readJsonBody(req);
          const problemKey = boundedText(
            body.problemKey,
            256,
            "Problem id",
          );
          const command = await enqueueOperatorCommand("prioritize", {
            problemKey,
          });
          return sendJson(res, 202, {
            accepted: true,
            commandId: command.id,
            message:
              processIsRunning(campaignProcess)
                ? "Problem queued to run next."
                : "Problem priority saved; press Continue to apply it.",
          });
        }
        if (req.method === "POST" && url.pathname === "/api/attempt/switch") {
          requireCommandToken(req, commandToken);
          const body = await readJsonBody(req);
          const attemptId = boundedText(body.attemptId, 256, "Attempt id");
          const problemKey = boundedText(
            body.problemKey,
            256,
            "Problem id",
          );
          const reason = optionalBoundedText(body.reason, 500, "Switch note");
          const command = await enqueueOperatorCommand("switch", {
            attemptId,
            problemKey,
            reason,
          });
          return sendJson(res, 202, {
            accepted: true,
            commandId: command.id,
            message:
              "Switch queued. The current model call will finish and checkpoint before the slot moves on.",
          });
        }
        const manualResponseMatch = url.pathname.match(
          /^\/api\/manual\/([^/]+)\/response$/,
        );
        if (req.method === "POST" && manualResponseMatch) {
          requireCommandToken(req, commandToken);
          const packetId = decodeURIComponent(manualResponseMatch[1]);
          let snapshot;
          try {
            snapshot = await buildCampaignSnapshot({
              campaignDir,
              runRoot: config.runRoot,
            });
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
            throw httpError(404, "Unknown pending manual packet");
          }
          const packet = snapshot.manualQueue?.find(
            (candidate) => candidate.packetId === packetId,
          );
          if (!packet?.packetDir) {
            throw httpError(404, "Unknown pending manual packet");
          }
          const response = await readJsonBody(req);
          await importManualResponse(
            packet.packetDir,
            JSON.stringify(response),
            { note: "Imported through the local Autoprover dashboard" },
          );
          const resumeLaunch = normalizeLaunch(
            {
              provider:
                snapshot.campaign?.provider ??
                (config.provider === "auto"
                  ? "max"
                  : canonicalProviderName(config.provider)),
              extendHours: 0,
              parallelProblems:
                snapshot.campaign?.parallelProblems ??
                config.parallelProblems,
              maxCalls:
                snapshot.campaign?.budget?.maxCalls ?? config.maxCalls,
              maxEstimatedUsd:
                snapshot.campaign?.budget?.maxEstimatedUsd ??
                config.maxEstimatedUsd,
              continuous:
                snapshot.campaign?.continuous ?? true,
            },
            config,
            { resume: true },
          );
          const startedNow = scheduleCampaignResume(resumeLaunch);
          return sendJson(res, 202, {
            accepted: true,
            message: startedNow
              ? "Manual response validated; the campaign is resuming."
              : "Manual response validated; the campaign will resume as soon as its current process exits.",
          });
        }
        return sendJson(res, 404, { error: "Unknown dashboard API route" });
      }
      return proxyFrontend(req, res, frontendUrl);
    } catch (error) {
      const status = error.statusCode ?? 500;
      note(status >= 500 ? "error" : "warning", error.message);
      return sendJson(res, status, { error: error.message });
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  scheduleContinuousRecovery(startupRecoveryDelayMs);

  const close = async () => {
    closing = true;
    if (recoveryTimer) clearTimeout(recoveryTimer);
    await new Promise((resolve) => server.close(resolve));
    if (processIsRunning(frontendProcess)) frontendProcess.kill("SIGTERM");
  };
  return {
    server,
    close,
    url: `http://${host}:${port}/`,
    campaignDir,
    commandToken,
  };
}

function spawnCampaign({ campaignDir, configPath, launch, note }) {
  const args = [
    cliPath,
    "campaign",
    "--yes",
    "--campaign-dir",
    campaignDir,
    "--parallel-problems",
    String(launch.parallelProblems),
    "--max-calls",
    String(launch.maxCalls),
    "--max-usd",
    String(launch.maxEstimatedUsd),
  ];
  if (launch.resume) {
    args.push("--resume", "--extend-hours", String(launch.extendHours));
  } else {
    args.push(
      "--provider",
      launch.provider,
      "--hours",
      String(launch.wallClockHours),
    );
  }
  if (launch.continuous) args.push("--continuous");
  if (launch.maxCycles !== undefined) {
    args.push("--max-cycles", String(launch.maxCycles));
  }
  if (configPath) args.push("--config", path.resolve(configPath));
  const keepAwake = process.platform === "darwin";
  const executable = keepAwake ? "/usr/bin/caffeinate" : process.execPath;
  const processArgs = keepAwake
    ? ["-im", process.execPath, ...args]
    : args;
  const child = spawn(executable, processArgs, {
    cwd: projectRoot,
    env: { ...process.env, AUTOPROVER_CONFIRM: "1", NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (keepAwake) {
    note(
      "info",
      "macOS idle sleep is inhibited while this campaign process is active.",
    );
  }
  child.stdout.on("data", (chunk) => note("info", chunk.toString()));
  child.stderr.on("data", (chunk) => note("warning", chunk.toString()));
  return child;
}

function processIsRunning(child) {
  return Boolean(
    child &&
      child.exitCode === null &&
      (child.signalCode === null || child.signalCode === undefined),
  );
}

function normalizeLaunch(body, config, options = {}) {
  const providerInput = String(body.provider ?? config.provider);
  if (!PROVIDER_INPUT_NAMES.includes(providerInput)) {
    throw httpError(400, "Unsupported provider");
  }
  const provider =
    providerInput === "auto" ? "max" : canonicalProviderName(providerInput);
  const resume = options.resume === true;
  const wallClockHours = resume
    ? undefined
    : boundedNumber(
        body.wallClockHours,
        config.wallClockHours,
        0.25,
        72,
        "wallClockHours",
      );
  const extendHours = resume
    ? boundedNumber(body.extendHours, 0, 0, 72, "extendHours")
    : undefined;
  const parallelProblems = boundedInteger(
    body.parallelProblems,
    config.parallelProblems,
    1,
    8,
    "parallelProblems",
  );
  const maxCalls = boundedInteger(
    body.maxCalls,
    config.maxCalls,
    1,
    100_000,
    "maxCalls",
  );
  const maxEstimatedUsd = boundedNumber(
    body.maxEstimatedUsd,
    config.maxEstimatedUsd,
    0,
    1_000_000,
    "maxEstimatedUsd",
  );
  const continuous =
    body.continuous === undefined ? false : body.continuous === true;
  const launch = {
    provider,
    wallClockHours,
    extendHours,
    parallelProblems,
    maxCalls,
    maxEstimatedUsd,
    continuous,
    resume,
  };
  if (body.maxCycles !== undefined) {
    launch.maxCycles = boundedInteger(
      body.maxCycles,
      config.campaign.maxCycles,
      0,
      10_000,
      "maxCycles",
    );
  }
  return launch;
}

function boundedNumber(value, fallback, min, max, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(number) || number < min || number > max) {
    throw httpError(400, `${label} must be between ${min} and ${max}`);
  }
  return number;
}

function boundedInteger(value, fallback, min, max, label) {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    throw httpError(400, `${label} must be an integer from ${min} to ${max}`);
  }
  return number;
}

function boundedText(value, maxLength, label) {
  const text = String(value ?? "").trim();
  if (!text) throw httpError(400, `${label} is required`);
  if (text.length > maxLength) {
    throw httpError(400, `${label} must be ${maxLength} characters or fewer`);
  }
  return text;
}

function optionalBoundedText(value, maxLength, label) {
  if (value === undefined || value === null || String(value).trim() === "") {
    return "";
  }
  return boundedText(value, maxLength, label);
}

function requireCommandToken(req, expected) {
  if (req.headers["x-autoprover-command-token"] !== expected) {
    throw httpError(403, "Missing or invalid dashboard command token");
  }
}

function sameLocalOrigin(req, host, port) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    return (
      ["127.0.0.1", "localhost", host].includes(parsed.hostname) &&
      Number(parsed.port || 80) === port
    );
  } catch {
    return false;
  }
}

async function readJsonBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw httpError(413, "Request body is too large");
    }
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw httpError(400, "Request body must be valid JSON");
  }
}

function proxyFrontend(req, res, frontendUrl) {
  const target = new URL(req.url ?? "/", frontendUrl);
  const proxied = httpRequest(
    target,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: target.host,
      },
    },
    (upstream) => {
      res.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(res);
    },
  );
  proxied.on("error", () => {
    if (res.headersSent) return res.end();
    res.writeHead(503, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<!doctype html><title>Autoprover is starting</title><main><h1>Autoprover is starting…</h1><p>The dashboard will be ready in a moment. Refresh this page.</p></main>",
    );
  });
  req.pipe(proxied);
}

function sendJson(res, status, value) {
  const body = `${JSON.stringify(value)}\n`;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
  });
  res.end(body);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  if (positional.length) {
    throw new Error(`Unexpected dashboard arguments: ${positional.join(" ")}`);
  }
  const allowed = new Set([
    "config",
    "campaign-dir",
    "port",
    "frontend-port",
    "frontend-url",
    "no-frontend",
  ]);
  const unknown = Object.keys(flags).filter((key) => !allowed.has(key));
  if (unknown.length) {
    throw new Error(
      `Unknown dashboard flag(s): ${unknown.map((key) => `--${key}`).join(", ")}`,
    );
  }
  const app = await startDashboardServer({
    configPath: flags.config ? String(flags.config) : undefined,
    campaignDir: flags["campaign-dir"]
      ? path.resolve(String(flags["campaign-dir"]))
      : undefined,
    port: numberFlag(flags.port, 4317),
    frontendPort: numberFlag(flags["frontend-port"], 4320),
    frontendUrl: flags["frontend-url"]
      ? String(flags["frontend-url"])
      : undefined,
    spawnFrontend: flags["no-frontend"] !== true,
  });
  console.log(`Autoprover dashboard: ${app.url}`);

  const close = async () => {
    await app.close();
    process.exit(0);
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
