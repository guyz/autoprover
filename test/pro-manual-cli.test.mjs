import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { main } from "../src/pro-manual-cli.mjs";
import {
  ManualResponsePendingError,
  ProManualProvider,
  queueDirForRun,
} from "../src/providers/pro-manual.mjs";

function outputSink() {
  return {
    value: "",
    write(chunk) {
      this.value += String(chunk);
    },
  };
}

const schema = {
  name: "cli_result",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: { answer: { type: "string" } },
    required: ["answer"],
  },
};

test("manual Pro CLI lists, shows, and imports a queued packet", async () => {
  const runDir = await mkdtemp(path.join(os.tmpdir(), "autoprover-manual-cli-"));
  const queueDir = queueDirForRun(runDir);
  const provider = new ProManualProvider({}, { queueDir, waitForResponse: false });
  let packetDir;
  const request = {
    operationKey: "cli:sample",
    role: "critic",
    workingDir: path.join(runDir, "workspace"),
    instructions: "Be exact.",
    prompt: "Verify the claimed equality.",
    model: { model: "gpt-5.6-sol", mode: "pro", effort: "max" },
    schema,
    timeoutMs: 1_000,
    onStarted: async (id) => {
      packetDir = path.join(queueDir, id);
    },
  };
  await assert.rejects(() => provider.run(request), ManualResponsePendingError);

  const listOutput = outputSink();
  await main(["list", "--run-dir", runDir], {
    stdin: null,
    stdout: listOutput,
    stderr: outputSink(),
  });
  const listing = JSON.parse(listOutput.value);
  assert.equal(listing.count, 1);
  assert.equal(listing.packets[0].packetDir, packetDir);

  const showOutput = outputSink();
  await main(["show", "--packet", packetDir], {
    stdin: null,
    stdout: showOutput,
    stderr: outputSink(),
  });
  assert.match(showOutput.value, /Verify the claimed equality/);
  assert.match(showOutput.value, /cli_result/);

  const answerFile = path.join(runDir, "answer.txt");
  await writeFile(answerFile, 'Here is the result:\n```json\n{"answer":"verified"}\n```\n', "utf8");
  const importOutput = outputSink();
  await main(
    [
      "import",
      "--packet",
      packetDir,
      "--response-file",
      answerFile,
      "--source-url",
      "https://chatgpt.com/share/cli-example",
    ],
    { stdin: null, stdout: importOutput, stderr: outputSink() },
  );
  assert.equal(JSON.parse(importOutput.value).imported, true);

  const result = await provider.run(request);
  assert.deepEqual(result.data, { answer: "verified" });
  assert.equal(result.evidence[0].source.url, "https://chatgpt.com/share/cli-example");
});

test("manual Pro CLI rejects ambiguous queue locations and unknown flags", async () => {
  await assert.rejects(
    () =>
      main(["list", "--run-dir", "run", "--queue-dir", "queue"], {
        stdin: null,
        stdout: outputSink(),
        stderr: outputSink(),
      }),
    /either --queue-dir or --run-dir/,
  );
  await assert.rejects(
    () =>
      main(["status", "--packet", "missing", "--scrape"], {
        stdin: null,
        stdout: outputSink(),
        stderr: outputSink(),
      }),
    /Unknown flag.*--scrape/,
  );
});
