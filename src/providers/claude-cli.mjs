import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDir,
  extractJson,
  writePrivateText,
} from "../utils.mjs";
import {
  buildSubscriptionChildEnvironment,
  createSuspensionAwareTimeout,
  registerChildProcessCleanup,
  settleWithin,
} from "./child-runtime.mjs";

const CLAUDE_MODEL_PREFIX = "claude-";
const DEFAULT_MODEL = "claude-fable-5";
const DEFAULT_TIMEOUT_MINUTES = 120;
const CHECKPOINT_TIMEOUT_MS = 30_000;

/**
 * Runs Claude Code through the user's claude.ai login. The provider deliberately
 * uses stdin for the prompt so long research packets do not hit argv limits or
 * appear in process listings.
 */
export class ClaudeCliProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.claude = config.claude ?? {};
    this.binary = options.binary ?? this.claude.binary ?? "claude";
    this.processRunner = options.processRunner ?? runClaudeProcess;
  }

  async run(request) {
    const requestedSessionId = request.resumeId ?? request.sessionId;
    const allocatedSessionId = requestedSessionId ?? randomUUID();
    const effectiveRequest =
      requestedSessionId === request.sessionId
        ? request
        : { ...request, sessionId: requestedSessionId };
    const internalDir = path.join(request.workingDir, ".autoprover");
    const systemPromptPath = path.join(
      internalDir,
      `claude-system-${randomUUID()}.txt`,
    );
    await ensurePrivateDir(internalDir);
    await writePrivateText(systemPromptPath, request.instructions);
    let result;
    let startedSessionId;
    const announceStarted = async (sessionId) => {
      if (!sessionId || sessionId === startedSessionId) return;
      startedSessionId = sessionId;
      await request.onStarted?.(sessionId);
    };
    try {
      const args = buildClaudeArgs({
        request: effectiveRequest,
        claudeConfig: this.claude,
        allocatedSessionId,
        systemPromptPath,
      });
      const fullPrompt = `${request.prompt}\n`;
      const timeoutMinutes =
        this.claude.turnTimeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
      const timeoutMs = Math.min(
        timeoutMinutes * 60_000,
        request.timeoutMs ?? Infinity,
      );
      result = await this.processRunner({
        binary: this.binary,
        args,
        cwd: request.workingDir,
        input: fullPrompt,
        timeoutMs,
        onSession: announceStarted,
        subscriptionOnly: this.claude.subscriptionOnly !== false,
      });
    } finally {
      await rm(systemPromptPath, { force: true });
    }
    const parsed = parseClaudeStream(result.stdout);
    const sessionId =
      parsed.sessionId ?? requestedSessionId ?? allocatedSessionId;

    // Some Claude Code versions emit the session only on the terminal result
    // event. Ensure the orchestrator still persists it before returning.
    await announceStarted(sessionId);

    if (!parsed.resultEvent) {
      throw new ClaudeCliProtocolError(
        `Claude exited successfully without a result event. stderr: ${result.stderr.slice(-2000)}`,
      );
    }
    if (
      parsed.resultEvent.is_error === true ||
      ["error", "failed"].includes(parsed.resultEvent.subtype)
    ) {
      const detail =
        parsed.resultEvent.result ??
        parsed.resultEvent.error ??
        parsed.resultEvent.subtype ??
        "unknown error";
      throw new ClaudeCliResultError(
        `Claude reported an unsuccessful result: ${stringifyDetail(detail)}`,
      );
    }

    const { data, rawText } = extractClaudeResult(parsed.resultEvent);
    return {
      sessionId,
      data,
      rawText,
      usage: parsed.usage,
      evidence: parsed.evidence,
      response: {
        result: parsed.resultEvent,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }
}

/**
 * Build a deterministic, non-interactive Claude Code invocation.
 *
 * Fable 5 is exposed by the local Claude Code installation as
 * `claude-fable-5`. A Claude model explicitly supplied on the request wins;
 * OpenAI model names are ignored in favor of claude.defaultModel so the
 * provider can safely consume a provider-agnostic model-role configuration.
 */
export function buildClaudeArgs({
  request,
  claudeConfig = {},
  allocatedSessionId,
  systemPromptPath,
}) {
  if (!systemPromptPath) {
    throw new Error("Claude systemPromptPath is required");
  }
  const model = resolveClaudeModel(
    request.model?.model,
    claudeConfig.defaultModel ?? DEFAULT_MODEL,
  );
  const effort = normalizeClaudeEffort(
    request.model?.effort ?? claudeConfig.effort ?? "max",
  );
  const permissionMode = claudeConfig.permissionMode ?? "auto";
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--model",
    model,
    "--effort",
    effort,
    "--permission-mode",
    permissionMode,
    "--json-schema",
    JSON.stringify(request.schema.schema),
    "--append-system-prompt-file",
    systemPromptPath,
    "--no-chrome",
  ];

  if (claudeConfig.disableSlashCommands !== false) {
    args.push("--disable-slash-commands");
  }
  if (claudeConfig.safeMode !== false) {
    args.push("--safe-mode");
  }
  if (claudeConfig.respectRequestTools !== false) {
    const disallowedTools = [];
    if (request.tools?.webSearch === false) {
      disallowedTools.push("WebSearch", "WebFetch");
    }
    if (request.tools?.codeInterpreter === false) {
      disallowedTools.push("Bash", "Write", "Edit", "NotebookEdit");
    }
    if (disallowedTools.length) {
      args.push("--disallowedTools", disallowedTools.join(","));
    }
  }
  if (permissionMode === "bypassPermissions") {
    args.push("--dangerously-skip-permissions");
  }
  if (request.sessionId) {
    args.push("--resume", request.sessionId);
  } else {
    args.push("--session-id", allocatedSessionId);
  }
  return args;
}

