#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  canonicalProviderName,
  isApiBilledProvider,
  loadConfig,
  resolveProviderName,
  validateConfig,
} from "./config.mjs";
import {
  CampaignController,
  defaultCampaignDir,
} from "./campaign.mjs";
import {
  Autoprover,
  exportSummary,
  makeRunDir,
  normalizeProblem,
  validateProblemPacket,
} from "./orchestrator.mjs";
import { createProvider } from "./providers/index.mjs";
import { main as proManualMain } from "./pro-manual-cli.mjs";
import { RunStore } from "./store.mjs";
import { numberFlag, parseArgs, readJson } from "./utils.mjs";

const execFileAsync = promisify(execFile);
const DOCTOR_PROCESS_OPTIONS = Object.freeze({
  timeout: 15_000,
  maxBuffer: 1_000_000,
});

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "manual") {
    return proManualMain(argv.slice(1));
  }
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? "help";
  if (["help", "--help", "-h"].includes(command)) return printHelp();
  if (flags.help || positional.slice(1).includes("-h")) return printHelp();
  validateCommandFlags(command, flags, positional.slice(1));

  if (command === "doctor") return doctor(flags);
  if (command === "smoke") return smoke(flags);
  if (command === "status") return status(flags);
  if (command === "validate") return validateProblems(flags);
  if (command === "campaign") return runCampaign(flags);
  if (command === "discover") return startNew(flags, false);
  if (command === "run") return startNew(flags, true);
  if (command === "resume") return resume(flags);
  throw new Error(`Unknown command: ${command}`);
}

async function doctor(flags) {
  const config = await configFromFlags(flags);
  const selected = resolveProviderName(config);
  const report = {
    node: process.version,
    configuredProvider: config.provider,
    selectedProvider: selected,
    openaiApiKey: process.env.OPENAI_API_KEY ? "set" : "unset",
    providers: {
      max: null,
      pro: {
        ready: Boolean(process.env.OPENAI_API_KEY),
        authentication: process.env.OPENAI_API_KEY ? "API key present" : "OPENAI_API_KEY is unset",
        billing: "OpenAI API usage",
      },
      "pro-manual": {
        ready: true,
        authentication: "Human-operated signed-in ChatGPT Pro conversation",
        billing: "ChatGPT subscription allowance",
      },
      fable: null,
    },
  };
  try {
    const version = await execFileAsync(
      config.codex.binary,
      ["--version"],
      DOCTOR_PROCESS_OPTIONS,
    );
    const login = await execFileAsync(
      config.codex.binary,
      ["login", "status"],
      DOCTOR_PROCESS_OPTIONS,
    );
    const loginText = `${login.stdout}${login.stderr}`.trim();
    report.providers.max = {
      ready: /^logged in using chatgpt\b/im.test(loginText),
      version: `${version.stdout}${version.stderr}`.trim(),
      authentication: loginText,
      billing: "ChatGPT/Codex subscription allowance",
    };
  } catch (error) {
    report.providers.max = { ready: false, error: error.message };
  }

  try {
    const [versionResult, authResult] = await Promise.all([
      execFileAsync(
        config.claude.binary,
        ["--version"],
        DOCTOR_PROCESS_OPTIONS,
      ),
      execFileAsync(
        config.claude.binary,
        ["auth", "status"],
        DOCTOR_PROCESS_OPTIONS,
      ),
    ]);
    const versionText = `${versionResult.stdout}${versionResult.stderr}`.trim();
    const auth = JSON.parse(`${authResult.stdout}${authResult.stderr}`.trim());
    const versionNumber = versionText.match(/\d+\.\d+\.\d+/)?.[0] ?? "0.0.0";
    const versionSupported = compareVersions(versionNumber, "2.1.170") >= 0;
    report.providers.fable = {
      ready:
        versionSupported &&
        auth.loggedIn === true &&
        auth.authMethod === "claude.ai" &&
        auth.subscriptionType === "max",
      version: versionText,
      minimumVersion: "2.1.170",
      versionSupported,
      authentication: {
        loggedIn: auth.loggedIn === true,
        method: auth.authMethod ?? "unknown",
        subscription: auth.subscriptionType ?? "unknown",
      },
      model: config.claude.defaultModel,
      billing: "Claude Max subscription allowance",
      note: "Auth status is local-state only; use a smoke run after re-authentication to prove live inference.",
    };
  } catch (error) {
    report.providers.fable = { ready: false, error: error.message };
  }
  report.selectedProviderReady = report.providers[selected]?.ready === true;
  report.recommendation = providerRecommendation(selected, report);
  console.log(JSON.stringify(report, null, 2));
}

