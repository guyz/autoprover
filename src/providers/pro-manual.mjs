import { access, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensurePrivateDir,
  ensurePrivateFile,
  extractJson,
  nowIso,
  sha256,
  shortId,
  sleep,
  slugify,
  writeJsonAtomic as writeSharedJsonAtomic,
} from "../utils.mjs";

export const PRO_MANUAL_PROTOCOL = "autoprover.pro-manual/v1";
export const PRO_MANUAL_QUEUE_NAME = "manual-pro";

const EMPTY_USAGE = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

/**
 * A deliberately human-mediated ChatGPT Pro provider.
 *
 * It writes a complete, copy/paste-ready request into the run's manual-pro
 * queue, then waits for `importManualResponse` (normally invoked by the
 * companion CLI) to atomically install a schema-checked answer. It never opens
 * a browser, submits a prompt, reads a conversation, or scrapes ChatGPT.
 */
export class ProManualProvider {
  constructor(config = {}, options = {}) {
    this.config = config;
    this.queueDir = options.queueDir ?? config.proManual?.queueDir ?? null;
    this.pollIntervalMs =
      options.pollIntervalMs ??
      Number(config.proManual?.pollIntervalSeconds ?? 1) * 1_000;
    this.waitForResponse =
      options.waitForResponse ?? config.proManual?.waitForResponse ?? true;
    this.sleep = options.sleep ?? sleep;
    this.now = options.now ?? nowIso;

    if (!Number.isFinite(this.pollIntervalMs) || this.pollIntervalMs <= 0) {
      throw new Error("Pro-manual pollIntervalMs must be positive");
    }
  }

  async run(request) {
    validateProviderRequest(request);
    const resumed = request.resumeId
      ? await this.resumePacket(request)
      : null;
    const packet = resumed?.packet ?? (await this.preparePacket(request));
    const responseSchema = resumed?.schema ?? request.schema.schema;
    await request.onStarted?.(packet.id);

    const responsePath = path.join(packet.packetDir, "response.json");
    const deadline =
      Number.isFinite(request.timeoutMs) && request.timeoutMs >= 0
        ? Date.now() + request.timeoutMs
        : Infinity;
    let lastInvalidDigest = null;

    while (true) {
      const envelope = await readJsonIfPresent(responsePath);
      if (envelope) {
        try {
          const result = normalizeImportedResponse(packet, envelope, responseSchema);
          await writeJsonAtomic(path.join(packet.packetDir, "status.json"), {
            protocol: PRO_MANUAL_PROTOCOL,
            packetId: packet.id,
            state: "completed",
            completedAt: this.now(),
            outputSha256: result.outputSha256,
            source: result.source,
          });
          return {
            sessionId: packet.id,
            data: result.data,
            rawText: result.rawText,
            usage: { ...EMPTY_USAGE },
            evidence: [
              {
                type: "manual_import",
                packetId: packet.id,
                requestHash: packet.requestHash,
                importedAt: envelope.importedAt,
                outputSha256: result.outputSha256,
                source: result.source,
              },
            ],
            response: envelope,
          };
        } catch (error) {
          const digest = sha256(JSON.stringify(envelope));
          if (digest !== lastInvalidDigest) {
            lastInvalidDigest = digest;
            await writeJsonAtomic(path.join(packet.packetDir, "status.json"), {
              protocol: PRO_MANUAL_PROTOCOL,
              packetId: packet.id,
              state: "invalid-response",
              checkedAt: this.now(),
              error: error.message,
              responseSha256: digest,
            });
          }
          if (!this.waitForResponse) {
            throw new ManualResponseInvalidError(packet, error.message, {
              cause: error,
            });
          }
        }
      }

      if (!this.waitForResponse || Date.now() >= deadline) {
        throw new ManualResponsePendingError(packet, {
          invalidResponse: Boolean(lastInvalidDigest),
        });
      }
      await this.sleep(Math.min(this.pollIntervalMs, Math.max(1, deadline - Date.now())));
    }
  }

