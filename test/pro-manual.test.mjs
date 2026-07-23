import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ManualResponseInvalidError,
  ManualResponsePendingError,
  PRO_MANUAL_PROTOCOL,
  ProManualProvider,
  importManualResponse,
  inspectManualPacket,
  listManualPackets,
  validateAgainstSchema,
} from "../src/providers/pro-manual.mjs";

const RESULT_SCHEMA = {
  name: "manual_test_result",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["progress", "done"] },
      score: { type: "integer", minimum: 0, maximum: 5 },
      facts: { type: "array", items: { type: "string" } },
    },
    required: ["verdict", "score", "facts"],
  },
};

function request(workingDir, overrides = {}) {
  return {
    operationKey: "problem:sample:branch:one:turn:1",
    role: "solver",
    workingDir,
    instructions: "Check every claimed step.",
    prompt: "Attack the sample conjecture.",
    model: { model: "gpt-5.6-sol", mode: "pro", effort: "max" },
    schema: RESULT_SCHEMA,
    tools: { webSearch: true, codeInterpreter: true },
    timeoutMs: 1_000,
    ...overrides,
  };
}

test("Pro-manual exports one deterministic, copy-ready packet across retries", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-"));
  const queueDir = path.join(root, "queue");
  const workspace = path.join(root, "workspace");
  const started = [];
  const provider = new ProManualProvider(
    {},
    {
      queueDir,
      waitForResponse: false,
      now: () => "2026-07-23T00:00:00.000Z",
    },
  );
  const input = request(workspace, {
    onStarted: async (id) => started.push(id),
  });

  await assert.rejects(() => provider.run(input), (error) => {
    assert.ok(error instanceof ManualResponsePendingError);
    assert.equal(error.code, "AUTOPROVER_MANUAL_RESPONSE_PENDING");
    assert.equal(error.resumable, true);
    assert.match(error.message, /pro-manual-cli\.mjs import/);
    return true;
  });
  await assert.rejects(() => provider.run(input), ManualResponsePendingError);

  assert.equal(started.length, 2);
  assert.equal(started[0], started[1]);
  const packets = await listManualPackets(queueDir);
  assert.equal(packets.length, 1);
  assert.equal(packets[0].id, started[0]);
  assert.equal(packets[0].state, "waiting-for-human");

  const packet = await inspectManualPacket(packets[0].packetDir);
  assert.match(packet.prompt, /explicitly select Pro/);
  assert.match(packet.prompt, /Attack the sample conjecture/);
  assert.match(packet.prompt, /manual_test_result/);
  const persistedRequest = JSON.parse(
    await readFile(path.join(packet.packetDir, "request.json"), "utf8"),
  );
  assert.equal(persistedRequest.protocol, PRO_MANUAL_PROTOCOL);
  assert.equal(persistedRequest.requestHash, packet.requestHash);
});

test("default queue is discovered at the nearest run root", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-run-"));
  await writeFile(path.join(runDir, "run.json"), "{}\n", "utf8");
  const workspace = path.join(runDir, "problems", "sample", "branches", "one", "workspace");
  const provider = new ProManualProvider({}, { waitForResponse: false });
  let pending;
  await assert.rejects(
    () => provider.run(request(workspace)),
    (error) => {
      pending = error;
      return error instanceof ManualResponsePendingError;
    },
  );
  assert.equal(path.dirname(pending.packetDir), path.join(runDir, "manual-pro"));
});

test("atomic manual import lets a waiting provider continue with schema-checked data", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-"));
  const queueDir = path.join(root, "queue");
  const provider = new ProManualProvider({}, { queueDir, pollIntervalMs: 5 });
  let packetDir;
  const output = {
    verdict: "progress",
    score: 4,
    facts: ["The finite case n=2 checks out."],
  };

  const result = await provider.run(
    request(path.join(root, "workspace"), {
      onStarted: async (id) => {
        packetDir = path.join(queueDir, id);
        await importManualResponse(
          packetDir,
          `\`\`\`json\n${JSON.stringify(output)}\n\`\`\``,
          {
            sourceUrl: "https://chatgpt.com/share/example",
            note: "Copied by the operator",
          },
        );
      },
    }),
  );

  assert.deepEqual(result.data, output);
  assert.equal(result.sessionId, path.basename(packetDir));
  assert.deepEqual(result.usage, {
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
  });
  assert.equal(result.evidence[0].type, "manual_import");
  assert.equal(result.evidence[0].source.kind, "manual-import");
  assert.equal(result.evidence[0].source.url, "https://chatgpt.com/share/example");
  const status = JSON.parse(await readFile(path.join(packetDir, "status.json"), "utf8"));
  assert.equal(status.state, "completed");
});

test("resumeId consumes the original packet when the regenerated prompt changes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-resume-"));
  const queueDir = path.join(root, "queue");
  const provider = new ProManualProvider(
    {},
    { queueDir, waitForResponse: false },
  );
  let packetId;
  const original = request(path.join(root, "workspace"), {
    prompt: "Check the open status as of 2026-07-23.",
    onStarted: async (id) => {
      packetId = id;
    },
  });
  await assert.rejects(
    () => provider.run(original),
    ManualResponsePendingError,
  );
  await importManualResponse(
    path.join(queueDir, packetId),
    JSON.stringify({ verdict: "done", score: 5, facts: ["Checked."] }),
  );

  let resumedId;
  const result = await provider.run(
    request(path.join(root, "workspace"), {
      prompt: "Check the open status as of 2026-07-24.",
      resumeId: packetId,
      onStarted: async (id) => {
        resumedId = id;
      },
    }),
  );

  assert.equal(resumedId, packetId);
  assert.deepEqual(result.data, {
    verdict: "done",
    score: 5,
    facts: ["Checked."],
  });
  assert.equal((await listManualPackets(queueDir)).length, 1);
  const persistedPrompt = await readFile(
    path.join(queueDir, packetId, "prompt.md"),
    "utf8",
  );
  assert.match(persistedPrompt, /2026-07-23/);
  assert.doesNotMatch(persistedPrompt, /2026-07-24/);
});

