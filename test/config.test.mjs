import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  loadConfig,
  resolveProviderName,
  validateConfig,
} from "../src/config.mjs";

test("an absent default config is allowed but a malformed one is rejected", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-config-"));
  const previousCwd = process.cwd();
  t.after(async () => {
    process.chdir(previousCwd);
    await rm(root, { recursive: true, force: true });
  });
  process.chdir(root);

  const defaults = await loadConfig();
  assert.equal(defaults.provider, "auto");

  await writeFile(path.join(root, "config.json"), "{ malformed", "utf8");
  await assert.rejects(() => loadConfig(), SyntaxError);
});

test("auto selection remains subscription-backed with an ambient API key", async () => {
  const previous = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "ambient-test-key";
  try {
    assert.equal(resolveProviderName({ provider: "auto" }), "max");
    assert.equal(resolveProviderName({ provider: "pro" }), "pro");
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
  }
});

test("count limits are integers while duration and cost limits may be fractional", async () => {
  const config = await loadConfig(null, {});
  assert.throws(
    () => validateConfig({ ...config, parallelProblems: 1.5 }),
    /parallelProblems must be a positive integer/,
  );
  assert.throws(
    () => validateConfig({ ...config, maxRepairCycles: 0.5 }),
    /maxRepairCycles must be a non-negative integer/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        discovery: { ...config.discovery, attackCount: 1.5 },
      }),
    /discovery.attackCount must be a positive integer/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        responses: { ...config.responses, maxOutputTokens: 100.5 },
      }),
    /responses.maxOutputTokens must be a positive integer/,
  );
  assert.doesNotThrow(() =>
    validateConfig({
      ...config,
      wallClockHours: 0.5,
      maxEstimatedUsd: 0.25,
      roundCooldownSeconds: 0.1,
    }),
  );
});

test("Max and Fable configs cannot disable subscription-only authentication", async () => {
  const config = await loadConfig(null, {});
  assert.throws(
    () =>
      validateConfig({
        ...config,
        codex: { ...config.codex, subscriptionOnly: false },
      }),
    /codex.subscriptionOnly must be true/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        claude: { ...config.claude, subscriptionOnly: false },
      }),
    /claude.subscriptionOnly must be true/,
  );
});

test("Claude permission modes match the installed CLI vocabulary", async () => {
  const config = await loadConfig(null, {});
  assert.doesNotThrow(() =>
    validateConfig({
      ...config,
      claude: { ...config.claude, permissionMode: "manual" },
    }),
  );
  assert.throws(
    () =>
      validateConfig({
        ...config,
        claude: { ...config.claude, permissionMode: "default" },
      }),
    /claude.permissionMode is invalid/,
  );
});