  async resumePacket(request) {
    validateProviderRequest(request);
    const queueDir = await resolveQueueDir(request.workingDir, this.queueDir);
    const id = validateResumeId(request.resumeId);
    const packetDir = path.resolve(queueDir, id);
    if (path.dirname(packetDir) !== path.resolve(queueDir)) {
      throw new Error("Pro-manual resumeId must identify one direct child of the queue");
    }

    const packet = await readRequiredJson(path.join(packetDir, "packet.json"));
    assertPacketProtocol(packet);
    if (packet.id !== id) {
      throw new Error(
        `Manual resume packet id mismatch: expected ${id}, received ${packet.id ?? "missing"}`,
      );
    }
    const storedRequest = await readRequiredJson(
      path.join(packetDir, "request.json"),
    );
    assertRequestMatchesPacket(packet, storedRequest);
    const requestedOperationKey = request.operationKey ?? null;
    if (
      packet.operationKey !== requestedOperationKey ||
      storedRequest.operationKey !== requestedOperationKey
    ) {
      throw new Error(
        `Manual resume packet ${id} belongs to a different operation`,
      );
    }
    if ((storedRequest.role ?? null) !== (request.role ?? null)) {
      throw new Error(`Manual resume packet ${id} belongs to a different role`);
    }
    if (!storedRequest.schema?.schema) {
      throw new Error(`Manual resume packet ${id} is missing its stored schema`);
    }

    return {
      packet: { ...packet, packetDir },
      schema: storedRequest.schema.schema,
    };
  }

  async preparePacket(request) {
    validateProviderRequest(request);
    const queueDir = await resolveQueueDir(request.workingDir, this.queueDir);
    const identity = requestIdentity(request);
    const id = packetId(identity, request.operationKey);
    const packetDir = path.join(queueDir, id);
    const packetPath = path.join(packetDir, "packet.json");
    await ensurePrivateDir(packetDir);

    const existing = await readJsonIfPresent(packetPath);
    if (existing && existing.requestHash !== identity.requestHash) {
      throw new Error(
        `Manual packet collision for ${id}: existing request hash ${existing.requestHash} ` +
          `does not match ${identity.requestHash}`,
      );
    }

    const createdAt = existing?.createdAt ?? this.now();
    const packet = {
      protocol: PRO_MANUAL_PROTOCOL,
      id,
      requestHash: identity.requestHash,
      operationKey: request.operationKey ?? null,
      role: request.role ?? null,
      requestedModel: request.model ?? null,
      createdAt,
      packetDir,
      paths: {
        prompt: "prompt.md",
        request: "request.json",
        schema: "schema.json",
        response: "response.json",
        status: "status.json",
      },
    };

    await writeJsonAtomic(packetPath, serializablePacket(packet));
    await writeJsonAtomic(path.join(packetDir, "request.json"), {
      protocol: PRO_MANUAL_PROTOCOL,
      packetId: id,
      requestHash: identity.requestHash,
      operationKey: request.operationKey ?? null,
      role: request.role ?? null,
      model: request.model ?? null,
      toolsRequested: request.tools ?? {},
      instructions: request.instructions,
      prompt: request.prompt,
      schema: request.schema,
    });
    await writeJsonAtomic(path.join(packetDir, "schema.json"), request.schema.schema);
    await writeTextAtomic(path.join(packetDir, "prompt.md"), renderPrompt(request, packet));
    await writeTextAtomic(path.join(packetDir, "HOW_TO_COMPLETE.md"), renderInstructions(packet));

    const existingStatus = await readJsonIfPresent(path.join(packetDir, "status.json"));
    if (
      !existingStatus ||
      !["completed", "invalid-response", "response-imported"].includes(existingStatus.state)
    ) {
      await writeJsonAtomic(path.join(packetDir, "status.json"), {
        protocol: PRO_MANUAL_PROTOCOL,
        packetId: id,
        state: "waiting-for-human",
        createdAt,
        updatedAt: this.now(),
      });
    }
    return packet;
  }
}

export class ManualResponsePendingError extends Error {
  constructor(packet, options = {}) {
    const qualifier = options.invalidResponse
      ? "The imported answer is invalid; replace it with a schema-valid answer."
      : "No imported answer is available yet.";
    super(
      `${qualifier} Manual Pro packet: ${packet.packetDir}. ` +
        `Use: node src/pro-manual-cli.mjs import --packet ${JSON.stringify(packet.packetDir)} ` +
        `--response-file <answer.txt>`,
    );
    this.name = "ManualResponsePendingError";
    this.code = "AUTOPROVER_MANUAL_RESPONSE_PENDING";
    this.packetId = packet.id;
    this.packetDir = packet.packetDir;
    this.resumable = true;
  }
}

