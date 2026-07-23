import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = path.dirname(fileURLToPath(import.meta.url));
const examplePath = path.resolve(sourceRoot, "../config.example.json");

function merge(base, override) {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    output[key] =
      value && typeof value === "object" && !Array.isArray(value)
        ? merge(base[key] ?? {}, value)
        : value;
  }
  return output;
}

export async function loadConfig(configPath, overrides = {}) {
  const defaults = JSON.parse(await readFile(examplePath, "utf8"));
  let local = {};
  if (configPath) {
    local = JSON.parse(await readFile(path.resolve(configPath), "utf8"));
  } else {
    const candidate = path.resolve("config.json");
    try {
      local = JSON.parse(await readFile(candidate, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const config = merge(merge(defaults, local), overrides);
  validateConfig(config);
  return config;
}

function positive(name, value, allowZero = false) {
  const valid = allowZero ? value >= 0 : value > 0;
  if (!Number.isFinite(value) || !valid) throw new Error(`${name} must be ${allowZero ? "non-negative" : "positive"}`);
}

function integer(name, value, allowZero = false) {
  const valid = allowZero ? value >= 0 : value > 0;
  if (!Number.isInteger(value) || !valid) {
    throw new Error(
      `${name} must be a ${allowZero ? "non-negative" : "positive"} integer`,
    );
  }
}

export function validateConfig(config) {
  if (!PROVIDER_INPUT_NAMES.includes(config.provider)) {
    throw new Error(
      `provider must be one of: ${PROVIDER_INPUT_NAMES.join(", ")}`,
    );
  }
  positive("wallClockHours", config.wallClockHours);
  for (const key of [
    "parallelProblems",
    "branchesPerProblem",
    "maxConcurrentCalls",
    "maxCalls",
    "maxTurnsPerBranch",
    "maxNoProgressEpochs",
    "maxPortfolioStagnationRounds",
    "independentVerificationPasses",
    "maxBranchesPerProblem",
    "maxTurnsPerSession",
  ]) {
    integer(key, config[key]);
  }
  positive("maxEstimatedUsd", config.maxEstimatedUsd, true);
  positive("roundCooldownSeconds", config.roundCooldownSeconds, true);
  integer("maxRepairCycles", config.maxRepairCycles, true);
  integer("maxReframesPerBranch", config.maxReframesPerBranch, true);
  if (
    !config.campaign ||
    typeof config.campaign !== "object" ||
    Array.isArray(config.campaign)
  ) {
    throw new Error("campaign configuration is required");
  }
  integer("campaign.maxCycles", config.campaign.maxCycles, true);
  integer("campaign.refreshEveryCycles", config.campaign.refreshEveryCycles);
  positive(
    "campaign.refreshBackoffMinutes",
    config.campaign.refreshBackoffMinutes,
  );
  positive("campaign.catalogTtlHours", config.campaign.catalogTtlHours);
  positive("campaign.leaseMinutes", config.campaign.leaseMinutes);
  positive(
    "campaign.retryCooldownHours",
    config.campaign.retryCooldownHours,
    true,
  );
  integer(
    "campaign.maxAttemptsPerProblem",
    config.campaign.maxAttemptsPerProblem,
  );
  if (typeof config.campaign.stopOnCandidate !== "boolean") {
    throw new Error("campaign.stopOnCandidate must be boolean");
  }
  if (
    !config.discovery ||
    typeof config.discovery !== "object" ||
    Array.isArray(config.discovery)
  ) {
    throw new Error("discovery configuration is required");
  }
  integer("discovery.poolSize", config.discovery.poolSize);
  integer("discovery.attackCount", config.discovery.attackCount);
  if (config.discovery.attackCount > config.discovery.poolSize) {
    throw new Error("discovery.attackCount cannot exceed discovery.poolSize");
  }
  for (const key of [
    "minimumInterest",
    "minimumTractability",
    "minimumVerifiability",
  ]) {
    const value = config.discovery[key];
    if (!Number.isInteger(value) || value < 1 || value > 5) {
      throw new Error(`discovery.${key} must be an integer from 1 to 5`);
    }
  }
  if (
    !Array.isArray(config.discovery.domains) ||
    config.discovery.domains.some(
      (domain) => typeof domain !== "string" || !domain.trim(),
    )
  ) {
    throw new Error("discovery.domains must be an array of non-empty strings");
  }
  for (const [role, model] of Object.entries(config.models)) {
    if (!model.model || !model.effort || !model.mode) throw new Error(`models.${role} is incomplete`);
    if (!["standard", "pro"].includes(model.mode)) throw new Error(`models.${role}.mode must be standard or pro`);
    if (!["none", "low", "medium", "high", "xhigh", "max"].includes(model.effort)) {
      throw new Error(`models.${role}.effort is not supported`);
    }
  }
  if (!["1g", "4g", "16g", "64g"].includes(config.responses.codeInterpreterMemory)) {
    throw new Error("responses.codeInterpreterMemory must be 1g, 4g, 16g, or 64g");
  }
  positive("responses.pollIntervalSeconds", config.responses.pollIntervalSeconds);
  positive(
    "responses.requestTimeoutMinutes",
    config.responses.requestTimeoutMinutes,
  );
  integer("responses.maxOutputTokens", config.responses.maxOutputTokens);
  if (!["read-only", "workspace-write", "danger-full-access"].includes(config.codex.sandbox)) {
    throw new Error("codex.sandbox is invalid");
  }
  if (typeof config.codex.binary !== "string" || !config.codex.binary.trim()) {
    throw new Error("codex.binary must be a non-empty string");
  }
  positive("codex.turnTimeoutMinutes", config.codex.turnTimeoutMinutes);
  if (config.codex.subscriptionOnly !== true) {
    throw new Error(
      "codex.subscriptionOnly must be true; use provider=pro for API-billed OpenAI work",
    );
  }
  if (!config.claude || typeof config.claude !== "object") {
    throw new Error("claude configuration is required");
  }
  if (typeof config.claude.binary !== "string" || !config.claude.binary.trim()) {
    throw new Error("claude.binary must be a non-empty string");
  }
  if (
    typeof config.claude.defaultModel !== "string" ||
    !config.claude.defaultModel.trim()
  ) {
    throw new Error("claude.defaultModel must be a non-empty string");
  }
  if (!["low", "medium", "high", "max"].includes(config.claude.effort)) {
    throw new Error("claude.effort must be low, medium, high, or max");
  }
  if (
    ![
      "acceptEdits",
      "bypassPermissions",
      "dontAsk",
      "manual",
      "plan",
      "auto",
    ].includes(config.claude.permissionMode)
  ) {
    throw new Error("claude.permissionMode is invalid");
  }
  positive("claude.turnTimeoutMinutes", config.claude.turnTimeoutMinutes);
  if (config.claude.subscriptionOnly !== true) {
    throw new Error(
      "claude.subscriptionOnly must be true because provider=fable is subscription-backed",
    );
  }
  for (const key of ["safeMode", "disableSlashCommands", "respectRequestTools"]) {
    if (typeof config.claude[key] !== "boolean") {
      throw new Error(`claude.${key} must be boolean`);
    }
  }
  if (!config.proManual || typeof config.proManual !== "object") {
    throw new Error("proManual configuration is required");
  }
  positive(
    "proManual.pollIntervalSeconds",
    config.proManual.pollIntervalSeconds,
  );
  if (typeof config.proManual.waitForResponse !== "boolean") {
    throw new Error("proManual.waitForResponse must be boolean");
  }
  if (
    config.proManual.queueDir !== null &&
    (typeof config.proManual.queueDir !== "string" ||
      !config.proManual.queueDir.trim())
  ) {
    throw new Error("proManual.queueDir must be null or a non-empty string");
  }
  for (const [name, value] of Object.entries(config.pricingPerMillionTokens)) {
    positive(`pricingPerMillionTokens.${name}`, value, true);
  }
}

export function resolveProviderName(config) {
  if (config.provider !== "auto") return canonicalProviderName(config.provider);
  return "max";
}

export const PROVIDER_NAMES = Object.freeze([
  "max",
  "pro",
  "pro-manual",
  "fable",
]);

export const PROVIDER_ALIASES = Object.freeze({
  codex: "max",
  responses: "pro",
  claude: "fable",
});

export const PROVIDER_INPUT_NAMES = Object.freeze([
  "auto",
  ...PROVIDER_NAMES,
  ...Object.keys(PROVIDER_ALIASES),
]);

export function canonicalProviderName(name) {
  if (PROVIDER_NAMES.includes(name)) return name;
  if (Object.hasOwn(PROVIDER_ALIASES, name)) return PROVIDER_ALIASES[name];
  throw new Error(`Unknown provider: ${name ?? "missing"}`);
}

export function isApiBilledProvider(name) {
  return canonicalProviderName(name) === "pro";
}