test("resumeId is queue-local and cannot resume a different operation", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-resume-"));
  const queueDir = path.join(root, "queue");
  const provider = new ProManualProvider(
    {},
    { queueDir, waitForResponse: false },
  );
  const workspace = path.join(root, "workspace");

  for (const resumeId of ["../escape", "/tmp/escape", " packet-id"]) {
    await assert.rejects(
      () => provider.run(request(workspace, { resumeId })),
      /resumeId.*(packet id|queue-local)/,
    );
  }

  let packetId;
  await assert.rejects(
    () =>
      provider.run(
        request(workspace, {
          onStarted: async (id) => {
            packetId = id;
          },
        }),
      ),
    ManualResponsePendingError,
  );
  await assert.rejects(
    () =>
      provider.run(
        request(workspace, {
          operationKey: "different:operation",
          resumeId: packetId,
        }),
      ),
    /different operation/,
  );
});

test("manual responses are single-assignment after import or completion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-import-"));
  const queueDir = path.join(root, "queue");
  const provider = new ProManualProvider(
    {},
    { queueDir, waitForResponse: false },
  );
  const input = request(path.join(root, "workspace"));
  const packet = await provider.preparePacket(input);
  const first = JSON.stringify({
    verdict: "progress",
    score: 3,
    facts: ["First answer."],
  });
  await importManualResponse(packet.packetDir, first);
  await assert.rejects(
    () =>
      importManualResponse(
        packet.packetDir,
        JSON.stringify({
          verdict: "done",
          score: 5,
          facts: ["Replacement answer."],
        }),
      ),
    /already response-imported.*cannot be imported again/,
  );
  assert.equal(
    JSON.parse(
      await readFile(path.join(packet.packetDir, "response.json"), "utf8"),
    ).output,
    first,
  );

  await provider.run({ ...input, resumeId: packet.id });
  await assert.rejects(
    () => importManualResponse(packet.packetDir, first),
    /already completed.*cannot be imported again/,
  );
});

test("manual import refuses schema-invalid output without publishing it", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-"));
  const queueDir = path.join(root, "queue");
  const provider = new ProManualProvider({}, { queueDir, waitForResponse: false });
  let packetDir;
  await assert.rejects(
    () =>
      provider.run(
        request(path.join(root, "workspace"), {
          onStarted: async (id) => {
            packetDir = path.join(queueDir, id);
          },
        }),
      ),
    ManualResponsePendingError,
  );

  await assert.rejects(
    () =>
      importManualResponse(
        packetDir,
        JSON.stringify({ verdict: "done", score: 99, facts: [], surprise: true }),
      ),
    /does not match.*score must be at most 5.*surprise is not allowed/,
  );
  await assert.rejects(
    () => readFile(path.join(packetDir, "response.json"), "utf8"),
    { code: "ENOENT" },
  );
});

test("provider rejects a tampered response envelope and leaves a resumable diagnosis", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-"));
  const queueDir = path.join(root, "queue");
  const provider = new ProManualProvider({}, { queueDir, waitForResponse: false });
  const input = request(path.join(root, "workspace"));
  const packet = await provider.preparePacket(input);
  await writeFile(
    path.join(packet.packetDir, "response.json"),
    `${JSON.stringify({
      protocol: PRO_MANUAL_PROTOCOL,
      packetId: "different-packet",
      requestHash: packet.requestHash,
      importedAt: "2026-07-23T00:00:00.000Z",
      source: { kind: "chatgpt-pro-manual", url: null, note: null },
      outputSha256: "not-valid",
      output: JSON.stringify({ verdict: "done", score: 5, facts: [] }),
    })}\n`,
    "utf8",
  );

  await assert.rejects(() => provider.run(input), (error) => {
    assert.ok(error instanceof ManualResponseInvalidError);
    assert.equal(error.resumable, true);
    assert.match(error.message, /packetId does not match/);
    return true;
  });
  const status = JSON.parse(await readFile(path.join(packet.packetDir, "status.json"), "utf8"));
  assert.equal(status.state, "invalid-response");

  await importManualResponse(
    packet.packetDir,
    JSON.stringify({ verdict: "done", score: 5, facts: ["Repaired."] }),
  );
  const repaired = await provider.run({ ...input, resumeId: packet.id });
  assert.deepEqual(repaired.data, {
    verdict: "done",
    score: 5,
    facts: ["Repaired."],
  });
});

test("the embedded schema validator handles nested strict objects and oneOf", () => {
  const schema = {
    type: "object",
    additionalProperties: false,
    properties: {
      item: {
        oneOf: [
          { type: "string", minLength: 2 },
          { type: "integer", minimum: 3 },
        ],
      },
    },
    required: ["item"],
  };
  assert.deepEqual(validateAgainstSchema({ item: "ok" }, schema), []);
  assert.deepEqual(validateAgainstSchema({ item: 4 }, schema), []);
  assert.match(validateAgainstSchema({ item: 1 }, schema).join("; "), /exactly one/);
  assert.match(validateAgainstSchema({ item: "ok", extra: true }, schema).join("; "), /not allowed/);
});