async function smoke(flags) {
  const config = await configFromFlags(flags);
  const selected = resolveProviderName(config);
  if (selected === "pro-manual") {
    throw new Error(
      "Pro-manual is tested through its packet/import workflow; start a pro-manual run instead of a live smoke call.",
    );
  }
  requireLiveConfirmation(flags, {
    action: "make one small live provider health-check call",
    provider: selected,
    billing:
      selected === "pro"
        ? "separately billed OpenAI API usage"
        : "subscription allowance",
  });
  const temporary = await mkdtemp(path.join(os.tmpdir(), "autoprover-smoke-"));
  try {
    const { name, provider } = createProvider(config);
    const schema = {
      name: "provider_smoke",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: {
          ok: { type: "boolean" },
          provider: { type: "string" },
        },
        required: ["ok", "provider"],
      },
    };
    const result = await provider.run({
      operationKey: `smoke:${name}`,
      role: "critic",
      instructions:
        "This is a provider health check. Do not use tools. Return only the required structured object.",
      prompt: `Return ok=true and provider=${JSON.stringify(name)}.`,
      model: config.models.critic,
      schema,
      workingDir: temporary,
      tools: { webSearch: false, codeInterpreter: false },
      maxOutputTokens: 256,
      timeoutMs: 10 * 60_000,
      onStarted: async () => {},
    });
    if (result.data?.ok !== true || result.data?.provider !== name) {
      throw new Error(
        `Provider smoke check returned an unexpected payload: ${JSON.stringify(result.data)}`,
      );
    }
    console.log(
      JSON.stringify(
        {
          provider: name,
          ok: result.data?.ok === true,
          output: result.data,
          sessionCreated: Boolean(result.sessionId),
          usage: result.usage,
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function runCampaign(flags) {
  const shouldResume = flags.resume === true;
  let config;
  let campaignDir;
  let stored = null;

  if (shouldResume) {
    if (flags["campaign-dir"]) {
      campaignDir = path.resolve(String(flags["campaign-dir"]));
    } else {
      const bootstrapConfig = await loadConfig(flags.config);
      campaignDir = defaultCampaignDir(bootstrapConfig);
    }
    stored = await readJson(path.join(campaignDir, "campaign.json"));
    config = flags.config
      ? await loadConfig(String(flags.config))
      : structuredClone(stored.configSnapshot);
    config.provider = flags.provider
      ? String(flags.provider)
      : canonicalProviderName(stored.provider);
    if (flags.hours) {
      throw new Error(
        "Campaign resume uses --extend-hours, not --hours.",
      );
    }
    if (flags["parallel-problems"]) {
      config.parallelProblems = numberFlag(
        flags["parallel-problems"],
        config.parallelProblems,
      );
    }
    if (flags["max-calls"]) {
      config.maxCalls = numberFlag(flags["max-calls"], config.maxCalls);
    }
    if (flags["max-usd"]) {
      config.maxEstimatedUsd = numberFlag(
        flags["max-usd"],
        config.maxEstimatedUsd,
      );
    }
    if (flags["max-cycles"] !== undefined) {
      config.campaign.maxCycles = numberFlag(
        flags["max-cycles"],
        config.campaign.maxCycles,
      );
    }
    config = pinResumeProvider(config, stored.provider);
    validateConfig(config);
  } else {
    if (flags["extend-hours"] !== undefined) {
      throw new Error(
        "--extend-hours requires --resume; use --hours for a new campaign.",
      );
    }
    config = await configFromFlags(flags);
    if (flags["max-cycles"] !== undefined) {
      config.campaign.maxCycles = numberFlag(
        flags["max-cycles"],
        config.campaign.maxCycles,
      );
      validateConfig(config);
    }
    campaignDir = flags["campaign-dir"]
      ? path.resolve(String(flags["campaign-dir"]))
      : defaultCampaignDir(config);
    try {
      await readJson(path.join(campaignDir, "campaign.json"));
      throw new Error(
        `Campaign already exists at ${campaignDir}. Use --resume or choose a different --campaign-dir.`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }

  const selectedProvider = resolveProviderName(config);
  const continuous =
    flags.continuous === true ||
    (
      shouldResume &&
      flags.continuous === undefined &&
      stored?.policy?.continuous === true
    );
  requireLiveConfirmation(flags, {
    action: shouldResume
      ? "resume the persistent discovery and research campaign"
      : "start a persistent discovery and research campaign",
    campaignDir,
    provider: selectedProvider,
    hours: shouldResume
      ? undefined
      : config.wallClockHours,
    extendHours: shouldResume
      ? numberFlag(flags["extend-hours"], 0)
      : undefined,
    parallelProblems: config.parallelProblems,
    maxCalls: config.maxCalls,
    maxEstimatedUsd: config.maxEstimatedUsd,
    continuous,
    maxDiscoveryCycles: config.campaign.maxCycles || "unlimited until another guard stops it",
  });

  const { name, provider } = createProvider(config);
  const policy = {
    maxCycles: config.campaign.maxCycles,
    parallelProblems: config.parallelProblems,
    maxCalls: config.maxCalls,
    maxEstimatedUsd: config.maxEstimatedUsd,
    continuous,
  };
  const controller = shouldResume
    ? await CampaignController.resume({
        config,
        provider,
        providerName: name,
        campaignDir,
        policy,
        extendHours: numberFlag(flags["extend-hours"], 0),
      })
    : await CampaignController.create({
        config,
        provider,
        providerName: name,
        campaignDir,
        policy,
      });
  const snapshot = await controller.run();
  console.log(JSON.stringify(snapshot, null, 2));
}

async function startNew(flags, shouldRun) {
  const config = await configFromFlags(flags);
  requireLiveConfirmation(flags, {
    action: shouldRun ? "discover, vet, and run research" : "discover and vet problems",
    provider: resolveProviderName(config),
    hours: config.wallClockHours,
    parallelProblems: config.parallelProblems,
    maxCalls: config.maxCalls,
    maxEstimatedUsd: config.maxEstimatedUsd,
    localPermissions:
      resolveProviderName(config) === "max"
        ? `Codex sandbox: ${config.codex.sandbox}`
        : resolveProviderName(config) === "fable"
          ? `Claude permission mode: ${config.claude.permissionMode}`
          : "Provider-managed",
  });
  const { name, provider } = createProvider(config);
  const runDir = makeRunDir(config.runRoot);
  const app = await Autoprover.create({ config, provider, providerName: name, runDir });
  try {
    if (flags["problem-file"]) {
      if (name === "pro-manual" && !flags["trust-problem-file"]) {
        throw new Error(
          "Pro-manual runs with --problem-file currently require --trust-problem-file so the original packet can be resumed without a live vetting call.",
        );
      }
      const input = await readJson(path.resolve(String(flags["problem-file"])));
      await app.seedProblems(Array.isArray(input) ? input : input.problems, {
        vet: !flags["trust-problem-file"],
      });
    }
    if (shouldRun) {
      await app.run();
    } else if (!flags["problem-file"]) {
      await app.discover();
    }
  } catch (error) {
    if (!isManualInputPending(error)) throw error;
    await app.pauseForManualInput(error);
  }
  const summary = await exportSummary(app.state, runDir);
  console.log(JSON.stringify({ runDir, ...summary }, null, 2));
}

async function resume(flags) {
  const runDir = requiredFlag(flags, "run-dir");
  const stored = await readJson(path.join(path.resolve(runDir), "run.json"));
  let config = flags.config
    ? await loadConfig(String(flags.config))
    : structuredClone(stored.configSnapshot);
  if (flags.provider) config.provider = String(flags.provider);
  if (flags["max-calls"]) config.maxCalls = numberFlag(flags["max-calls"], config.maxCalls);
  if (flags["max-usd"]) config.maxEstimatedUsd = numberFlag(flags["max-usd"], config.maxEstimatedUsd);
  config = pinResumeProvider(config, stored.provider);
  validateConfig(config);
  if (stored.status === "budget-exhausted") {
    const callBudgetStillExhausted =
      config.maxCalls <= stored.budget.callsStarted;
    const costBudgetStillExhausted =
      isApiBilledProvider(stored.provider) &&
      config.maxEstimatedUsd <= stored.budget.estimatedUsd;
    if (callBudgetStillExhausted || costBudgetStillExhausted) {
      throw new Error(
        `This run exhausted its budget. Increase ${
          callBudgetStillExhausted ? "--max-calls" : "--max-usd"
        } before resuming.`,
      );
    }
  }
  requireLiveConfirmation(flags, {
    action: "resume research",
    runDir: path.resolve(runDir),
    provider: resolveProviderName(config),
    extendHours: numberFlag(flags["extend-hours"], 0),
    maxCalls: config.maxCalls,
    maxEstimatedUsd: config.maxEstimatedUsd,
    localPermissions:
      resolveProviderName(config) === "max"
        ? `Codex sandbox: ${config.codex.sandbox}`
        : resolveProviderName(config) === "fable"
          ? `Claude permission mode: ${config.claude.permissionMode}`
          : "Provider-managed",
  });
  const { name, provider } = createProvider(config);
  const app = await Autoprover.resume({
    config,
    provider,
    providerName: name,
    runDir,
    extendHours: numberFlag(flags["extend-hours"], 0),
  });
  await app.run();
  const summary = await exportSummary(app.state, path.resolve(runDir));
  console.log(JSON.stringify({ runDir: path.resolve(runDir), ...summary }, null, 2));
}

async function status(flags) {
  if (flags["run-dir"]) {
    const state = await readJson(path.join(path.resolve(String(flags["run-dir"])), "run.json"));
    console.log(JSON.stringify(compactStatus(state), null, 2));
    return;
  }
  const config = await configFromFlags(flags);
  const store = new RunStore(path.resolve(config.runRoot, ".status"));
  const runs = await store.listRuns(config.runRoot);
  console.log(JSON.stringify(runs.slice(0, 20).map(({ runDir, state }) => ({ runDir, ...compactStatus(state) })), null, 2));
}

async function validateProblems(flags) {
  const problemFile = requiredFlag(flags, "problem-file");
  const input = await readJson(path.resolve(problemFile));
  const problems = Array.isArray(input) ? input : input.problems;
  if (!Array.isArray(problems) || !problems.length) throw new Error("Problem file must contain a non-empty problems array");
  const normalized = problems.map((problem) => {
    validateProblemPacket(problem);
    return normalizeProblem(problem);
  });
  validateUniqueProblemIds(normalized);
  console.log(
    JSON.stringify(
      {
        valid: true,
        count: normalized.length,
        problems: normalized.map(({ id, title, statementHash, verificationMode, sourceUrls }) => ({
          id,
          title,
          statementHash,
          verificationMode,
          sourceUrls,
        })),
      },
      null,
      2,
    ),
  );
}

export function pinResumeProvider(config, storedProvider) {
  let canonicalStored;
  try {
    canonicalStored = canonicalProviderName(storedProvider);
  } catch {
    throw new Error(`Stored run has an invalid resolved provider: ${storedProvider ?? "missing"}`);
  }
  const requested =
    config.provider === "auto"
      ? canonicalStored
      : canonicalProviderName(config.provider);
  if (requested !== canonicalStored) {
    throw new Error(
      `Run is pinned to the ${canonicalStored} provider and cannot be resumed with ${requested}. ` +
        "Start a new run to change providers.",
    );
  }
  return { ...config, provider: canonicalStored };
}

export function validateUniqueProblemIds(problems) {
  const seen = new Map();
  for (let index = 0; index < problems.length; index += 1) {
    const id = normalizeProblem(problems[index]).id;
    if (seen.has(id)) {
      throw new Error(
        `Duplicate problem id after normalization: ${id} (entries ${seen.get(id) + 1} and ${index + 1})`,
      );
    }
    seen.set(id, index);
  }
  return true;
}

async function configFromFlags(flags) {
  const overrides = {};
  if (flags.provider) overrides.provider = String(flags.provider);
  if (flags.hours) overrides.wallClockHours = numberFlag(flags.hours);
  if (flags["parallel-problems"]) overrides.parallelProblems = numberFlag(flags["parallel-problems"]);
  if (flags["max-calls"]) overrides.maxCalls = numberFlag(flags["max-calls"]);
  if (flags["max-usd"]) overrides.maxEstimatedUsd = numberFlag(flags["max-usd"]);
  return loadConfig(flags.config, overrides);
}

function compactStatus(state) {
  const waitingManual = Object.values(state.operations ?? {})
    .filter((operation) => operation.status === "waiting-input")
    .map((operation) => ({
      operationKey: operation.operationKey,
      role: operation.role,
      packetId: operation.packetId ?? operation.sessionId ?? null,
      packetDir: operation.packetDir ?? null,
      waitingSince: operation.waitingSince ?? null,
      error: operation.error ?? null,
    }));
  return {
    runId: state.runId,
    status: state.status,
    provider: state.provider,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    deadlineAt: state.deadlineAt,
    stopReason: state.stopReason ?? "",
    budget: state.budget,
    waitingManual,
    problems: state.problems.map((problem) => ({
      title: problem.packet.title,
      status: problem.status,
      round: problem.round,
      stopReason: problem.stopReason ?? "",
      activeBranches: problem.branches.filter((branch) => branch.status === "active").length,
      pendingCandidates: problem.pendingCandidates?.length ?? 0,
      pendingSynthesisRound: problem.pendingSynthesisRound ?? null,
      bestCandidate: Boolean(problem.bestCandidate),
    })),
  };
}

function requiredFlag(flags, name) {
  if (!flags[name]) throw new Error(`--${name} is required`);
  return String(flags[name]);
}

export function validateCommandFlags(command, flags, extraPositionals = []) {
  const allowed = {
    doctor: ["config", "provider", "help"],
    smoke: ["config", "provider", "yes", "help"],
    status: ["config", "run-dir", "help"],
    validate: ["problem-file", "help"],
    campaign: [
      "config",
      "campaign-dir",
      "provider",
      "hours",
      "extend-hours",
      "parallel-problems",
      "max-calls",
      "max-usd",
      "max-cycles",
      "continuous",
      "resume",
      "yes",
      "help",
    ],
    discover: ["config", "problem-file", "trust-problem-file", "provider", "hours", "parallel-problems", "max-calls", "max-usd", "yes", "help"],
    run: ["config", "problem-file", "trust-problem-file", "provider", "hours", "parallel-problems", "max-calls", "max-usd", "yes", "help"],
    resume: ["run-dir", "config", "provider", "max-calls", "max-usd", "extend-hours", "yes", "help"],
  };
  if (!allowed[command]) throw new Error(`Unknown command: ${command}`);
  if (extraPositionals.length) throw new Error(`Unexpected positional arguments: ${extraPositionals.join(" ")}`);
  const unknown = Object.keys(flags).filter((flag) => !allowed[command].includes(flag));
  if (unknown.length) throw new Error(`Unknown flag(s) for ${command}: ${unknown.map((flag) => `--${flag}`).join(", ")}`);
}

function requireLiveConfirmation(flags, plan) {
  console.error(`Preflight:\n${JSON.stringify(plan, null, 2)}`);
  if (flags.yes === true || process.env.AUTOPROVER_CONFIRM === "1") return;
  throw new Error("Live model calls require --yes. Review the preflight and run the command again with --yes.");
}

function printHelp() {
  console.log(`autoprover

Usage:
  node src/cli.mjs doctor [--config config.json]
  node src/cli.mjs smoke --yes --provider max|pro|fable
  node src/cli.mjs validate --problem-file problems.json
  node src/cli.mjs discover [--config config.json] [--problem-file problems.json]
  node src/cli.mjs campaign --yes [--hours 24] [--parallel-problems 2] [--continuous]
  node src/cli.mjs campaign --yes --resume [--extend-hours 12] [--continuous]
  node src/cli.mjs run --yes [--config config.json] [--hours 12] [--problem-file problems.json]
  node src/cli.mjs resume --yes --run-dir runs/<id> [--extend-hours 12]
  node src/cli.mjs status [--run-dir runs/<id>]
  node src/cli.mjs manual list --run-dir runs/<id>
  node src/cli.mjs manual show --packet runs/<id>/manual-pro/<packet>
  node src/cli.mjs manual import --packet <packet-dir> --response-file answer.txt

Important flags:
  --provider auto|max|pro|pro-manual|fable
  --parallel-problems N
  --max-calls N
  --max-usd N
  --max-cycles N      Campaign discovery cycles; 0 means deadline/budget limited
  --continuous        Subscription providers renew call allowance until the deadline

Provider selection:
  max        GPT-5.6 Sol through the ChatGPT-authenticated Codex CLI, Max effort
  pro        GPT-5.6 Sol through Responses API, Pro mode + Max effort (API billed)
  pro-manual Schema-validated copy/paste queue for ChatGPT Pro; no scraping
  fable      Claude Fable 5 through the Claude.ai-authenticated Claude CLI

  auto always selects subscription-backed max. Select pro explicitly for API usage.
  Legacy aliases codex, responses, and claude remain accepted.
`);
}

function compareVersions(left, right) {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

function providerRecommendation(selected, report) {
  if (report.providers[selected]?.ready) {
    if (selected === "pro") {
      return "API Pro is ready. This route is separately API-billed and guarded by --max-usd.";
    }
    if (selected === "max") {
      return "Subscription-backed GPT-5.6 Sol Max is ready through Codex.";
    }
    if (selected === "fable") {
      return "Subscription-backed Claude Fable 5 is ready through Claude Max.";
    }
    return "Manual ChatGPT Pro packet mode is ready.";
  }
  const ready = Object.entries(report.providers)
    .filter(([, value]) => value?.ready)
    .map(([name]) => name);
  return `Selected provider ${selected} is not ready. Ready providers: ${ready.join(", ") || "none"}.`;
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

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
