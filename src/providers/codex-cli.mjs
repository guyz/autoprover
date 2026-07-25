import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDir,
  ensurePrivateFile,
  extractJson,
  sha256,
  shortId,
  writePrivateText,
} from "../utils.mjs";
import {
  buildSubscriptionChildEnvironment,
  createSuspensionAwareTimeout,
  registerChildProcessCleanup,
  settleWithin,
} from "./child-runtime.mjs";

const CHECKPOINT_TIMEOUT_MS = 30_000;
const MACOS_CHATGPT_CODEX =
  "/Applications/ChatGPT.app/Contents/Resources/codex";

export class CodexCliProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.binary =
      options.binary ?? resolveCodexBinary(config.codex.binary);
    this.processRunner = options.processRunner ?? runProcess;
  }

  async run(request) {
    const internalDir = path.join(request.workingDir, ".autoprover");
    await ensurePrivateDir(internalDir);
    const callId = request.operationKey
      ? sha256(request.operationKey).slice(0, 16)
      : shortId();
    const schemaPath = path.join(internalDir, `schema-${callId}.json`);
    const outputPath = path.join(internalDir, `output-${callId}.json`);
    await writePrivateText(
      schemaPath,
      `${JSON.stringify(request.schema.schema, null, 2)}\n`,
    );

    const fullPrompt = `${request.instructions}\n\n${request.prompt}`;
    const resumableSessionId = request.resumeId ?? request.sessionId;
    const solverEffort =
      request.role === "solver"
        ? this.config.codex.effort ?? request.model.effort
        : request.model.effort ?? this.config.codex.effort;
    const isolatedWorkerArgs = [
      // Research workers must not inherit personal plugins, MCP servers, or
      // connectors from the operator's Codex config. They retain native web
      // search plus explicitly enabled command-line network access inside the
      // isolated branch workspace.
      "--ignore-user-config",
      ...(request.role === "solver"
        ? ["--enable", "multi_agent"]
        : []),
      ...(this.config.codex.sandbox === "workspace-write"
        ? ["-c", "sandbox_workspace_write.network_access=true"]
        : []),
    ];
    const commandArgs = resumableSessionId
      ? [
          "exec",
          ...isolatedWorkerArgs,
          "resume",
          resumableSessionId,
          "-m",
          request.model.model,
          "-c",
          `model_reasoning_effort=\"${solverEffort}\"`,
          "-c",
          `sandbox_mode=\"${this.config.codex.sandbox}\"`,
          "--output-schema",
          schemaPath,
          "-o",
          outputPath,
          "--json",
          "--skip-git-repo-check",
          "-",
        ]
      : [
          "exec",
          ...isolatedWorkerArgs,
          "-m",
          request.model.model,
          "-c",
          `model_reasoning_effort=\"${solverEffort}\"`,
          "--sandbox",
          this.config.codex.sandbox,
          "--output-schema",
          schemaPath,
          "-o",
          outputPath,
          "--json",
          "--skip-git-repo-check",
          "-",
        ];
    const args =
      request.tools?.webSearch === false
        ? commandArgs
        : ["--search", ...commandArgs];

    const result = await this.processRunner({
      binary: this.binary,
      args,
      cwd: request.workingDir,
      env: buildCodexEnvironment({
        subscriptionOnly: this.config.codex.subscriptionOnly !== false,
        cwd: request.workingDir,
      }),
      timeoutMs: Math.min(
        this.config.codex.turnTimeoutMinutes * 60_000,
        request.timeoutMs ?? Infinity,
      ),
      input: fullPrompt,
      onThread: request.onStarted,
    });
    await ensurePrivateFile(outputPath);
    const rawText = await readFile(outputPath, "utf8");
    return {
      sessionId: result.threadId ?? request.sessionId,
      data: extractJson(rawText),
      rawText,
      usage: result.usage,
      evidence: [],
      response: { stdout: result.stdout, stderr: result.stderr },
    };
  }
}

export function resolveCodexBinary(
  configuredBinary,
  {
    platform = process.platform,
    exists = existsSync,
  } = {},
) {
  if (
    configuredBinary === "codex" &&
    platform === "darwin" &&
    exists(MACOS_CHATGPT_CODEX)
  ) {
    // The desktop app and CLI share ChatGPT authentication and the model
    // catalog cache. Prefer the app-bundled CLI so both sides parse the same
    // cache schema; a separately upgraded Homebrew/npm CLI can otherwise fail
    // before inference with a stale/incompatible models_cache.json.
    return MACOS_CHATGPT_CODEX;
  }
  return configuredBinary;
}

