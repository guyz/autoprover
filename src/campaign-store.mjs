import { randomUUID } from "node:crypto";
import {
  open,
  readFile,
  readdir,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  appendPrivateText,
  ensurePrivateDir,
  nowIso,
  readJson,
  sha256,
  writeJsonAtomic,
} from "./utils.mjs";

const DEFAULT_LEASE_TTL_MS = 150 * 60 * 1_000;

export function leaseTokenMatches(entry, lease) {
  return Boolean(
    entry?.lease &&
      lease &&
      entry.lease.leaseId === lease.leaseId &&
      entry.lease.fencingToken === lease.fencingToken,
  );
}

export function acquireProblemLease(
  entry,
  {
    ownerId,
    slotId = null,
    attemptId = null,
    runDir = null,
    now = new Date(),
    ttlMs = DEFAULT_LEASE_TTL_MS,
  } = {},
) {
  if (!ownerId) throw new Error("A lease ownerId is required");
  const instant = asDate(now);
  if (leaseIsLive(entry?.lease, instant)) {
    throw new Error(`Problem ${entry.problemKey ?? "unknown"} already has a live lease`);
  }
  const lease = {
    leaseId: randomUUID(),
    fencingToken: randomUUID(),
    ownerId,
    slotId,
    attemptId,
    runDir,
    acquiredAt: instant.toISOString(),
    heartbeatAt: instant.toISOString(),
    expiresAt: new Date(instant.getTime() + ttlMs).toISOString(),
  };
  return { ...structuredClone(entry), lease };
}

export function releaseProblemLease(entry, lease) {
  if (!leaseTokenMatches(entry, lease)) {
    throw new Error("Lease fencing token does not match the current problem lease");
  }
  return { ...structuredClone(entry), lease: null };
}

export class CampaignStore {
  constructor(campaignDir, { catalogDir } = {}) {
    this.campaignDir = path.resolve(campaignDir);
    this.catalogDir = path.resolve(
      catalogDir ?? path.join(path.dirname(this.campaignDir), "_catalog"),
    );
    this.campaignPath = path.join(this.campaignDir, "campaign.json");
    this.eventsPath = path.join(this.campaignDir, "events.jsonl");
    this.lockPath = path.join(this.campaignDir, ".campaign.lock");
    this.stopPath = path.join(this.campaignDir, "stop-request.json");
    this.catalogPath = path.join(this.catalogDir, "catalog.json");
    this.catalogLockPath = path.join(this.catalogDir, ".catalog.lock");
    this.leasesDir = path.join(this.catalogDir, "leases");
    this.attemptsDir = path.join(this.campaignDir, "attempts");
    this.commandsDir = path.join(this.campaignDir, "commands");
    this.saveQueue = Promise.resolve();
    this.catalogQueue = Promise.resolve();
    this.catalogTransactionQueue = Promise.resolve();
  }

