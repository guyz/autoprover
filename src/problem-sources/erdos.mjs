import { sha256 } from "../utils.mjs";

const DEFAULT_TIMEOUT_MS = 15_000;
const UNRESOLVED_STATES = new Set([
  "open",
  "decidable",
  "falsifiable",
  "verifiable",
]);

export async function loadErdosProblemIndex({
  url,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  if (!url) throw new Error("An Erdős problem index URL is required");
  if (typeof fetchImpl !== "function") {
    throw new Error("This runtime does not provide fetch");
  }
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("Erdős problem index request timed out")),
    timeoutMs,
  );
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      headers: {
        accept: "text/plain, application/yaml;q=0.9, */*;q=0.1",
        "user-agent": "autoprover-open-problem-discovery",
      },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(
        `Erdős problem index returned HTTP ${response.status}`,
      );
    }
    const text = await response.text();
    return parseErdosProblemIndex(text);
  } finally {
    clearTimeout(timer);
  }
}

export function parseErdosProblemIndex(text) {
  const blocks = String(text)
    .split(/\n(?=- number:\s*)/)
    .map((block) => block.trim())
    .filter(Boolean);
  const entries = [];
  for (const block of blocks) {
    const number = block.match(/^- number:\s*["']?([^"'\n]+)["']?/m)?.[1]?.trim();
    const status = nestedState(block, "status");
    if (!number || !UNRESOLVED_STATES.has(status)) continue;
    const formalized = nestedState(block, "formalized");
    const tags = parseInlineList(block.match(/^\s*tags:\s*(.+)$/m)?.[1]);
    const prize = scalar(block.match(/^\s*prize:\s*(.+)$/m)?.[1]);
    entries.push({
      number,
      status,
      formalized,
      tags,
      prize,
      url: `https://www.erdosproblems.com/${encodeURIComponent(number)}`,
    });
  }
  return entries;
}

export function selectErdosProblemHints(
  entries,
  { count, seed = "autoprover-erdos" } = {},
) {
  const desired = Math.max(
    0,
    Math.min(Number(count) || 0, entries?.length ?? 0),
  );
  if (!desired) return [];
  const selected = [];
  const tagCounts = new Map();
  const pool = [...entries];
  while (selected.length < desired && pool.length) {
    const scored = pool.map((entry) => {
      const rareTagScore = entry.tags.length
        ? entry.tags.reduce(
            (sum, tag) => sum + 1 / Math.sqrt(1 + (tagCounts.get(tag) ?? 0)),
            0,
          ) / entry.tags.length
        : 0;
      const operationalStatusBonus =
        entry.status === "falsifiable" || entry.status === "decidable"
          ? 0.35
          : entry.status === "verifiable"
            ? 0.2
            : 0;
      const formalizedBonus = entry.formalized === "yes" ? 0.12 : 0;
      const jitter = deterministicUnit(
        seed,
        selected.length,
        entry.number,
      );
      return {
        entry,
        score:
          rareTagScore +
          operationalStatusBonus +
          formalizedBonus +
          0.15 * jitter,
      };
    });
    scored.sort(
      (left, right) =>
        right.score - left.score ||
        String(left.entry.number).localeCompare(String(right.entry.number)),
    );
    const winner = scored[0].entry;
    selected.push(winner);
    pool.splice(pool.indexOf(winner), 1);
    for (const tag of winner.tags) {
      tagCounts.set(tag, (tagCounts.get(tag) ?? 0) + 1);
    }
  }
  return selected;
}

function nestedState(block, key) {
  const section = block.match(
    new RegExp(
      `^\\s*${escapeRegex(key)}:\\s*\\n([\\s\\S]*?)(?=^\\s{0,2}[a-zA-Z_][\\w-]*:\\s*|(?![\\s\\S]))`,
      "m",
    ),
  )?.[1];
  return scalar(section?.match(/^\s+state:\s*(.+)$/m)?.[1]).toLowerCase();
}

function parseInlineList(value = "") {
  const text = String(value).trim();
  if (!text.startsWith("[") || !text.endsWith("]")) return [];
  return text
    .slice(1, -1)
    .split(",")
    .map((entry) => scalar(entry))
    .filter(Boolean);
}

function scalar(value = "") {
  return String(value)
    .trim()
    .replace(/^["']|["']$/g, "");
}

function deterministicUnit(...parts) {
  const digest = sha256(parts.map(String).join("\u241f"));
  return Number.parseInt(digest.slice(0, 13), 16) / 0x10000000000000;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