export function buildCodexEnvironment({
  subscriptionOnly = true,
  baseEnv = process.env,
  cwd,
} = {}) {
  const overrides = { NO_COLOR: "1" };
  if (cwd) overrides.PWD = cwd;
  const env = subscriptionOnly
    ? buildSubscriptionChildEnvironment(baseEnv, overrides)
    : { ...baseEnv, ...overrides };
  return env;
}

export function runProcess({
  binary,
  args,
  cwd,
  env = process.env,
  timeoutMs,
  input = "",
  onThread,
  checkpointTimeoutMs = CHECKPOINT_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let buffer = "";
    let threadId;
    let threadStartPromise = Promise.resolve();
    let threadStartError;
    let usage = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 };
    let settled = false;
    let timedOut = false;
    let timer;
    let forceKillTimer;
    let unregisterProcessCleanup = () => {};

    const killTree = (signal) => {
      if (process.platform !== "win32" && child.pid) {
        try {
          process.kill(-child.pid, signal);
          return;
        } catch {
          // Fall through when the child has already exited.
        }
      }
      try {
        child.kill(signal);
      } catch {
        // The direct child may have exited between the group and direct kill.
      }
    };

    const terminate = () => {
      killTree("SIGTERM");
      forceKillTimer ??= setTimeout(() => killTree("SIGKILL"), 5000);
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

    const consume = (chunk) => {
      stdout += chunk;
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          // Keep non-JSON diagnostic lines in stdout, but do not fail parsing.
          continue;
        }
        if (event.type === "thread.started" && event.thread_id) {
          const startedThreadId = event.thread_id;
          threadId = startedThreadId;
          threadStartPromise = threadStartPromise
            .then(() =>
              settleWithin(
                onThread?.(startedThreadId),
                checkpointTimeoutMs,
                `Codex thread checkpoint did not settle within ${checkpointTimeoutMs} ms`,
              ),
            )
            .catch((error) => {
              threadStartError ??= error;
              terminate();
            });
        }
        if (event.type === "turn.completed" && event.usage) {
          usage = {
            inputTokens: event.usage.input_tokens ?? 0,
            cachedInputTokens: event.usage.cached_input_tokens ?? 0,
            outputTokens: event.usage.output_tokens ?? 0,
            reasoningTokens: event.usage.reasoning_output_tokens ?? 0,
          };
        }
      }
    };

    child.stdout.on("data", (data) => consume(data.toString()));
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
      try {
        await settleWithin(
          threadStartPromise,
          checkpointTimeoutMs,
          `Codex thread checkpoint did not settle within ${checkpointTimeoutMs} ms`,
        );
      } catch (error) {
        threadStartError ??= error;
      }
      if (threadStartError) {
        reject(threadStartError);
        return;
      }
      if (timedOut) {
        reject(new CodexCliTimeoutError(`Codex exceeded its ${Math.ceil(timeoutMs)} ms turn timeout`));
        return;
      }
      if (code !== 0) {
        const diagnostic =
          extractCodexFailureMessage(stdout) ||
          stderr.trim().slice(-4000) ||
          "No diagnostic was emitted";
        reject(
          new Error(
            `Codex exited with code ${code ?? "null"} signal ${
              signal ?? "none"
            }: ${diagnostic}`,
          ),
        );
        return;
      }
      resolve({ threadId, usage, stdout, stderr });
    });
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE" && !settled) {
        settled = true;
        timer?.clear?.();
        terminate();
        unregisterProcessCleanup();
        reject(error);
      }
    });
    child.stdin.end(input);
  });
}

export class CodexCliTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "CodexCliTimeoutError";
  }
}

export function extractCodexFailureMessage(stdout = "") {
  const lines = String(stdout).split("\n").reverse();
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      const message =
        event?.error?.message ??
        (event?.type === "error" ? event?.message : "");
      if (typeof message === "string" && message.trim()) {
        return message.trim().slice(-4000);
      }
    } catch {
      // Codex JSONL can contain ordinary diagnostic lines; ignore them.
    }
  }
  return "";
}
