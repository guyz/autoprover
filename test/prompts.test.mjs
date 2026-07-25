import assert from "node:assert/strict";
import test from "node:test";
import { BASE_RESEARCH_POLICY } from "../src/prompts.mjs";

test("research workers acquire machine-readable artifacts without a user browser", () => {
  assert.match(
    BASE_RESEARCH_POLICY,
    /do not use an interactive browser to download public datasets/i,
  );
  assert.match(BASE_RESEARCH_POLICY, /inside the branch workspace/i);
  assert.match(BASE_RESEARCH_POLICY, /source URL, byte size, and SHA-256 digest/i);
  assert.match(BASE_RESEARCH_POLICY, /Never bypass authentication/i);
  assert.match(
    BASE_RESEARCH_POLICY,
    /If an interactive browser blocks a download, do not retry or route around/i,
  );
});
