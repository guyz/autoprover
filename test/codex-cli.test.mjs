import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexCliProvider,
  buildCodexEnvironment,
  extractCodexFailureMessage,
  resolveCodexBinary,
  runProcess,
} from "../src/providers/codex-cli.mjs";

test("subscription-backed Max strips API billing credentials", () => {
  const env = buildCodexEnvironment({
    subscriptionOnly: true,
    baseEnv: {
      PATH: "/bin",
      OPENAI_API_KEY: "secret",
      CODEX_API_KEY: "secret",
      OPENAI_BASE_URL: "https://api.example",
      OPENAI_ORG_ID: "org",
      OPENAI_PROJECT_ID: "project",
      CODEX_HOME: "/safe/auth",
      AWS_SECRET_ACCESS_KEY: "aws-secret",
      DATABASE_URL: "postgres://secret",
      GH_TOKEN: "github-secret",
      AUTOPROVER_CONFIRM: "1",
      NODE_OPTIONS: "--require=/tmp/inject.cjs",
    },
  });
  assert.equal(env.PATH, "/bin");
  assert.equal(env.CODEX_HOME, "/safe/auth");
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.CODEX_API_KEY, undefined);
  assert.equal(env.OPENAI_BASE_URL, undefined);
  assert.equal(env.OPENAI_ORG_ID, undefined);
  assert.equal(env.OPENAI_PROJECT_ID, undefined);
  assert.equal(env.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.GH_TOKEN, undefined);
  assert.equal(env.AUTOPROVER_CONFIRM, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
});

test("macOS prefers the ChatGPT-bundled Codex binary to keep the shared model cache compatible", () => {
  assert.equal(
    resolveCodexBinary("codex", {
      platform: "darwin",
      exists: () => true,
    }),
    "/Applications/ChatGPT.app/Contents/Resources/codex",
  );
  assert.equal(
    resolveCodexBinary("/custom/codex", {
      platform: "darwin",
      exists: () => true,
    }),
    "/custom/codex",
  );
  assert.equal(
    resolveCodexBinary("codex", {
      platform: "linux",
      exists: () => true,
    }),
    "codex",
  );
});

test("Codex JSONL failures expose the useful model/API diagnostic", () => {
  const message = extractCodexFailureMessage(
    [
      JSON.stringify({ type: "thread.started", thread_id: "thread-test" }),
      JSON.stringify({
        type: "turn.failed",
        error: { message: "Invalid structured output schema" },
      }),
    ].join("\n"),
  );
  assert.equal(message, "Invalid structured output schema");
});

test("Max provider keeps schemas and outputs private", async (t) => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-codex-provider-"),
  );
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let schemaPath;
  let outputPath;
  const provider = new CodexCliProvider(
    {
      codex: {
        binary: "codex",
        effort: "max",
        sandbox: "workspace-write",
        subscriptionOnly: true,
        turnTimeoutMinutes: 1,
      },
    },
    {
      processRunner: async ({ args, env, input }) => {
        schemaPath = args[args.indexOf("--output-schema") + 1];
        outputPath = args[args.indexOf("-o") + 1];
        assert.equal(input, "System policy.\n\nReturn the answer.");
        assert.equal(args.includes("--ignore-user-config"), true);
        assert.equal(
          args.includes("sandbox_workspace_write.network_access=true"),
          true,
        );
        assert.equal(env.OPENAI_API_KEY, undefined);
        if (process.platform !== "win32") {
          assert.equal((await stat(schemaPath)).mode & 0o777, 0o600);
          assert.equal((await stat(path.dirname(schemaPath))).mode & 0o777, 0o700);
        }
        await writeFile(outputPath, '{"answer":42}\n', {
          encoding: "utf8",
          mode: 0o644,
        });
        return {
          threadId: "thread-test",
          usage: {},
          stdout: "",
          stderr: "",
        };
      },
    },
  );

  const result = await provider.run({
    operationKey: "private-output",
    instructions: "System policy.",
    prompt: "Return the answer.",
    model: { model: "gpt-5.6-sol", effort: "max" },
    schema: {
      name: "answer",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { answer: { type: "integer" } },
        required: ["answer"],
      },
    },
    workingDir: workspace,
    timeoutMs: 2_000,
  });

  assert.deepEqual(result.data, { answer: 42 });
  if (process.platform !== "win32") {
    assert.equal((await stat(outputPath)).mode & 0o777, 0o600);
  }
});

