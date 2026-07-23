#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  importManualResponse,
  inspectManualPacket,
  listManualPackets,
  queueDirForRun,
} from "./providers/pro-manual.mjs";
import { parseArgs } from "./utils.mjs";

export async function main(
  argv = process.argv.slice(2),
  io = { stdin: process.stdin, stdout: process.stdout, stderr: process.stderr },
) {
  const { positional, flags } = parseArgs(argv);
  const command = positional[0] ?? "help";
  if (flags.help || ["help", "--help", "-h"].includes(command)) {
    io.stdout.write(helpText());
    return;
  }
  if (positional.length > 1) {
    throw new Error(`Unexpected positional arguments: ${positional.slice(1).join(" ")}`);
  }

  if (command === "list") {
    rejectUnknownFlags(flags, ["run-dir", "queue-dir", "help"]);
    const queueDir = resolveQueueFlag(flags);
    const packets = await listManualPackets(queueDir);
    io.stdout.write(`${JSON.stringify({ queueDir, count: packets.length, packets }, null, 2)}\n`);
    return;
  }

  if (command === "show") {
    rejectUnknownFlags(flags, ["packet", "help"]);
    const packet = await inspectManualPacket(requiredFlag(flags, "packet"));
    io.stdout.write(packet.prompt);
    return;
  }

  if (command === "status") {
    rejectUnknownFlags(flags, ["packet", "help"]);
    const packet = await inspectManualPacket(requiredFlag(flags, "packet"));
    io.stdout.write(
      `${JSON.stringify(
        {
          id: packet.id,
          packetDir: packet.packetDir,
          operationKey: packet.operationKey,
          role: packet.role,
          requestedModel: packet.requestedModel,
          createdAt: packet.createdAt,
          status: packet.status,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  if (command === "import") {
    rejectUnknownFlags(flags, [
      "packet",
      "response-file",
      "source-url",
      "note",
      "help",
    ]);
    const packetPath = requiredFlag(flags, "packet");
    const responseText = flags["response-file"]
      ? await readFile(path.resolve(String(flags["response-file"])), "utf8")
      : await readStdin(io.stdin);
    const envelope = await importManualResponse(packetPath, responseText, {
      sourceUrl: optionalString(flags["source-url"]),
      note: optionalString(flags.note),
    });
    io.stdout.write(
      `${JSON.stringify(
        {
          imported: true,
          packetId: envelope.packetId,
          outputSha256: envelope.outputSha256,
          source: envelope.source,
        },
        null,
        2,
      )}\n`,
    );
    return;
  }

  throw new Error(`Unknown manual Pro command: ${command}`);
}

function resolveQueueFlag(flags) {
  if (flags["queue-dir"] && flags["run-dir"]) {
    throw new Error("Use either --queue-dir or --run-dir, not both");
  }
  if (flags["queue-dir"]) return path.resolve(String(flags["queue-dir"]));
  if (flags["run-dir"]) return queueDirForRun(String(flags["run-dir"]));
  throw new Error("--run-dir or --queue-dir is required");
}

function requiredFlag(flags, name) {
  if (!flags[name] || flags[name] === true) throw new Error(`--${name} is required`);
  return String(flags[name]);
}

function optionalString(value) {
  return value && value !== true ? String(value) : null;
}

function rejectUnknownFlags(flags, allowed) {
  const unknown = Object.keys(flags).filter((name) => !allowed.includes(name));
  if (unknown.length) {
    throw new Error(`Unknown flag(s): ${unknown.map((name) => `--${name}`).join(", ")}`);
  }
}

async function readStdin(stream) {
  if (stream.isTTY) {
    throw new Error("--response-file is required when stdin is a terminal");
  }
  let content = "";
  for await (const chunk of stream) content += chunk.toString();
  if (!content.trim()) throw new Error("No response was provided on stdin");
  return content;
}

function helpText() {
  return `Autoprover manual ChatGPT Pro queue

Usage:
  node src/pro-manual-cli.mjs list --run-dir runs/<run-id>
  node src/pro-manual-cli.mjs list --queue-dir <queue-dir>
  node src/pro-manual-cli.mjs show --packet <packet-dir>
  node src/pro-manual-cli.mjs status --packet <packet-dir>
  node src/pro-manual-cli.mjs import --packet <packet-dir> --response-file <answer.txt>
  node src/pro-manual-cli.mjs import --packet <packet-dir> < answer.txt

The import command validates the answer against the packet's exact JSON schema
before atomically making it visible to the waiting Autoprover process. It never
opens, submits to, or reads ChatGPT.
`;
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
}
