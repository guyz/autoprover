import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildSubscriptionChildEnvironment,
  registerChildProcessCleanup,
} from "../src/providers/child-runtime.mjs";

test("subscription child environment preserves runtime/auth homes and drops secrets", () => {
  const environment = buildSubscriptionChildEnvironment(
    {
      Path: "C:\\tools",
      HOME: "/Users/researcher",
      TMPDIR: "/tmp/private",
      LANG: "en_US.UTF-8",
      LC_TIME: "C",
      CODEX_HOME: "/Users/researcher/.codex",
      CLAUDE_CONFIG_DIR: "/Users/researcher/.claude",
      OPENAI_API_KEY: "openai-secret",
      ANTHROPIC_AUTH_TOKEN: "anthropic-secret",
      AWS_ACCESS_KEY_ID: "aws-secret",
      AZURE_CLIENT_SECRET: "azure-secret",
      DATABASE_URL: "postgres://secret",
      REDIS_URL: "redis://secret",
      GITHUB_TOKEN: "github-secret",
      LC_API_TOKEN: "locale-shaped-secret",
      BASH_ENV: "/tmp/inject",
      LD_PRELOAD: "/tmp/inject.so",
    },
    { NO_COLOR: "1" },
  );

  assert.deepEqual(environment, {
    Path: "C:\\tools",
    HOME: "/Users/researcher",
    TMPDIR: "/tmp/private",
    LANG: "en_US.UTF-8",
    LC_TIME: "C",
    CODEX_HOME: "/Users/researcher/.codex",
    CLAUDE_CONFIG_DIR: "/Users/researcher/.claude",
    NO_COLOR: "1",
  });
});

test("child cleanup forwards termination and restores normal signal handling", () => {
  class FakeProcess extends EventEmitter {
    pid = 123;
    signals = [];

    kill(pid, signal) {
      this.signals.push({ pid, signal });
      return true;
    }
  }

  const processRef = new FakeProcess();
  const cleaned = [];
  registerChildProcessCleanup(
    (signal) => cleaned.push(signal),
    { processRef },
  );

  processRef.emit("SIGTERM");
  assert.deepEqual(cleaned, ["SIGTERM"]);
  assert.deepEqual(processRef.signals, [{ pid: 123, signal: "SIGTERM" }]);
  assert.equal(processRef.listenerCount("SIGINT"), 0);
  assert.equal(processRef.listenerCount("SIGTERM"), 0);
  assert.equal(processRef.listenerCount("exit"), 0);
});