export function resolveClaudeModel(requestedModel, defaultModel = DEFAULT_MODEL) {
  return typeof requestedModel === "string" &&
    requestedModel.startsWith(CLAUDE_MODEL_PREFIX)
    ? requestedModel
    : defaultModel;
}

export function normalizeClaudeEffort(effort) {
  if (effort === "none" || effort === "low") return "low";
  if (effort === "medium") return "medium";
  if (effort === "high") return "high";
  if (effort === "xhigh" || effort === "max") return "max";
  return "max";
}

/**
 * Parse Claude Code's `--output-format stream-json` JSONL protocol.
 * Unknown/non-JSON diagnostic lines are retained but do not make an otherwise
 * valid run fail, which keeps this compatible across CLI versions.
 */
export function parseClaudeStream(stdout) {
  const events = [];
  const diagnostics = [];
  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line));
    } catch {
      diagnostics.push(line);
    }
  }

  const resultEvent = [...events]
    .reverse()
    .find((event) => event?.type === "result");
  const sessionEvent = events.find((event) => event?.session_id);
  const sessionId =
    resultEvent?.session_id ?? sessionEvent?.session_id ?? undefined;
  const usage = normalizeClaudeUsage(
    resultEvent?.usage ?? aggregateAssistantUsage(events),
  );
  const evidence = extractClaudeEvidence(events);

  return {
    events,
    diagnostics,
    resultEvent,
    sessionId,
    usage,
    evidence,
  };
}

export function extractClaudeResult(resultEvent) {
  if (
    resultEvent.structured_output &&
    typeof resultEvent.structured_output === "object"
  ) {
    return {
      data: resultEvent.structured_output,
      rawText: JSON.stringify(resultEvent.structured_output),
    };
  }
  if (resultEvent.result && typeof resultEvent.result === "object") {
    return {
      data: resultEvent.result,
      rawText: JSON.stringify(resultEvent.result),
    };
  }
  const rawText = String(resultEvent.result ?? "");
  return { data: extractJson(rawText), rawText };
}

export function normalizeClaudeUsage(usage = {}) {
  return {
    inputTokens: usage.input_tokens ?? usage.inputTokens ?? 0,
    cachedInputTokens:
      usage.cache_read_input_tokens ?? usage.cachedInputTokens ?? 0,
    cacheWriteTokens:
      usage.cache_creation_input_tokens ?? usage.cacheWriteTokens ?? 0,
    outputTokens: usage.output_tokens ?? usage.outputTokens ?? 0,
    reasoningTokens:
      usage.thinking_tokens ??
      usage.reasoning_tokens ??
      usage.output_tokens_details?.reasoning_tokens ??
      usage.reasoningTokens ??
      0,
  };
}

export function extractClaudeEvidence(events) {
  const evidence = [];
  for (const event of events) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type !== "tool_use") continue;
      evidence.push({
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: block.input,
      });
    }
  }
  return evidence;
}

function aggregateAssistantUsage(events) {
  const usage = {
    input_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    output_tokens: 0,
    thinking_tokens: 0,
  };
  for (const event of events) {
    if (event?.type !== "assistant" || !event.message?.usage) continue;
    const entry = event.message.usage;
    usage.input_tokens += entry.input_tokens ?? 0;
    usage.cache_read_input_tokens += entry.cache_read_input_tokens ?? 0;
    usage.cache_creation_input_tokens +=
      entry.cache_creation_input_tokens ?? 0;
    usage.output_tokens += entry.output_tokens ?? 0;
    usage.thinking_tokens +=
      entry.thinking_tokens ?? entry.reasoning_tokens ?? 0;
  }
  return usage;
}