export class ManualResponseInvalidError extends Error {
  constructor(packet, detail, options = {}) {
    super(`Invalid response for manual Pro packet ${packet.id}: ${detail}`, options);
    this.name = "ManualResponseInvalidError";
    this.code = "AUTOPROVER_MANUAL_RESPONSE_INVALID";
    this.packetId = packet.id;
    this.packetDir = packet.packetDir;
    this.resumable = true;
  }
}

/**
 * Validate and atomically import a response produced manually in ChatGPT Pro.
 * The model's answer may be bare JSON or JSON in a markdown fence.
 */
export async function importManualResponse(
  packetPath,
  responseText,
  { sourceUrl = null, note = null, importedAt = nowIso() } = {},
) {
  const packetDir = normalizePacketDir(packetPath);
  const packet = await readRequiredJson(path.join(packetDir, "packet.json"));
  assertPacketProtocol(packet);
  const request = await readRequiredJson(path.join(packetDir, "request.json"));
  assertRequestMatchesPacket(packet, request);
  const status = await readJsonIfPresent(path.join(packetDir, "status.json"));
  if (["completed", "response-imported"].includes(status?.state)) {
    throw new Error(
      `Manual packet ${packet.id} is already ${status.state} and cannot be imported again`,
    );
  }
  const existingResponse = await readJsonIfPresent(
    path.join(packetDir, "response.json"),
  );
  if (existingResponse && status?.state !== "invalid-response") {
    throw new Error(
      `Manual packet ${packet.id} already has a published response and cannot be overwritten`,
    );
  }
  const rawText = String(responseText ?? "").trim();
  if (!rawText) throw new Error("Manual response is empty");
  const data = extractJson(rawText);
  assertSchemaValid(data, request.schema?.schema);
  const source = normalizeSource(sourceUrl, note);
  const envelope = {
    protocol: PRO_MANUAL_PROTOCOL,
    packetId: packet.id,
    requestHash: packet.requestHash,
    importedAt,
    source,
    outputSha256: sha256(rawText),
    output: rawText,
  };
  await writeJsonAtomic(path.join(packetDir, "response.json"), envelope);
  await writeJsonAtomic(path.join(packetDir, "status.json"), {
    protocol: PRO_MANUAL_PROTOCOL,
    packetId: packet.id,
    state: "response-imported",
    importedAt,
    outputSha256: envelope.outputSha256,
    source,
  });
  return envelope;
}

export async function inspectManualPacket(packetPath) {
  const packetDir = normalizePacketDir(packetPath);
  const [packet, status, prompt] = await Promise.all([
    readRequiredJson(path.join(packetDir, "packet.json")),
    readJsonIfPresent(path.join(packetDir, "status.json")),
    readFile(path.join(packetDir, "prompt.md"), "utf8"),
  ]);
  assertPacketProtocol(packet);
  return { ...packet, packetDir, status, prompt };
}

export async function listManualPackets(queuePath) {
  const queueDir = normalizeQueueDir(queuePath);
  let entries;
  try {
    entries = await readdir(queueDir, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const packets = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const packet = await inspectManualPacket(path.join(queueDir, entry.name));
      packets.push({
        id: packet.id,
        packetDir: packet.packetDir,
        operationKey: packet.operationKey,
        role: packet.role,
        requestedModel: packet.requestedModel,
        createdAt: packet.createdAt,
        state: packet.status?.state ?? "unknown",
      });
    } catch {
      // A queue may contain unrelated or partially copied directories.
    }
  }
  return packets.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function queueDirForRun(runDir) {
  return path.join(path.resolve(runDir), PRO_MANUAL_QUEUE_NAME);
}

export function assertSchemaValid(value, schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    throw new Error("Manual packet is missing a JSON schema");
  }
  const errors = validateAgainstSchema(value, schema);
  if (errors.length) {
    throw new Error(
      `Manual response does not match the requested schema: ${errors.slice(0, 12).join("; ")}`,
    );
  }
  return value;
}

export function validateAgainstSchema(value, schema, location = "$") {
  const errors = [];
  validateNode(value, schema, location, errors);
  return errors;
}