  async initialize(campaign, catalog = emptyCatalog()) {
    await ensurePrivateDir(this.campaignDir);
    await ensurePrivateDir(this.catalogDir);
    await ensurePrivateDir(this.leasesDir);
    await ensurePrivateDir(this.attemptsDir);
    await ensurePrivateDir(this.commandsDir);
    try {
      await readJson(this.catalogPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      await writeJsonAtomic(this.catalogPath, catalog);
    }
    await this.saveCampaign(campaign);
    await this.event("campaign.created", { campaignId: campaign.campaignId });
  }

  loadCampaign() {
    return readJson(this.campaignPath);
  }

  loadCatalog() {
    return readJson(this.catalogPath);
  }

  saveCampaign(campaign) {
    campaign.updatedAt = nowIso();
    const snapshot = structuredClone(campaign);
    this.saveQueue = this.saveQueue.then(() =>
      writeJsonAtomic(this.campaignPath, snapshot),
    );
    return this.saveQueue;
  }

  saveCatalog(catalog) {
    catalog.updatedAt = nowIso();
    const snapshot = structuredClone(catalog);
    this.catalogQueue = this.catalogQueue.then(() =>
      writeJsonAtomic(this.catalogPath, snapshot),
    );
    return this.catalogQueue;
  }

  event(type, data = {}) {
    const record = { at: nowIso(), type, ...data };
    this.saveQueue = this.saveQueue.then(() =>
      appendPrivateText(this.eventsPath, `${JSON.stringify(record)}\n`),
    );
    return this.saveQueue;
  }

  attemptDir(attemptId) {
    return path.join(this.attemptsDir, String(attemptId));
  }

  async enqueueCommand(type, payload = {}) {
    await ensurePrivateDir(this.commandsDir);
    const createdAt = nowIso();
    const command = {
      schemaVersion: 1,
      id: `command-${Date.now()}-${randomUUID()}`,
      type,
      status: "pending",
      createdAt,
      updatedAt: createdAt,
      ...structuredClone(payload),
    };
    await writeJsonAtomic(this.commandPath(command.id), command);
    return structuredClone(command);
  }

  async listCommands({ statuses } = {}) {
    await ensurePrivateDir(this.commandsDir);
    const allowed = statuses ? new Set(statuses) : null;
    const commands = [];
    for (const name of (await readdir(this.commandsDir)).filter((entry) =>
      entry.endsWith(".json"),
    )) {
      const command = await readOptionalJson(path.join(this.commandsDir, name));
      if (command && (!allowed || allowed.has(command.status))) {
        commands.push(command);
      }
    }
    return commands.sort(
      (left, right) =>
        String(left.createdAt).localeCompare(String(right.createdAt)) ||
        String(left.id).localeCompare(String(right.id)),
    );
  }

  async saveCommand(command, patch = {}) {
    const updated = {
      ...structuredClone(command),
      ...structuredClone(patch),
      updatedAt: nowIso(),
    };
    await writeJsonAtomic(this.commandPath(updated.id), updated);
    Object.assign(command, updated);
    return structuredClone(updated);
  }

  commandPath(commandId) {
    if (!/^command-[a-zA-Z0-9-]+$/.test(String(commandId))) {
      throw new Error("Invalid campaign command id");
    }
    return path.join(this.commandsDir, `${commandId}.json`);
  }

  async acquireCampaignLock() {
    await ensurePrivateDir(this.campaignDir);
    return acquirePidLock(this.lockPath, "Campaign");
  }

  async releaseCampaignLock() {
    return releasePidLock(this.lockPath);
  }

  async withCatalogLock(callback) {
    const execute = async () => {
      await ensurePrivateDir(this.catalogDir);
      await acquirePidLock(this.catalogLockPath, "Catalog", {
        waitMs: 30_000,
      });
      try {
        const catalog = await this.loadCatalog().catch((error) => {
          if (error.code === "ENOENT") return emptyCatalog();
          throw error;
        });
        const result = await callback(catalog);
        await this.saveCatalog(catalog);
        return result;
      } finally {
        await releasePidLock(this.catalogLockPath);
      }
    };
    const transaction = this.catalogTransactionQueue.then(execute, execute);
    this.catalogTransactionQueue = transaction.then(
      () => undefined,
      () => undefined,
    );
    return transaction;
  }

  async acquireLease(
    problemKey,
    {
      ownerId,
      slotId = null,
      attemptId = null,
      runDir = null,
      ttlMs = DEFAULT_LEASE_TTL_MS,
      now = new Date(),
    } = {},
  ) {
    if (!problemKey) throw new Error("problemKey is required");
    const leasePath = this.leasePath(problemKey);
    return this.withCatalogLock(async (catalog) => {
      const entry = catalog.entries?.[problemKey];
      if (!entry) throw new Error(`Unknown catalog problem: ${problemKey}`);

      let existing = await readOptionalJson(leasePath);
      const instant = asDate(now);
      if (existing && leaseIsLive(existing, instant)) return null;
      if (existing) {
        const stalePath = `${leasePath}.stale-${Date.now()}-${existing.leaseId ?? "unknown"}`;
        await rename(leasePath, stalePath).catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      }

      const leasedEntry = acquireProblemLease(
        { ...entry, lease: existing ?? entry.lease ?? null },
        { ownerId, slotId, attemptId, runDir, ttlMs, now: instant },
      );
      const handle = await open(leasePath, "wx", 0o600);
      try {
        await handle.writeFile(
          `${JSON.stringify({ problemKey, ...leasedEntry.lease }, null, 2)}\n`,
          "utf8",
        );
      } finally {
        await handle.close();
      }
      catalog.entries ??= {};
      catalog.entries[problemKey] = leasedEntry;
      return structuredClone(leasedEntry.lease);
    });
  }

  async heartbeatLease(problemKey, lease, { ttlMs = DEFAULT_LEASE_TTL_MS } = {}) {
    return this.withCatalogLock(async (catalog) => {
      const entry = catalog.entries?.[problemKey];
      const persisted = await readOptionalJson(this.leasePath(problemKey));
      if (!leaseTokenMatches(entry, lease) || !sameLease(persisted, lease)) {
        return false;
      }
      const heartbeatAt = nowIso();
      const updated = {
        ...entry.lease,
        heartbeatAt,
        expiresAt: new Date(Date.now() + ttlMs).toISOString(),
      };
      entry.lease = updated;
      await writeJsonAtomic(this.leasePath(problemKey), {
        problemKey,
        ...updated,
      });
      Object.assign(lease, updated);
      return true;
    });
  }

  async releaseLease(problemKey, lease) {
    return this.withCatalogLock(async (catalog) => {
      const entry = catalog.entries?.[problemKey];
      const persisted = await readOptionalJson(this.leasePath(problemKey));
      if (
        !entry ||
        !sameLease(persisted, lease) ||
        (entry.lease && !leaseTokenMatches(entry, lease))
      ) {
        return false;
      }
      catalog.entries[problemKey] = entry.lease
        ? releaseProblemLease(entry, lease)
        : { ...entry, lease: null };
      await unlink(this.leasePath(problemKey)).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return true;
    });
  }

  async readLease(problemKey) {
    return readOptionalJson(this.leasePath(problemKey));
  }

  async listLeases() {
    let names = [];
    try {
      names = await readdir(this.leasesDir);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const leases = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const lease = await readOptionalJson(path.join(this.leasesDir, name));
      if (lease) leases.push(lease);
    }
    return leases;
  }

  leasePath(problemKey) {
    return path.join(this.leasesDir, `${sha256(String(problemKey))}.json`);
  }

  async readStopRequest() {
    return readOptionalJson(this.stopPath);
  }

  async requestStop(reason = "Stop requested by operator") {
    const request = { requestedAt: nowIso(), reason };
    await writeJsonAtomic(this.stopPath, request);
    return request;
  }

  async clearStopRequest() {
    await unlink(this.stopPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export function emptyCatalog() {
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    entries: {},
  };
}

function leaseIsLive(lease, now = new Date()) {
  return Boolean(
    lease?.expiresAt &&
      Number.isFinite(Date.parse(lease.expiresAt)) &&
      Date.parse(lease.expiresAt) > asDate(now).getTime(),
  );
}

function sameLease(left, right) {
  return Boolean(
    left &&
      right &&
      left.leaseId === right.leaseId &&
      left.fencingToken === right.fencingToken,
  );
}

function asDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid date");
  return date;
}

async function readOptionalJson(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function acquirePidLock(lockPath, label, { waitMs = 0 } = {}) {
  const payload = { pid: process.pid, acquiredAt: nowIso() };
  const deadline = Date.now() + waitMs;
  while (true) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
      await handle.close();
      return payload;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const existing = await readOptionalJson(lockPath).catch(() => null);
      if (existing?.pid && !processAlive(existing.pid)) {
        await unlink(lockPath).catch(() => {});
        continue;
      }
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      throw new Error(
        `${label} is already active${existing?.pid ? ` in process ${existing.pid}` : ""}`,
      );
    }
  }
}

async function releasePidLock(lockPath) {
  const existing = await readOptionalJson(lockPath).catch(() => null);
  if (existing?.pid === process.pid) {
    await unlink(lockPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