/**
 * Spawn Claude and checkpoint its session ID as soon as the stream announces
 * it. subscriptionOnly strips API/proxy credentials so a Max-backed run cannot
 * silently become a separately billed API run.
 */
export function runClaudeProcess({
  binary,
  args,
  cwd,
  input,
  timeoutMs,
  onSession,
  subscriptionOnly = true,
  spawnImpl = spawn,
  baseEnv = process.env,
  checkpointTimeoutMs = CHECKPOINT_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const env = buildClaudeEnvironment({
      subscriptionOnly,
      baseEnv,
      cwd,
    });

    const child = spawnImpl(binary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let announcedSessionId;
    let sessionCallback = Promise.resolve();
    let sessionCallbackError;
    let settled = false;
    let timedOut = false;
    let timer;
    let forceKillTimer;
    let unregisterProcessCleanup = () => {};

    const killProcessTree = (signal) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // The process may have already exited or a test double may not own a
          // real process group. Fall back to killing the direct child.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The direct child may have exited between the group and direct kill.
      }
    };

    const terminate = () => {
      killProcessTree("SIGTERM");
      forceKillTimer ??= setTimeout(
        () => killProcessTree("SIGKILL"),
        5000,
      );
      forceKillTimer.unref();
    };

    const clearTimers = () => {
      timer?.clear?.();
      if (forceKillTimer) clearTimeout(forceKillTimer);
    };

    unregisterProcessCleanup = registerChildProcessCleanup(terminate);
    timer = Number.isFinite(timeoutMs)
      ? createSuspensionAwareTimeout(() => {
          timedOut = true;
          terminate();
        }, Math.max(1, timeoutMs))
      : null;
    timer?.unref?.();

    const announceSession = (sessionId) => {
      if (!sessionId || sessionId === announcedSessionId) return;
      announcedSessionId = sessionId;
      sessionCallback = sessionCallback
        .then(() =>
          settleWithin(
            onSession?.(sessionId),
            checkpointTimeoutMs,
            `Claude session checkpoint did not settle within ${checkpointTimeoutMs} ms`,
          ),
        )
        .catch((error) => {
          sessionCallbackError ??= error;
          terminate();
        });
    };

    const consumeLine = (line) => {
      if (!line.trim()) return;
      try {
        announceSession(JSON.parse(line).session_id);
      } catch {
        // Non-JSON diagnostics are handled by parseClaudeStream after exit.
      }
    };

    child.stdout.on("data", (data) => {
      const chunk = data.toString();
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) consumeLine(line);
    });
    child.stderr.on("data", (data) => {
      stderr += data.toString();
    });
    child.on("error", (error) => {
      clearTimers();
      unregisterProcessCleanup();
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", async (code, signal) => {
      clearTimers();
      unregisterProcessCleanup();
      if (settled) return;
      settled = true;
      consumeLine(buffer);
      try {
        await settleWithin(
          sessionCallback,
          checkpointTimeoutMs,
          `Claude session checkpoint did not settle within ${checkpointTimeoutMs} ms`,
        );
      } catch (error) {
        sessionCallbackError ??= error;
      }
      if (sessionCallbackError) {
        reject(sessionCallbackError);
        return;
      }
      if (timedOut) {
        reject(
          new ClaudeCliTimeoutError(
            `Claude exceeded its ${Math.ceil(timeoutMs)} ms turn timeout`,
          ),
        );
        return;
      }
      if (code !== 0) {
        reject(
          new ClaudeCliProcessError(
            `Claude exited with code ${code ?? "null"} signal ${signal ?? "none"}: ${stderr.slice(-4000)}`,
          ),
        );
        return;
      }
      resolve({ stdout, stderr });
    });

    child.stdin.on("error", (error) => {
      // EPIPE is expected when the executable fails before reading stdin; the
      // process close/error path provides the actionable diagnostic.
      if (error.code !== "EPIPE" && !settled) {
        settled = true;
        clearTimers();
        terminate();
        unregisterProcessCleanup();
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export function buildClaudeEnvironment({
  subscriptionOnly = true,
  baseEnv = process.env,
  cwd,
} = {}) {
  const overrides = { NO_COLOR: "1" };
  if (cwd) overrides.PWD = cwd;
  return subscriptionOnly
    ? buildSubscriptionChildEnvironment(baseEnv, overrides)
    : { ...baseEnv, ...overrides };
}

function stringifyDetail(value) {
  return typeof value === "string" ? value : JSON.stringify(value);
}

export class ClaudeCliProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeCliProtocolError";
  }
}

export class ClaudeCliResultError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeCliResultError";
  }
}

export class ClaudeCliProcessError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeCliProcessError";
  }
}

export class ClaudeCliTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "ClaudeCliTimeoutError";
  }
}
