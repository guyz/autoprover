import assert from "node:assert/strict";
import test from "node:test";
import {
  pinResumeProvider,
  validateCommandFlags,
  validateUniqueProblemIds,
} from "../src/cli.mjs";

test("CLI rejects misspelled live-run flags", () => {
  assert.throws(
    () => validateCommandFlags("run", { "max-call": "1" }, []),
    /Unknown flag.*--max-call/,
  );
});

test("CLI accepts explicit confirmation but rejects extra positionals", () => {
  assert.doesNotThrow(() => validateCommandFlags("run", { yes: true, hours: "12" }, []));
  assert.doesNotThrow(() =>
    validateCommandFlags("smoke", { yes: true, provider: "fable" }, []),
  );
  assert.throws(() => validateCommandFlags("run", { yes: true }, ["surprise"]), /Unexpected positional/);
});

test("resume rejects the new-run-only --hours flag", () => {
  assert.throws(
    () =>
      validateCommandFlags(
        "resume",
        { "run-dir": "runs/sample", hours: "24", yes: true },
        [],
      ),
    /Unknown flag.*--hours/,
  );
  assert.doesNotThrow(() =>
    validateCommandFlags(
      "resume",
      { "run-dir": "runs/sample", "extend-hours": "12", yes: true },
      [],
    ),
  );
});

test("campaign accepts persistent-loop controls and rejects unknown flags", () => {
  assert.doesNotThrow(() =>
    validateCommandFlags(
      "campaign",
      {
        yes: true,
        hours: "24",
        "parallel-problems": "3",
        "max-cycles": "0",
      },
      [],
    ),
  );
  assert.doesNotThrow(() =>
    validateCommandFlags(
      "campaign",
      {
        yes: true,
        resume: true,
        "extend-hours": "12",
        "campaign-dir": "runs/campaigns/default",
      },
      [],
    ),
  );
  assert.throws(
    () => validateCommandFlags("campaign", { "max-cycle": "1" }, []),
    /Unknown flag.*--max-cycle/,
  );
});

test("resume pins auto provider selection to the run's stored provider", () => {
  const original = { provider: "auto", maxCalls: 10 };
  const pinned = pinResumeProvider(original, "codex");
  assert.equal(pinned.provider, "max");
  assert.equal(original.provider, "auto");
});

test("resume rejects an incompatible provider override", () => {
  assert.throws(
    () => pinResumeProvider({ provider: "responses" }, "codex"),
    /pinned to the max provider.*cannot be resumed with pro/,
  );
  assert.throws(
    () => pinResumeProvider({ provider: "auto" }, undefined),
    /invalid resolved provider: missing/,
  );
});

test("problem validation detects ids that collide after slug normalization", () => {
  assert.throws(
    () => validateUniqueProblemIds([{ id: "Foo Bar" }, { id: "foo-bar" }]),
    /Duplicate problem id after normalization: foo-bar/,
  );
  assert.doesNotThrow(() => validateUniqueProblemIds([{ id: "first" }, { id: "second" }]));
});
