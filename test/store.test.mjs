import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { RunStore } from "../src/store.mjs";
import { sha256 } from "../src/utils.mjs";

test("artifact persistence removes inline payload and records its hash", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-store-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new RunStore(root);
  await store.initialize({ runId: "test", updatedAt: "", problems: [] });
  await store.prepareBranch("p1", "b1");
  const content = "exact witness: 17";
  const records = await store.persistArtifacts("p1", "b1", 1, [
    { name: "witness", kind: "counterexample", content, verification: "check exactly" },
  ]);
  assert.equal(records[0].sha256, sha256(content));
  assert.equal(records[0].content, undefined);
  const artifactPath = path.join(root, records[0].path);
  assert.equal(await readFile(artifactPath, "utf8"), content);
  if (process.platform !== "win32") {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(path.join(root, "run.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(path.join(root, "events.jsonl"))).mode & 0o777, 0o600);
    assert.equal((await stat(artifactPath)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(path.join(root, "problems", "p1", "branches", "b1", "workspace")))
        .mode & 0o777,
      0o700,
    );
  }
});

test("run lock rejects a concurrent owner and can be reacquired after release", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-lock-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = new RunStore(root);
  const second = new RunStore(root);
  await first.acquireLock();
  await assert.rejects(() => second.acquireLock(), /already active/);
  await first.releaseLock();
  await second.acquireLock();
  await second.releaseLock();
});
