import { open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import {
  appendPrivateText,
  ensurePrivateDir,
  nowIso,
  readJson,
  sha256,
  slugify,
  writeJsonAtomic,
  writePrivateText,
} from "./utils.mjs";

export class RunStore {
  constructor(runDir) {
    this.runDir = path.resolve(runDir);
    this.statePath = path.join(this.runDir, "run.json");
    this.eventsPath = path.join(this.runDir, "events.jsonl");
    this.lockPath = path.join(this.runDir, ".autoprover.lock");
    this.saveQueue = Promise.resolve();
  }

  async initialize(state) {
    await ensurePrivateDir(this.runDir);
    await ensurePrivateDir(path.join(this.runDir, "problems"));
    await ensurePrivateDir(path.join(this.runDir, ".internal"));
    await this.save(state);
    await this.event("run.created", { runId: state.runId });
  }

  async load() {
    return readJson(this.statePath);
  }

  save(state) {
    state.updatedAt = nowIso();
    this.saveQueue = this.saveQueue.then(() => writeJsonAtomic(this.statePath, state));
    return this.saveQueue;
  }

  event(type, data = {}) {
    const record = { at: nowIso(), type, ...data };
    this.saveQueue = this.saveQueue.then(() =>
      appendPrivateText(this.eventsPath, `${JSON.stringify(record)}\n`),
    );
    return this.saveQueue;
  }

  problemDir(problemId) {
    return path.join(this.runDir, "problems", slugify(problemId));
  }

  branchDir(problemId, branchId) {
    return path.join(this.problemDir(problemId), "branches", slugify(branchId));
  }

  async prepareBranch(problemId, branchId) {
    const dir = this.branchDir(problemId, branchId);
    await ensurePrivateDir(path.join(dir, "workspace"));
    await ensurePrivateDir(path.join(dir, "artifacts"));
    return dir;
  }

  async persistArtifacts(problemId, branchId, epoch, artifacts) {
    if (!artifacts?.length) return [];
    const root = path.join(this.branchDir(problemId, branchId), "artifacts", `epoch-${epoch}`);
    await ensurePrivateDir(root);
    const records = [];
    for (let index = 0; index < artifacts.length; index += 1) {
      const artifact = artifacts[index];
      const extension = artifact.kind === "code" ? ".txt" : ".md";
      const filename = `${String(index + 1).padStart(2, "0")}-${slugify(artifact.name)}${extension}`;
      const filePath = path.join(root, filename);
      await writePrivateText(filePath, artifact.content);
      records.push({
        ...artifact,
        content: undefined,
        contentExcerpt: artifact.content.slice(0, 8000),
        path: path.relative(this.runDir, filePath),
        sha256: sha256(artifact.content),
      });
    }
    return records;
  }

  async persistModelEvidence(role, sessionId, evidence) {
    if (!evidence?.length) return null;
    const filePath = path.join(
      this.runDir,
      "evidence",
      slugify(role),
      `${slugify(sessionId || shortEvidenceId(evidence))}.json`,
    );
    await writeJsonAtomic(filePath, evidence);
    return path.relative(this.runDir, filePath);
  }

  async listRuns(runRoot) {
    const root = path.resolve(runRoot);
    let entries = [];
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      return [];
    }
    const results = [];
    for (const entry of entries.filter((item) => item.isDirectory())) {
      try {
        const state = await readJson(path.join(root, entry.name, "run.json"));
        results.push({ runDir: path.join(root, entry.name), state });
      } catch {
        // Ignore incomplete directories.
      }
    }
    return results.sort((a, b) => String(b.state.startedAt).localeCompare(String(a.state.startedAt)));
  }

  async acquireLock() {
    await ensurePrivateDir(this.runDir);
    const payload = { pid: process.pid, acquiredAt: nowIso() };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(this.lockPath, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify(payload)}\n`, "utf8");
        await handle.close();
        return payload;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        let existing = null;
        try {
          existing = JSON.parse(await readFile(this.lockPath, "utf8"));
        } catch {
          // An unreadable lock is not safe to steal automatically.
        }
        if (existing?.pid && !processAlive(existing.pid)) {
          await unlink(this.lockPath).catch(() => {});
          continue;
        }
        throw new Error(
          `Run is already active${existing?.pid ? ` in process ${existing.pid}` : ""}. Refusing a concurrent resume.`,
        );
      }
    }
    throw new Error("Could not acquire the run lock");
  }

  async releaseLock() {
    let existing = null;
    try {
      existing = JSON.parse(await readFile(this.lockPath, "utf8"));
    } catch {
      return;
    }
    if (existing.pid === process.pid) await unlink(this.lockPath).catch(() => {});
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

function shortEvidenceId(evidence) {
  return sha256(JSON.stringify(evidence)).slice(0, 16);
}