function validateNode(value, schema, location, errors) {
  if (!schema || typeof schema !== "object") return;
  if (schema.const !== undefined && !deepEqual(value, schema.const)) {
    errors.push(`${location} must equal ${JSON.stringify(schema.const)}`);
    return;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(value, entry))) {
    errors.push(`${location} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(", ")}`);
    return;
  }
  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some((candidate) => validateAgainstSchema(value, candidate, location).length === 0)) {
      errors.push(`${location} does not match any allowed schema`);
    }
    return;
  }
  if (Array.isArray(schema.oneOf)) {
    const matches = schema.oneOf.filter(
      (candidate) => validateAgainstSchema(value, candidate, location).length === 0,
    ).length;
    if (matches !== 1) errors.push(`${location} must match exactly one allowed schema`);
    return;
  }

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push(`${location} must be ${schema.type}, received ${describeType(value)}`);
    return;
  }

  if (schema.type === "object" || (schema.properties && isPlainObject(value))) {
    const required = schema.required ?? [];
    for (const key of required) {
      if (!Object.hasOwn(value, key)) errors.push(`${location}.${key} is required`);
    }
    const properties = schema.properties ?? {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.hasOwn(value, key)) validateNode(value[key], child, `${location}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) errors.push(`${location}.${key} is not allowed`);
      }
    } else if (isPlainObject(schema.additionalProperties)) {
      for (const key of Object.keys(value)) {
        if (!Object.hasOwn(properties, key)) {
          validateNode(value[key], schema.additionalProperties, `${location}.${key}`, errors);
        }
      }
    }
  }

  if (schema.type === "array" && Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${location} must contain at least ${schema.minItems} items`);
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      errors.push(`${location} must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((entry, index) => validateNode(entry, schema.items, `${location}[${index}]`, errors));
    }
  }

  if (schema.type === "string" && typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${location} must contain at least ${schema.minLength} characters`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${location} must contain at most ${schema.maxLength} characters`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${location} must match ${schema.pattern}`);
    }
  }

  if (["number", "integer"].includes(schema.type) && typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) {
      errors.push(`${location} must be at least ${schema.minimum}`);
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      errors.push(`${location} must be at most ${schema.maximum}`);
    }
  }
}

function matchesType(value, type) {
  if (Array.isArray(type)) return type.some((entry) => matchesType(value, entry));
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isPlainObject(value);
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number" && Number.isFinite(value);
  return typeof value === type;
}

function describeType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (Number.isInteger(value)) return "integer";
  return typeof value;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateProviderRequest(request) {
  if (!request || typeof request !== "object") throw new Error("Pro-manual request is required");
  if (!request.workingDir) throw new Error("Pro-manual request.workingDir is required");
  if (typeof request.instructions !== "string") {
    throw new Error("Pro-manual request.instructions must be a string");
  }
  if (typeof request.prompt !== "string") throw new Error("Pro-manual request.prompt must be a string");
  if (!request.schema?.name || !request.schema?.schema) {
    throw new Error("Pro-manual request.schema must contain name and schema");
  }
}

function requestIdentity(request) {
  const canonical = {
    operationKey: request.operationKey ?? null,
    workingDir: path.resolve(request.workingDir),
    role: request.role ?? null,
    model: request.model ?? null,
    instructions: request.instructions,
    prompt: request.prompt,
    schema: request.schema,
    tools: request.tools ?? {},
  };
  return { canonical, requestHash: sha256(JSON.stringify(canonical)) };
}

function packetId(identity, operationKey) {
  const label = slugify(operationKey ?? "manual-turn").slice(0, 52);
  return `${label}-${identity.requestHash.slice(0, 16)}`;
}