test("Max resume calls remain isolated from personal browser plugins", async (t) => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-codex-resume-"),
  );
  t.after(() => rm(workspace, { recursive: true, force: true }));
  let capturedArgs;
  const provider = new CodexCliProvider(
    {
      codex: {
        binary: "codex",
        effort: "max",
        sandbox: "workspace-write",
        subscriptionOnly: true,
        turnTimeoutMinutes: 1,
      },
    },
    {
      processRunner: async ({ args }) => {
        capturedArgs = args;
        const outputPath = args[args.indexOf("-o") + 1];
        await writeFile(outputPath, '{"answer":42}\n', "utf8");
        return {
          threadId: "thread-existing",
          usage: {},
          stdout: "",
          stderr: "",
        };
      },
    },
  );

  await provider.run({
    operationKey: "isolated-resume",
    instructions: "System policy.",
    prompt: "Continue.",
    model: { model: "gpt-5.6-sol", effort: "max" },
    schema: {
      name: "answer",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { answer: { type: "integer" } },
        required: ["answer"],
      },
    },
    workingDir: workspace,
    resumeId: "thread-existing",
    timeoutMs: 2_000,
  });

  assert.deepEqual(capturedArgs.slice(0, 7), [
    "--search",
    "exec",
    "--ignore-user-config",
    "-c",
    "sandbox_workspace_write.network_access=true",
    "resume",
    "thread-existing",
  ]);
});

test("Max solver turns use Ultra with built-in subagents while other roles keep their configured effort", async (t) => {
  const workspace = await mkdtemp(
    path.join(os.tmpdir(), "autoprover-codex-ultra-"),
  );
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const captured = [];
  const provider = new CodexCliProvider(
    {
      codex: {
        binary: "codex",
        effort: "ultra",
        sandbox: "workspace-write",
        subscriptionOnly: true,
        turnTimeoutMinutes: 1,
      },
    },
    {
      processRunner: async ({ args }) => {
        captured.push(args);
        const outputPath = args[args.indexOf("-o") + 1];
        await writeFile(outputPath, '{"answer":42}\n', "utf8");
        return {
          threadId: `thread-${captured.length}`,
          usage: {},
          stdout: "",
          stderr: "",
        };
      },
    },
  );
  const baseRequest = {
    operationKey: "ultra-role",
    instructions: "System policy.",
    prompt: "Work.",
    model: { model: "gpt-5.6-sol", effort: "high" },
    schema: {
      name: "answer",
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { answer: { type: "integer" } },
        required: ["answer"],
      },
    },
    workingDir: workspace,
    timeoutMs: 2_000,
  };

  await provider.run({ ...baseRequest, role: "solver" });
  await provider.run({
    ...baseRequest,
    role: "scout",
    operationKey: "scout-role",
  });

  assert.ok(
    captured[0].includes('model_reasoning_effort="ultra"'),
  );
  assert.deepEqual(
    captured[0].slice(
      captured[0].indexOf("--enable"),
      captured[0].indexOf("--enable") + 2,
    ),
    ["--enable", "multi_agent"],
  );
  assert.ok(
    captured[1].includes('model_reasoning_effort="high"'),
  );
  assert.equal(captured[1].includes("--enable"), false);
});

test("runProcess rejects when the asynchronous thread checkpoint fails", async () => {
  const childScript = [
    "console.log(JSON.stringify({ type: 'thread.started', thread_id: 'thread-test' }));",
    "setInterval(() => {}, 1000);",
  ].join("\n");

  await assert.rejects(
    () =>
      runProcess({
        binary: process.execPath,
        args: ["-e", childScript],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        onThread: async () => {
          throw new Error("checkpoint write failed");
        },
      }),
    /checkpoint write failed/,
  );
});

test("runProcess terminates a worker whose thread checkpoint hangs", async () => {
  const childScript = [
    "console.log(JSON.stringify({type:'thread.started', thread_id:'thread-test'}));",
    "setInterval(() => {}, 1000);",
  ].join("\n");
  await assert.rejects(
    () =>
      runProcess({
        binary: process.execPath,
        args: ["-e", childScript],
        cwd: process.cwd(),
        timeoutMs: 2_000,
        checkpointTimeoutMs: 20,
        onThread: () => new Promise(() => {}),
      }),
    /checkpoint did not settle/,
  );
});
