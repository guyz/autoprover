import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClaudeCliProvider,
  ClaudeCliResultError,
  ClaudeCliTimeoutError,
  buildClaudeArgs,
  buildClaudeEnvironment,
  extractClaudeResult,
  normalizeClaudeEffort,
  parseClaudeStream,
  runClaudeProcess,
} from "../src/providers/claude-cli.mjs";

const SYSTEM_PROMPT_PATH = "/private/claude-system-prompt.txt";

const schema = {
  name: "answer",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { answer: { type: "integer" } },
    required: ["answer"],
  },
};

function request(overrides = {}) {
  return {
    model: { model: "gpt-5.6-sol", effort: "xhigh", mode: "pro" },
    instructions: "Research carefully.",
    prompt: "Return the answer.",
    schema,
    workingDir: process.cwd(),
    ...overrides,
  };
}

test("buildClaudeArgs selects local Fable 5, max effort, schema, and a new session", () => {
  const args = buildClaudeArgs({
    request: request(),
    claudeConfig: {},
    allocatedSessionId: "12345678-1234-4234-8234-123456789abc",
    systemPromptPath: SYSTEM_PROMPT_PATH,
  });

  assert.deepEqual(args.slice(0, 4), [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  assert.equal(args[args.indexOf("--model") + 1], "claude-fable-5");
  assert.equal(args[args.indexOf("--effort") + 1], "max");
  assert.equal(args[args.indexOf("--permission-mode") + 1], "auto");
  assert.deepEqual(
    JSON.parse(args[args.indexOf("--json-schema") + 1]),
    schema.schema,
  );
  assert.equal(
    args[args.indexOf("--session-id") + 1],
    "12345678-1234-4234-8234-123456789abc",
  );
  assert.ok(!args.includes("--resume"));
  assert.ok(!args.includes("Return the answer."));
  assert.ok(!args.includes("Research carefully."));
  assert.equal(
    args[args.indexOf("--append-system-prompt-file") + 1],
    SYSTEM_PROMPT_PATH,
  );
  assert.ok(args.includes("--safe-mode"));
});

test("buildClaudeArgs preserves an explicit Claude model and resumes its session", () => {
  const args = buildClaudeArgs({
    request: request({
      model: { model: "claude-fable-5[1m]", effort: "high" },
      sessionId: "existing-session",
    }),
    claudeConfig: { permissionMode: "bypassPermissions" },
    allocatedSessionId: "unused",
    systemPromptPath: SYSTEM_PROMPT_PATH,
  });

  assert.equal(args[args.indexOf("--model") + 1], "claude-fable-5[1m]");
  assert.equal(args[args.indexOf("--effort") + 1], "high");
  assert.equal(args[args.indexOf("--resume") + 1], "existing-session");
  assert.ok(args.includes("--dangerously-skip-permissions"));
  assert.ok(!args.includes("--session-id"));
});

test("buildClaudeArgs respects per-call web and code tool restrictions", () => {
  const args = buildClaudeArgs({
    request: request({
      tools: { webSearch: false, codeInterpreter: false },
    }),
    claudeConfig: {},
    allocatedSessionId: "12345678-1234-4234-8234-123456789abc",
    systemPromptPath: SYSTEM_PROMPT_PATH,
  });

  assert.equal(
    args[args.indexOf("--disallowedTools") + 1],
    "WebSearch,WebFetch,Bash,Write,Edit,NotebookEdit",
  );
});

test("Claude effort levels map onto the CLI's supported values", () => {
  assert.equal(normalizeClaudeEffort("none"), "low");
  assert.equal(normalizeClaudeEffort("medium"), "medium");
  assert.equal(normalizeClaudeEffort("high"), "high");
  assert.equal(normalizeClaudeEffort("xhigh"), "max");
  assert.equal(normalizeClaudeEffort("max"), "max");
});

test("subscription-backed Fable receives only auth-safe environment variables", () => {
  const environment = buildClaudeEnvironment({
    subscriptionOnly: true,
    cwd: "/research/workspace",
    baseEnv: {
      PATH: "/bin",
      HOME: "/Users/researcher",
      TMPDIR: "/private/tmp",
      LANG: "en_US.UTF-8",
      LC_NUMERIC: "C",
      CLAUDE_CONFIG_DIR: "/Users/researcher/.claude",
      ANTHROPIC_API_KEY: "anthropic-secret",
      OPENAI_API_KEY: "openai-secret",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      DATABASE_URL: "postgres://secret",
      GH_TOKEN: "github-secret",
      AUTOPROVER_CONFIRM: "1",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
    },
  });

  assert.deepEqual(environment, {
    PATH: "/bin",
    HOME: "/Users/researcher",
    TMPDIR: "/private/tmp",
    LANG: "en_US.UTF-8",
    LC_NUMERIC: "C",
    CLAUDE_CONFIG_DIR: "/Users/researcher/.claude",
    NO_COLOR: "1",
    PWD: "/research/workspace",
  });
});

test("parseClaudeStream extracts structured output, usage, session, and tool evidence", () => {
  const stdout = [
    JSON.stringify({
      type: "system",
      subtype: "init",
      session_id: "session-fable",
    }),
    JSON.stringify({
      type: "assistant",
      message: {
        usage: {
          input_tokens: 10,
          cache_read_input_tokens: 4,
          cache_creation_input_tokens: 3,
          output_tokens: 7,
        },
        content: [
          {
            type: "tool_use",
            id: "tool-1",
            name: "WebSearch",
            input: { query: "open problem" },
          },
        ],
      },
    }),
    "benign diagnostic",
    JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "session-fable",
      structured_output: { answer: 42 },
      usage: {
        input_tokens: 20,
        cache_read_input_tokens: 8,
        cache_creation_input_tokens: 5,
        output_tokens: 11,
        thinking_tokens: 6,
      },
    }),
  ].join("\n");

  const parsed = parseClaudeStream(stdout);
  assert.equal(parsed.sessionId, "session-fable");
  assert.deepEqual(parsed.diagnostics, ["benign diagnostic"]);
  assert.deepEqual(parsed.usage, {
    inputTokens: 20,
    cachedInputTokens: 8,
    cacheWriteTokens: 5,
    outputTokens: 11,
    reasoningTokens: 6,
  });
  assert.deepEqual(parsed.evidence, [
    {
      type: "tool_use",
      id: "tool-1",
      name: "WebSearch",
      input: { query: "open problem" },
    },
  ]);
  assert.deepEqual(extractClaudeResult(parsed.resultEvent), {
    data: { answer: 42 },
    rawText: '{"answer":42}',
  });
});

