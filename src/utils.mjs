import { createHash, randomUUID } from "node:crypto";
import {
  appendFile,
  chmod,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

export const nowIso = () => new Date().toISOString();

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shortId() {
  return randomUUID().replaceAll("-", "").slice(0, 10);
}

export function slugify(value) {
  return String(value)
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72) || shortId();
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function advanceActiveClock(
  clock,
  deadlineAt,
  {
    nowMs = Date.now(),
    suspensionThresholdMs = 120_000,
    expectedTickMs = 1_000,
  } = {},
) {
  const previous = Date.parse(clock?.lastHeartbeatAt ?? "");
  const currentDeadline = Date.parse(deadlineAt);
  const gapMs = Number.isFinite(previous)
    ? Math.max(0, nowMs - previous)
    : 0;
  const suspendedMs =
    gapMs > suspensionThresholdMs
      ? Math.max(0, gapMs - expectedTickMs)
      : 0;
  return {
    clock: {
      lastHeartbeatAt: new Date(nowMs).toISOString(),
      suspendedMs:
        Math.max(0, Number(clock?.suspendedMs ?? 0)) + suspendedMs,
      lastSuspensionMs: suspendedMs,
    },
    deadlineAt:
      suspendedMs > 0 && Number.isFinite(currentDeadline)
        ? new Date(currentDeadline + suspendedMs).toISOString()
        : deadlineAt,
    suspendedMs,
  };
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function writeJsonAtomic(filePath, value) {
  return writePrivateText(
    filePath,
    `${JSON.stringify(value, null, 2)}\n`,
  );
}

export async function ensurePrivateDir(dirPath) {
  await mkdir(dirPath, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(dirPath, 0o700);
  return dirPath;
}

export async function ensurePrivateFile(filePath) {
  if (process.platform !== "win32") await chmod(filePath, 0o600);
  return filePath;
}

export async function writePrivateText(filePath, value) {
  await ensurePrivateDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.${shortId()}.tmp`;
  try {
    await writeFile(tempPath, value, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, filePath);
    await ensurePrivateFile(filePath);
  } finally {
    await unlink(tempPath).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

export async function appendPrivateText(filePath, value) {
  await ensurePrivateDir(path.dirname(filePath));
  await appendFile(filePath, value, { encoding: "utf8", mode: 0o600 });
  await ensurePrivateFile(filePath);
}

export class Semaphore {
  constructor(limit) {
    this.limit = Math.max(1, limit);
    this.active = 0;
    this.waiters = [];
  }

  async use(fn) {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  acquire() {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  release() {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.active -= 1;
  }
}

export function extractJson(text) {
  const trimmed = String(text ?? "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) return JSON.parse(fenced[1]);
    const start = Math.min(
      ...[trimmed.indexOf("{"), trimmed.indexOf("[")].filter((x) => x >= 0),
    );
    if (!Number.isFinite(start)) throw new Error("Model response did not contain JSON");
    const end = Math.max(trimmed.lastIndexOf("}"), trimmed.lastIndexOf("]"));
    if (end <= start) throw new Error("Model response contained incomplete JSON");
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

export function terminalStatus(status) {
  return !["queued", "in_progress"].includes(status);
}

export function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const [name, inline] = token.slice(2).split("=", 2);
    if (inline !== undefined) {
      flags[name] = inline;
      continue;
    }
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      index += 1;
    } else {
      flags[name] = true;
    }
  }
  return { positional, flags };
}

export function numberFlag(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Expected a number, received ${value}`);
  return parsed;
}
