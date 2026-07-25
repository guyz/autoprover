import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  buildSubscriptionChildEnvironment,
  createSuspensionAwareTimeout,
  registerChildProcessCleanup,
} from "../src/providers/child-runtime.mjs";
import { advanceActiveClock } from "../src/utils.mjs";

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

test("model turn timeout ignores machine suspension but counts active ticks", () => {
  let now = 0;
  let tick;
  let fired = 0;
  const timer = createSuspensionAwareTimeout(
    () => {
      fired += 1;
    },
    100,
    {
      now: () => now,
      tickMs: 10,
      suspensionThresholdMs: 50,
      setIntervalFn: (callback) => {
        tick = callback;
        return { unref() {} };
      },
      clearIntervalFn() {},
    },
  );

  now = 40;
  tick();
  assert.equal(fired, 0);
  now = 10_040;
  tick();
  assert.equal(
    fired,
    0,
    "a ten-second sleep should consume only one active tick",
  );
  now = 10_090;
  tick();
  assert.equal(fired, 1);
  timer.clear();
});

test("campaign active time extends its deadline across machine sleep", () => {
  const start = Date.parse("2026-07-25T00:00:00.000Z");
  const deadline = new Date(start + 24 * 60 * 60 * 1_000).toISOString();
  const advanced = advanceActiveClock(
    {
      lastHeartbeatAt: new Date(start).toISOString(),
      suspendedMs: 0,
    },
    deadline,
    {
      nowMs: start + 6 * 60 * 60 * 1_000,
      suspensionThresholdMs: 120_000,
      expectedTickMs: 1_000,
    },
  );
  assert.equal(
    Date.parse(advanced.deadlineAt) - Date.parse(deadline),
    6 * 60 * 60 * 1_000 - 1_000,
  );
  assert.equal(advanced.clock.suspendedMs, advanced.suspendedMs);
});