test("extractClaudeResult accepts fenced JSON from older Claude Code versions", () => {
  assert.deepEqual(
    extractClaudeResult({
      result: "Finished.\n```json\n{\"answer\": 9}\n```",
    }).data,
    { answer: 9 },
  );
});

test("provider uses a private system-prompt file and removes it after each turn", async (t) => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-claude-provider-"),
  );
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const outputs = [
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "terminal-session",
      structured_output: { answer: 42 },
      usage: {},
    })}\n`,
    `${JSON.stringify({
      type: "result",
      subtype: "error",
      is_error: true,
      session_id: "failed-session",
      result: "rate limit reached",
    })}\n`,
  ];
  let call = 0;
  const started = [];
  const systemPromptPaths = [];
  const provider = new ClaudeCliProvider(
    {
      claude: {
        binary: "claude",
        defaultModel: "claude-fable-5",
        turnTimeoutMinutes: 1,
      },
    },
    {
      processRunner: async ({ args, input, subscriptionOnly }) => {
        assert.equal(input, "Return the answer.\n");
        assert.equal(subscriptionOnly, true);
        assert.ok(!args.includes("Research carefully."));
        const systemPromptPath =
          args[args.indexOf("--append-system-prompt-file") + 1];
        systemPromptPaths.push(systemPromptPath);
        assert.equal(await readFile(systemPromptPath, "utf8"), "Research carefully.");
        if (process.platform !== "win32") {
          assert.equal((await stat(systemPromptPath)).mode & 0o777, 0o600);
          assert.equal(
            (await stat(path.dirname(systemPromptPath))).mode & 0o777,
            0o700,
          );
        }
        return { stdout: outputs[call++], stderr: "" };
      },
    },
  );

  const result = await provider.run(
    request({
      workingDir: workspace,
      onStarted: async (id) => started.push(id),
    }),
  );
  assert.equal(result.sessionId, "terminal-session");
  assert.deepEqual(result.data, { answer: 42 });
  assert.deepEqual(started, ["terminal-session"]);
  await assert.rejects(() => access(systemPromptPaths[0]), { code: "ENOENT" });

  await assert.rejects(
    () => provider.run(request({ workingDir: workspace })),
    ClaudeCliResultError,
  );
  await assert.rejects(() => access(systemPromptPaths[1]), { code: "ENOENT" });
});

test("runClaudeProcess streams the prompt and checkpoints the announced session", async () => {
  const childScript = [
    "let input = '';",
    "process.stdin.on('data', chunk => input += chunk);",
    "process.stdin.on('end', () => {",
    "  console.log(JSON.stringify({type:'system', subtype:'init', session_id:'stream-session'}));",
    "  console.log(JSON.stringify({type:'result', subtype:'success', session_id:'stream-session', structured_output:{received:input.trim()}}));",
    "});",
  ].join("\n");
  const announced = [];

  const result = await runClaudeProcess({
    binary: process.execPath,
    args: ["-e", childScript],
    cwd: process.cwd(),
    input: "private prompt\n",
    timeoutMs: 2_000,
    onSession: async (id) => announced.push(id),
  });

  assert.deepEqual(announced, ["stream-session"]);
  const parsed = parseClaudeStream(result.stdout);
  assert.deepEqual(parsed.resultEvent.structured_output, {
    received: "private prompt",
  });
});

test("runClaudeProcess rejects when session checkpointing fails", async () => {
  const childScript = [
    "console.log(JSON.stringify({type:'system', subtype:'init', session_id:'stream-session'}));",
    "setTimeout(() => {}, 100);",
  ].join("\n");

  await assert.rejects(
    () =>
      runClaudeProcess({
        binary: process.execPath,
        args: ["-e", childScript],
        cwd: process.cwd(),
        input: "",
        timeoutMs: 2_000,
        onSession: async () => {
          throw new Error("checkpoint failed");
        },
      }),
    /checkpoint failed/,
  );
});

test("runClaudeProcess terminates a hung process at the turn deadline", async () => {
  await assert.rejects(
    () =>
      runClaudeProcess({
        binary: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
        cwd: process.cwd(),
        input: "",
        timeoutMs: 30,
      }),
    ClaudeCliTimeoutError,
  );
});

test("runClaudeProcess terminates a worker whose session checkpoint hangs", async () => {
  const childScript = [
    "console.log(JSON.stringify({type:'system', session_id:'stream-session'}));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  await assert.rejects(
    () =>
      runClaudeProcess({
        binary: process.execPath,
        args: ["-e", childScript],
        cwd: process.cwd(),
        input: "",
        timeoutMs: 2_000,
        checkpointTimeoutMs: 20,
        onSession: () => new Promise(() => {}),
      }),
    /checkpoint did not settle/,
  );
});