async function resolveQueueDir(workingDir, configuredQueueDir) {
  if (configuredQueueDir) return path.resolve(configuredQueueDir);
  let current = path.resolve(workingDir);
  while (true) {
    try {
      await access(path.join(current, "run.json"));
      return path.join(current, PRO_MANUAL_QUEUE_NAME);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return path.join(path.resolve(workingDir), ".autoprover", PRO_MANUAL_QUEUE_NAME);
}

function renderPrompt(request, packet) {
  return `# Autoprover manual ChatGPT Pro turn

Packet: ${packet.id}
Role: ${request.role ?? "unspecified"}
Requested model settings: ${JSON.stringify(request.model ?? {})}

Open a new or appropriate existing conversation in ChatGPT, explicitly select Pro,
and paste everything below this paragraph. This file does not authorize browser
automation. Return one JSON value only; do not add commentary outside the JSON.

<AUTOPROVER_SYSTEM_INSTRUCTIONS>
${request.instructions}
</AUTOPROVER_SYSTEM_INSTRUCTIONS>

<AUTOPROVER_TASK>
${request.prompt}
</AUTOPROVER_TASK>

<AUTOPROVER_REQUIRED_JSON_SCHEMA name="${request.schema.name}">
${JSON.stringify(request.schema.schema, null, 2)}
</AUTOPROVER_REQUIRED_JSON_SCHEMA>

Your complete response must be valid JSON matching the schema exactly. Include all
required keys and no keys forbidden by additionalProperties.
`;
}

function renderInstructions(packet) {
  return `# Complete this manual Pro packet

1. Open \`prompt.md\`, paste it into a ChatGPT conversation with Pro selected, and
   wait for the complete response.
2. Save the response to a local text file. Do not edit \`response.json\` directly.
3. From the Autoprover repository, run:

   \`\`\`bash
   node src/pro-manual-cli.mjs import --packet ${JSON.stringify(packet.packetDir)} --response-file <answer.txt>
   \`\`\`

   Optionally append \`--source-url <chatgpt-share-url>\` for audit provenance.
4. The waiting Autoprover process detects the atomic import and continues. Use
   \`node src/pro-manual-cli.mjs list --run-dir <run-dir>\` to see every queued
   packet when several problems are running in parallel.
`;
}

function normalizeImportedResponse(packet, envelope, schema) {
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    throw new Error("response.json must contain an object");
  }
  if (envelope.protocol !== PRO_MANUAL_PROTOCOL) {
    throw new Error(`response protocol must be ${PRO_MANUAL_PROTOCOL}`);
  }
  if (envelope.packetId !== packet.id) throw new Error("response packetId does not match this packet");
  if (envelope.requestHash !== packet.requestHash) {
    throw new Error("response requestHash does not match this packet");
  }
  if (typeof envelope.output !== "string" || !envelope.output.trim()) {
    throw new Error("response output must be a non-empty string");
  }
  const outputSha256 = sha256(envelope.output.trim());
  if (envelope.outputSha256 !== outputSha256) throw new Error("response output hash is invalid");
  const data = extractJson(envelope.output);
  assertSchemaValid(data, schema);
  return {
    data,
    rawText: envelope.output,
    outputSha256,
    source: normalizeSource(envelope.source?.url, envelope.source?.note),
  };
}

function normalizeSource(sourceUrl, note) {
  let url = null;
  if (sourceUrl) {
    const parsed = new URL(String(sourceUrl));
    if (!["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("Manual response source URL must use http or https");
    }
    url = parsed.toString();
  }
  return {
    kind: "manual-import",
    url,
    note: note ? String(note) : null,
  };
}

function validateResumeId(value) {
  if (typeof value !== "string" || !value || value !== value.trim()) {
    throw new Error("Pro-manual resumeId must be a non-empty packet id");
  }
  if (
    value.length > 128 ||
    path.basename(value) !== value ||
    !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(value)
  ) {
    throw new Error(
      "Pro-manual resumeId must be a safe queue-local packet id",
    );
  }
  return value;
}

function serializablePacket(packet) {
  const { packetDir: _packetDir, ...serializable } = packet;
  return serializable;
}

function normalizePacketDir(packetPath) {
  const resolved = path.resolve(String(packetPath));
  return path.basename(resolved) === "packet.json" ? path.dirname(resolved) : resolved;
}

function normalizeQueueDir(queuePath) {
  return path.resolve(String(queuePath));
}

function assertPacketProtocol(packet) {
  if (packet.protocol !== PRO_MANUAL_PROTOCOL) {
    throw new Error(`Packet protocol must be ${PRO_MANUAL_PROTOCOL}`);
  }
}

function assertRequestMatchesPacket(packet, request) {
  if (request.protocol !== PRO_MANUAL_PROTOCOL) throw new Error("Request protocol is invalid");
  if (request.packetId !== packet.id) throw new Error("Request packetId does not match packet");
  if (request.requestHash !== packet.requestHash) throw new Error("Request hash does not match packet");
}

async function readRequiredJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") throw new Error(`Required manual packet file is missing: ${filePath}`);
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in manual packet file: ${filePath}`, { cause: error });
    throw error;
  }
}

async function readJsonIfPresent(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof SyntaxError) throw new Error(`Invalid JSON in ${filePath}`, { cause: error });
    throw error;
  }
}

async function writeJsonAtomic(filePath, value) {
  return writeSharedJsonAtomic(filePath, value);
}

async function writeTextAtomic(filePath, value) {
  await ensurePrivateDir(path.dirname(filePath));
  const temporary = `${filePath}.${process.pid}.${shortId()}.tmp`;
  await writeFile(temporary, value, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
  await ensurePrivateFile(filePath);
}
