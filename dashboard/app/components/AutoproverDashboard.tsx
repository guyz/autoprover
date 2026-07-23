"use client";

import {
  type CSSProperties,
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";

type ConnectionState = "connecting" | "live" | "offline";

type Campaign = {
  id: string;
  status: string;
  phase: string;
  cycle: number;
  provider: string;
  parallelProblems?: number;
  startedAt: string;
  deadlineAt: string;
  timeLeftMs: number;
  stopRequestedAt?: string | null;
  latestNote?: string;
  budget: {
    callsStarted: number;
    callsCompleted: number;
    callsFailed: number;
    maxCalls: number;
    estimatedUsd?: number;
  };
};

type DashboardCounts = {
  catalog: number;
  queued: number;
  active: number;
  candidates: number;
  reproduced: number;
};

type CatalogAttempt = {
  attemptId: string;
  outcome: string;
  startedAt?: string;
  completedAt?: string;
  activeWorkMs: number;
  callsStarted: number;
  rounds: number;
  evidenceCount: number;
  candidateKind?: string | null;
  note?: string;
};

type CatalogProblem = {
  id: string;
  title: string;
  domain: string;
  rank: number;
  state: string;
  interest: number;
  solvability: number;
  priority: number;
  falsificationType?: string;
  counterexampleSearchability?: number;
  counterexampleOpportunity?: number;
  counterexampleBonus?: number;
  counterexampleVerificationPlan?: string;
  selectionReason: string;
  lastVettedAt?: string;
  attemptCount?: number;
  lastOutcome?: string;
  attemptHistory?: CatalogAttempt[];
  totalActiveWorkMs?: number;
  totalCalls?: number;
  failedAttemptCount?: number;
  interruptedAttemptCount?: number;
  operatorPinned?: boolean;
  workerSlot?: string;
};

type BranchDelta = {
  summary?: string;
  progressKind?: string;
  nextAction?: string;
};

type BranchAttempt = {
  id: string;
  title: string;
  hypothesis?: string;
  falsifier?: string;
  status: string;
  turn: number;
  round: number;
  latestSummary?: string;
  progressKind?: string;
  nextAction?: string;
  feedback?: string;
  verifiedFactsCount?: number;
  failedApproachesCount?: number;
  noProgressEpochs?: number;
  history?: BranchDelta[];
};

type VerificationPass = {
  pass: number;
  verdict: string;
  note: string;
};

type VerificationRun = {
  candidateHash: string;
  candidateClaim?: string;
  status: string;
  passes: VerificationPass[];
};

type ActiveProblem = {
  id: string;
  attemptId?: string;
  title: string;
  domain: string;
  status: string;
  round: number;
  activeWorkMs: number;
  callsStarted?: number;
  switchRequestedAt?: string | null;
  coordinatorNote?: string;
  statement?: string;
  sourceUrls?: string[];
  branches: BranchAttempt[];
  verification?: VerificationRun[];
  verificationRuns?: VerificationRun[];
};

type ResearchEvent = {
  id: string;
  at: string;
  level: "info" | "success" | "warning" | "error" | "diagnostic";
  kind: string;
  title: string;
  note: string;
  problemId?: string;
  branchId?: string;
};

type ManualPacket = {
  packetId: string;
  role?: string;
  prompt?: string;
  waitingSince?: string;
};

type DashboardServer = {
  commandToken?: string | null;
  recentProcessNotes?: Array<{
    at: string;
    level: string;
    message: string;
  }>;
};

type OperatorCommand = {
  id: string;
  type: string;
  status: string;
  createdAt: string;
  problemKey?: string | null;
  query?: string | null;
  error?: string | null;
};

type DashboardData = {
  server: DashboardServer;
  campaign: Campaign | null;
  counts: DashboardCounts;
  catalog: CatalogProblem[];
  activeProblems: ActiveProblem[];
  events: ResearchEvent[];
  manualQueue: ManualPacket[];
  operatorCommands: OperatorCommand[];
};

type CampaignSettings = {
  provider: string;
  hours: number;
  parallelProblems: number;
  maxCalls: number;
};

const EMPTY_DATA: DashboardData = {
  server: { commandToken: null },
  campaign: null,
  counts: {
    catalog: 0,
    queued: 0,
    active: 0,
    candidates: 0,
    reproduced: 0,
  },
  catalog: [],
  activeProblems: [],
  events: [],
  manualQueue: [],
  operatorCommands: [],
};

const DEMO_DATA: DashboardData = {
  server: { commandToken: null },
  campaign: {
    id: "campaign-demo-0723",
    status: "running",
    phase: "attacking",
    cycle: 3,
    provider: "max",
    startedAt: "2026-07-23T11:08:00.000Z",
    deadlineAt: "2026-07-24T11:08:00.000Z",
    timeLeftMs: 7 * 3_600_000 + 42 * 60_000,
    latestNote:
      "Two branches produced new information this round; the coordinator is merging one finite-search lead before the next pass.",
    budget: {
      callsStarted: 31,
      callsCompleted: 28,
      callsFailed: 1,
      maxCalls: 60,
    },
  },
  counts: {
    catalog: 84,
    queued: 17,
    active: 2,
    candidates: 1,
    reproduced: 0,
  },
  catalog: [
    {
      id: "lonely-runner",
      title: "Lonely Runner Conjecture",
      domain: "Diophantine approximation",
      rank: 1,
      state: "active",
      interest: 5,
      solvability: 4.1,
      priority: 91,
      selectionReason:
        "High mathematical interest with finite reductions that support exact search and falsifiable intermediate claims.",
      lastVettedAt: "2026-07-23T10:42:00.000Z",
      attemptCount: 2,
      workerSlot: "Worker slot 1",
    },
    {
      id: "union-closed",
      title: "Union-Closed Sets Conjecture",
      domain: "Extremal combinatorics",
      rank: 2,
      state: "active",
      interest: 4.8,
      solvability: 3.9,
      priority: 86,
      selectionReason:
        "Recent structural bounds create several independently testable routes without requiring a full formalization stack.",
      lastVettedAt: "2026-07-23T10:46:00.000Z",
      attemptCount: 1,
      workerSlot: "Worker slot 2",
    },
    {
      id: "erdos-straus",
      title: "Erdős–Straus Conjecture",
      domain: "Number theory",
      rank: 3,
      state: "queued",
      interest: 4.6,
      solvability: 3.6,
      priority: 81,
      selectionReason:
        "Exact modular computation is cheap, but a useful attack needs a genuinely new residue-class argument.",
      lastVettedAt: "2026-07-23T10:51:00.000Z",
      attemptCount: 0,
    },
    {
      id: "graceful-tree",
      title: "Graceful Tree Conjecture",
      domain: "Graph theory",
      rank: 4,
      state: "queued",
      interest: 4.2,
      solvability: 3.7,
      priority: 79,
      selectionReason:
        "Searchable finite families and constructive subcases give the agents measurable progress signals.",
      lastVettedAt: "2026-07-23T10:55:00.000Z",
      attemptCount: 0,
    },
    {
      id: "hadwiger-nelson",
      title: "Plane Chromatic Number",
      domain: "Discrete geometry",
      rank: 5,
      state: "cooldown",
      interest: 5,
      solvability: 2.8,
      priority: 75,
      selectionReason:
        "Exceptionally interesting, but prior cycles found no tractable improvement beyond known finite constructions.",
      lastVettedAt: "2026-07-22T18:30:00.000Z",
      attemptCount: 3,
      lastOutcome: "No new information after three portfolio rounds",
    },
  ],
  activeProblems: [
    {
      id: "lonely-runner",
      title: "Lonely Runner Conjecture",
      domain: "Diophantine approximation",
      status: "active",
      round: 4,
      activeWorkMs: 3 * 3_600_000 + 18 * 60_000,
      coordinatorNote:
        "The torus-covering and obstruction-search branches now share the same six-runner boundary case. Keep the computational branch independent; ask the structural branch to explain why the observed gap pattern must persist.",
      statement:
        "For any finite set of runners with distinct constant speeds on a unit circular track, each runner is at some time at distance at least 1/n from every other runner, where n is the number of runners.",
      sourceUrls: ["https://en.wikipedia.org/wiki/Lonely_runner_conjecture"],
      branches: [
        {
          id: "torus-cover",
          title: "Torus-covering reformulation",
          hypothesis:
            "A minimal uncovered point forces a rigid ordering of the critical coordinate hyperplanes.",
          falsifier:
            "An exact six-speed instance whose uncovered cells violate the proposed ordering.",
          status: "running",
          turn: 4,
          round: 4,
          latestSummary:
            "Reduced the remaining obstruction to two boundary cell types and verified the reduction symbolically for dimensions four and five.",
          progressKind: "verified fact",
          nextAction: "deepen",
          feedback:
            "Prove that the second cell type cannot be minimal; do not reuse the numerical-volume argument.",
          verifiedFactsCount: 7,
          failedApproachesCount: 2,
          noProgressEpochs: 0,
        },
        {
          id: "finite-obstruction",
          title: "Exact finite obstruction search",
          hypothesis:
            "Every minimal six-runner obstruction has a representative below the current denominator bound.",
          falsifier:
            "A certified feasible obstruction outside the enumerated normal forms.",
          status: "verifying",
          turn: 3,
          round: 4,
          latestSummary:
            "Generated 1,284 normal forms and isolated one candidate lemma connecting denominator growth to a forbidden gap cycle.",
          progressKind: "candidate",
          nextAction: "verify",
          feedback:
            "Reproduce the normal-form count from a fresh script before sharing the lemma with other branches.",
          verifiedFactsCount: 4,
          failedApproachesCount: 1,
          noProgressEpochs: 0,
        },
        {
          id: "gap-extremal",
          title: "Extremal gap argument",
          hypothesis:
            "The largest cyclic gap admits a compression that preserves loneliness constraints.",
          falsifier:
            "A primitive speed tuple for which every compression loses a critical witness time.",
          status: "reframing",
          turn: 3,
          round: 3,
          latestSummary:
            "The compression claim fails for an exact five-speed tuple; the counterexample prunes the original induction.",
          progressKind: "refuted path",
          nextAction: "reframe",
          feedback:
            "Restart from the counterexample’s symmetry rather than repairing the failed compression.",
          verifiedFactsCount: 2,
          failedApproachesCount: 4,
          noProgressEpochs: 2,
        },
      ],
      verification: [
        {
          candidateHash: "f2d7c81a",
          candidateClaim:
            "Every normalized six-runner obstruction below denominator 48 contains a forbidden gap cycle.",
          status: "checking",
          passes: [
            {
              pass: 1,
              verdict: "pass",
              note: "Independent exact enumeration reproduced all 1,284 normal forms.",
            },
            {
              pass: 2,
              verdict: "running",
              note: "Auditing completeness of the normalization map.",
            },
          ],
        },
      ],
    },
    {
      id: "union-closed",
      title: "Union-Closed Sets Conjecture",
      domain: "Extremal combinatorics",
      status: "active",
      round: 3,
      activeWorkMs: 2 * 3_600_000 + 46 * 60_000,
      coordinatorNote:
        "One entropy inequality survived small-family checks. The next round is separating a genuinely stronger lemma from a restatement of the known averaging bound.",
      branches: [
        {
          id: "entropy",
          title: "Entropy deficit",
          status: "running",
          turn: 3,
          round: 3,
          latestSummary:
            "Found an exact deficit identity for separating families and confirmed it on all reduced families through size 11.",
          progressKind: "verified fact",
          nextAction: "deepen",
          feedback: "State the equality conditions before attempting the global bound.",
          verifiedFactsCount: 5,
          failedApproachesCount: 1,
        },
        {
          id: "minimal-counterexample",
          title: "Minimal-counterexample structure",
          status: "running",
          turn: 2,
          round: 3,
          latestSummary:
            "Pruned two proposed frequency profiles using exact closure constraints.",
          progressKind: "search pruning",
          nextAction: "branch",
          feedback: "Fork the remaining asymmetric profile into its own isolated search.",
          verifiedFactsCount: 3,
          failedApproachesCount: 2,
        },
      ],
      verification: [],
    },
  ],
  events: [
    {
      id: "evt-7",
      at: "2026-07-23T15:22:00.000Z",
      level: "warning",
      kind: "coordinator",
      title: "Gap argument is being reframed",
      note: "An exact counterexample invalidated the branch’s compression step. The failed route was recorded and the next attempt starts from a fresh representation.",
      problemId: "lonely-runner",
      branchId: "gap-extremal",
    },
    {
      id: "evt-6",
      at: "2026-07-23T15:18:00.000Z",
      level: "success",
      kind: "verification",
      title: "First independent check passed",
      note: "A fresh enumeration reproduced all 1,284 finite normal forms. Completeness of the normalization is still under audit.",
      problemId: "lonely-runner",
      branchId: "finite-obstruction",
    },
    {
      id: "evt-5",
      at: "2026-07-23T15:11:00.000Z",
      level: "info",
      kind: "research",
      title: "Entropy branch added a verified identity",
      note: "The identity passed exact checks on every reduced union-closed family through size 11.",
      problemId: "union-closed",
      branchId: "entropy",
    },
    {
      id: "evt-4",
      at: "2026-07-23T15:02:00.000Z",
      level: "info",
      kind: "coordinator",
      title: "Portfolio round 3 synthesized",
      note: "Two duplicate directions were merged. Each active branch received a distinct next transition.",
      problemId: "union-closed",
    },
    {
      id: "evt-3",
      at: "2026-07-23T14:54:00.000Z",
      level: "diagnostic",
      kind: "model",
      title: "Solver turn completed",
      note: "Max returned a schema-valid research delta in 18m 42s.",
      problemId: "lonely-runner",
      branchId: "torus-cover",
    },
    {
      id: "evt-2",
      at: "2026-07-23T14:40:00.000Z",
      level: "info",
      kind: "catalog",
      title: "Open status rechecked",
      note: "Five queued problem packets were independently re-vetted against current sources.",
    },
  ],
  manualQueue: [],
  operatorCommands: [],
};

const PROVIDERS = [
  { value: "max", label: "GPT-5.6 Sol Max" },
  { value: "pro", label: "GPT-5.6 Sol Pro · API" },
  { value: "pro-manual", label: "GPT-5.6 Sol Pro · Manual" },
  { value: "fable", label: "Claude Fable 5" },
];

const ACTIVE_CAMPAIGN_STATES = new Set([
  "running",
  "discovering",
  "ranking",
  "attacking",
  "verifying",
  "stopping",
]);

const RESUMABLE_CAMPAIGN_STATES = new Set([
  "paused",
  "stopped",
  "deadline-reached",
  "budget-exhausted",
  "completed",
  "completed-no-result",
  "completed-with-candidate",
  "completed-with-errors",
  "completed-with-candidate-and-errors",
  "awaiting-manual",
  "catalog-exhausted",
]);

function normalizeDashboard(input: unknown): DashboardData {
  if (!input || typeof input !== "object") {
    throw new Error("Dashboard response is not an object");
  }
  const raw = input as {
    server?: DashboardServer;
    campaign?: Campaign | null;
    counts?: Partial<DashboardCounts>;
    activeProblems?: ActiveProblem[];
    completedProblems?: ActiveProblem[];
    events?: ResearchEvent[];
    notes?: ResearchEvent[];
    catalog?: CatalogProblem[] | { items?: CatalogProblem[] };
    manualQueue?: ManualPacket[];
    operatorCommands?: OperatorCommand[];
  };
  const catalog = Array.isArray(raw.catalog)
    ? raw.catalog
    : Array.isArray(raw.catalog?.items)
      ? raw.catalog.items
      : [];
  const liveProblems = Array.isArray(raw.activeProblems)
    ? raw.activeProblems
    : [];
  const completedProblems = Array.isArray(raw.completedProblems)
    ? raw.completedProblems
    : [];
  const liveProblemIds = new Set(liveProblems.map((problem) => problem.id));
  const activeProblems = [
    ...liveProblems,
    ...completedProblems.filter((problem) => !liveProblemIds.has(problem.id)),
  ];
  const researchEvents = Array.isArray(raw.events)
    ? raw.events
    : Array.isArray(raw.notes)
      ? raw.notes
      : [];
  const processEvents: ResearchEvent[] = (
    raw.server?.recentProcessNotes ?? []
  ).map((note, index) => ({
    id: `controller-${note.at}-${index}`,
    at: note.at,
    level:
      note.level === "error"
        ? "error"
        : note.level === "warning"
          ? "warning"
          : "diagnostic",
    kind: "controller",
    title:
      note.level === "error"
        ? "Controller process error"
        : note.level === "warning"
          ? "Controller process warning"
          : "Controller process update",
    note: note.message.trim(),
  }));
  const events = [...researchEvents, ...processEvents].sort((left, right) =>
    right.at.localeCompare(left.at),
  );
  const derivedCounts: DashboardCounts = {
    catalog: catalog.length,
    queued: catalog.filter((problem) =>
      ["queued", "vetted", "ready"].includes(problem.state),
    ).length,
    active: activeProblems.filter((problem) =>
      ["active", "running", "verifying"].includes(problem.status),
    ).length,
    candidates: activeProblems.reduce(
      (total, problem) =>
        total +
        (problem.verification ?? problem.verificationRuns ?? []).length,
      0,
    ),
    reproduced: activeProblems.reduce(
      (total, problem) =>
        total +
        (problem.verification ?? problem.verificationRuns ?? []).filter(
          (run) =>
            run.status === "agent-reproduced-candidate" ||
            run.status === "reproduced",
        ).length,
      0,
    ),
  };
  return {
    server: raw.server ?? { commandToken: null },
    campaign: raw.campaign === undefined ? null : raw.campaign,
    counts: { ...derivedCounts, ...(raw.counts ?? {}) },
    catalog,
    activeProblems,
    events,
    manualQueue: Array.isArray(raw.manualQueue) ? raw.manualQueue : [],
    operatorCommands: Array.isArray(raw.operatorCommands)
      ? raw.operatorCommands
      : [],
  };
}

function scoreStyle(value: number, max: number): CSSProperties {
  return { width: `${Math.max(0, Math.min(100, (value / max) * 100))}%` };
}

function statusTone(status: string) {
  const normalized = status.toLowerCase();
  if (
    normalized.includes("reproduced") ||
    normalized.includes("passed") ||
    normalized === "candidate"
  ) {
    return "success";
  }
  if (
    normalized.includes("failed") ||
    normalized.includes("error") ||
    normalized.includes("rejected")
  ) {
    return "danger";
  }
  if (
    normalized.includes("waiting") ||
    normalized.includes("refram") ||
    normalized.includes("cooldown") ||
    normalized.includes("stopping")
  ) {
    return "warning";
  }
  if (
    normalized.includes("active") ||
    normalized.includes("running") ||
    normalized.includes("verify") ||
    normalized.includes("attack") ||
    normalized.includes("discover")
  ) {
    return "active";
  }
  return "neutral";
}

function titleCase(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDuration(milliseconds: number) {
  const safe = Math.max(0, milliseconds || 0);
  const totalMinutes = Math.floor(safe / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatUtcTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.valueOf())) return "—";
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function campaignIsActive(campaign: Campaign | null) {
  return campaign ? ACTIVE_CAMPAIGN_STATES.has(campaign.status) : false;
}

function ScoreMeter({
  label,
  value,
  max,
  priority = false,
}: {
  label: string;
  value: number;
  max: number;
  priority?: boolean;
}) {
  const display = priority ? Math.round(value) : value.toFixed(1);
  return (
    <div className={`scoreMeter ${priority ? "scoreMeterPriority" : ""}`}>
      <div className="scoreLabel">
        <span>{label}</span>
        <strong>
          {display}
          <span className="scoreMax">/{max}</span>
        </strong>
      </div>
      <div
        className="scoreTrack"
        role="progressbar"
        aria-label={`${label}: ${display} out of ${max}`}
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={value}
      >
        <span className="scoreFill" style={scoreStyle(value, max)} />
      </div>
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  return (
    <span className={`statusChip status-${statusTone(status)}`}>
      <span className="statusDot" aria-hidden="true" />
      {titleCase(status)}
    </span>
  );
}

function KpiCard({
  label,
  value,
  detail,
  accent,
}: {
  label: string;
  value: string | number;
  detail: string;
  accent: string;
}) {
  return (
    <article className="kpiCard" style={{ "--kpi-accent": accent } as CSSProperties}>
      <span className="kpiLabel">{label}</span>
      <strong className="kpiValue">{value}</strong>
      <span className="kpiDetail">{detail}</span>
    </article>
  );
}

export default function AutoproverDashboard() {
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [connection, setConnection] =
    useState<ConnectionState>("connecting");
  const [lastSync, setLastSync] = useState("Waiting for controller");
  const [selectedId, setSelectedId] = useState("");
  const [settings, setSettings] = useState<CampaignSettings>({
    provider: "max",
    hours: 24,
    parallelProblems: 2,
    maxCalls: 60,
  });
  const [commandPending, setCommandPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [manualResponse, setManualResponse] = useState("");
  const [problemSuggestion, setProblemSuggestion] = useState("");
  const hasLiveData = useRef(false);
  const hydratedCampaignId = useRef("");

  useEffect(() => {
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;

    const poll = async () => {
      try {
        const response = await fetch("/api/dashboard", {
          cache: "no-store",
          headers: { accept: "application/json" },
        });
        if (!response.ok) {
          throw new Error(`Dashboard API returned ${response.status}`);
        }
        const next = normalizeDashboard(await response.json());
        if (cancelled) return;
        hasLiveData.current = true;
        setData(next);
        setConnection("live");
        setLastSync(`${formatUtcTime(new Date().toISOString())}`);
      } catch {
        if (cancelled) return;
        setConnection("offline");
        const demoRequested =
          new URLSearchParams(window.location.search).get("demo") === "1";
        if (!hasLiveData.current) {
          setData(demoRequested ? DEMO_DATA : EMPTY_DATA);
        }
        setLastSync(
          hasLiveData.current
            ? "Connection lost · showing last update"
            : demoRequested
              ? "Demo snapshot"
              : "Controller unavailable",
        );
      } finally {
        if (!cancelled) timeout = setTimeout(poll, 2_000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, []);

  useEffect(() => {
    if (
      connection !== "live" ||
      !data.campaign ||
      hydratedCampaignId.current === data.campaign.id
    ) {
      return;
    }
    hydratedCampaignId.current = data.campaign.id;
    setSettings((current) => ({
      ...current,
      provider: data.campaign?.provider ?? current.provider,
      parallelProblems:
        data.campaign?.parallelProblems ?? current.parallelProblems,
      maxCalls: data.campaign?.budget.maxCalls ?? current.maxCalls,
    }));
  }, [connection, data.campaign]);

  const allProblemIds = new Set([
    ...data.catalog.map((problem) => problem.id),
    ...data.activeProblems.map((problem) => problem.id),
  ]);
  const effectiveSelectedId = allProblemIds.has(selectedId)
    ? selectedId
    : (data.activeProblems[0]?.id ?? data.catalog[0]?.id ?? "");
  const catalogProblem = data.catalog.find(
    (problem) => problem.id === effectiveSelectedId,
  );
  const activeProblem = data.activeProblems.find(
    (problem) => problem.id === effectiveSelectedId,
  );
  const selectedProblemIsRunning = Boolean(
    activeProblem &&
      ["active", "running", "verifying", "planning", "starting"].includes(
        activeProblem.status,
      ),
  );
  const verificationRuns =
    activeProblem?.verification ?? activeProblem?.verificationRuns ?? [];
  const visibleEvents = data.events.filter(
    (event) => showDiagnostics || event.level !== "diagnostic",
  );
  const isActive = campaignIsActive(data.campaign);
  const isStopping = data.campaign?.status === "stopping";
  const canResume = Boolean(
    data.campaign && RESUMABLE_CAMPAIGN_STATES.has(data.campaign.status),
  );
  const callPercent = data.campaign?.budget.maxCalls
    ? Math.min(
        100,
        (data.campaign.budget.callsStarted / data.campaign.budget.maxCalls) *
          100,
      )
    : 0;
  const firstManualPacket = data.manualQueue[0];
  const commandToken = data.server.commandToken;
  const commandsAvailable =
    connection === "live" && typeof commandToken === "string" && commandToken.length > 0;
  const nudgeCommandsInFlight = data.operatorCommands.filter((command) =>
    ["pending", "running"].includes(command.status),
  ).length;

  async function sendCommand(
    action: "start" | "stop" | "resume",
    payload: Record<string, unknown>,
  ) {
    if (!commandsAvailable || !commandToken) {
      setFeedback(
        "Controls are disabled until the authorized local campaign controller is connected.",
      );
      return;
    }
    setCommandPending(action);
    setFeedback("");
    try {
      const response = await fetch(`/api/campaign/${action}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-autoprover-command-token": commandToken,
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          result.error || result.message || `Command failed (${response.status})`,
        );
      }
      setFeedback(
        result.message ||
          (action === "start"
            ? "Campaign is starting."
            : action === "stop"
              ? "Safe stop requested. Active work is being checkpointed."
              : `Campaign extended by ${settings.hours} hours.`),
      );
    } catch (error) {
      setFeedback(
        connection === "offline"
          ? "The local campaign controller is offline. This page is showing clearly labeled demo data."
          : error instanceof Error
            ? error.message
            : "The command could not be completed.",
      );
    } finally {
      setCommandPending(null);
    }
  }

  async function sendNudge(
    action: string,
    path: string,
    payload: Record<string, unknown> = {},
  ) {
    if (!commandsAvailable || !commandToken) {
      setFeedback(
        "Nudges require the authorized local campaign controller.",
      );
      return false;
    }
    setCommandPending(action);
    setFeedback("");
    try {
      const response = await fetch(path, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          "x-autoprover-command-token": commandToken,
        },
        body: JSON.stringify(payload),
      });
      const result = (await response.json().catch(() => ({}))) as {
        message?: string;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(
          result.error || result.message || `Command failed (${response.status})`,
        );
      }
      setFeedback(result.message ?? "Nudge saved.");
      return true;
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "The nudge could not be saved.",
      );
      return false;
    } finally {
      setCommandPending(null);
    }
  }

  function requestMoreProblems() {
    void sendNudge("discover", "/api/catalog/discover");
  }

  async function suggestProblem(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = problemSuggestion.trim();
    if (!query) return;
    const accepted = await sendNudge("suggest", "/api/catalog/suggest", {
      query,
    });
    if (accepted) setProblemSuggestion("");
  }

  function prioritizeSelectedProblem() {
    if (!catalogProblem) return;
    void sendNudge("prioritize", "/api/catalog/prioritize", {
      problemKey: catalogProblem.id,
    });
  }

  function switchSelectedProblem() {
    if (!activeProblem?.attemptId) return;
    void sendNudge("switch", "/api/attempt/switch", {
      attemptId: activeProblem.attemptId,
      problemKey: activeProblem.id,
      reason: "Operator switched away from a stalled or lower-priority attack",
    });
  }

  function startCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendCommand("start", {
      provider: settings.provider,
      wallClockHours: settings.hours,
      parallelProblems: settings.parallelProblems,
      maxCalls: settings.maxCalls,
      continuous: true,
    });
  }

  async function copyManualPrompt() {
    if (!firstManualPacket?.prompt) return;
    try {
      await navigator.clipboard.writeText(firstManualPacket.prompt);
      setFeedback("Manual Pro prompt copied.");
    } catch {
      setFeedback("Could not access the clipboard. Select and copy the prompt below.");
    }
  }

  async function submitManualResponse() {
    if (!firstManualPacket) return;
    if (!commandsAvailable || !commandToken) {
      setFeedback(
        "Controls are disabled until the authorized local campaign controller is connected.",
      );
      return;
    }
    setCommandPending("manual");
    setFeedback("");
    try {
      const parsed = JSON.parse(manualResponse) as unknown;
      const response = await fetch(
        `/api/manual/${encodeURIComponent(firstManualPacket.packetId)}/response`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "x-autoprover-command-token": commandToken,
          },
          body: JSON.stringify(parsed),
        },
      );
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        };
        throw new Error(result.error || result.message || "Import failed");
      }
      setManualResponse("");
      setFeedback("Manual response validated and queued. The campaign will resume.");
    } catch (error) {
      setFeedback(
        error instanceof SyntaxError
          ? "The manual response is not valid JSON."
          : error instanceof Error
            ? error.message
            : "The manual response could not be imported.",
      );
    } finally {
      setCommandPending(null);
    }
  }

  return (
    <>
      <a className="skipLink" href="#main-content">
        Skip to campaign workspace
      </a>
      <div className="dashboardShell">
        <header className="appHeader">
          <div className="brandBlock">
            <span className="brandMark" aria-hidden="true">
              ∀
            </span>
            <div>
              <p className="eyebrow">Continuous mathematical research</p>
              <h1>Autoprover</h1>
            </div>
          </div>
          <div className="connectionBlock" role="status" aria-live="polite">
            <span className={`connectionPill connection-${connection}`}>
              <span aria-hidden="true" className="connectionDot" />
              {connection === "live"
                ? "Controller live"
                : connection === "offline"
                  ? "Demo · controller offline"
                  : "Preview · connecting"}
            </span>
            <span className="syncLabel">{lastSync}</span>
          </div>
        </header>

        {connection !== "live" && (
          <div className="offlineNotice" role="status">
            <strong>
              {connection === "offline" ? "Offline demo" : "Connecting"}
            </strong>
            <span>
              {connection === "offline"
                ? "The values below are illustrative and no agents are running from this page."
                : "Showing an illustrative snapshot while the local controller responds."}
            </span>
          </div>
        )}

        <section className="campaignPanel" aria-labelledby="campaign-heading">
          <div className="campaignSummary">
            <div>
              <p className="sectionKicker">Campaign control</p>
              <div className="campaignHeadingRow">
                <h2 id="campaign-heading">
                  {data.campaign
                    ? `Cycle ${data.campaign.cycle} · ${titleCase(data.campaign.phase)}`
                    : "Ready to begin"}
                </h2>
                {data.campaign && <StatusChip status={data.campaign.status} />}
              </div>
              <p className="campaignNote">
                {data.campaign?.latestNote ??
                  "The coordinator will keep the catalog fresh and fill open worker slots with high-priority problems."}
              </p>
            </div>
            <div className="campaignClock">
              <span>Time remaining</span>
              <strong>
                {data.campaign
                  ? formatDuration(data.campaign.timeLeftMs)
                  : `${settings.hours}h`}
              </strong>
              <small>
                {data.campaign
                  ? `Provider: ${PROVIDERS.find((item) => item.value === data.campaign?.provider)?.label ?? data.campaign.provider}`
                  : "Continuous discovery on"}
              </small>
            </div>
          </div>

          <form className="campaignForm" onSubmit={startCampaign}>
            <label>
              <span>Provider</span>
              <select
                value={settings.provider}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    provider: event.target.value,
                  }))
                }
              >
                {PROVIDERS.map((provider) => (
                  <option key={provider.value} value={provider.value}>
                    {provider.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>Time limit</span>
              <select
                value={settings.hours}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    hours: Number(event.target.value),
                  }))
                }
              >
                <option value={1}>1 hour · trial</option>
                <option value={2}>2 hours · trial</option>
                <option value={12}>12 hours</option>
                <option value={24}>24 hours</option>
              </select>
            </label>
            <label>
              <span>Problems in parallel</span>
              <input
                type="number"
                min={1}
                max={8}
                inputMode="numeric"
                value={settings.parallelProblems}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    parallelProblems: Math.max(
                      1,
                      Math.min(8, Number(event.target.value) || 1),
                    ),
                  }))
                }
              />
            </label>
            <label>
              <span>Maximum calls</span>
              <input
                type="number"
                min={1}
                max={1000}
                inputMode="numeric"
                value={settings.maxCalls}
                onChange={(event) =>
                  setSettings((current) => ({
                    ...current,
                    maxCalls: Math.max(1, Number(event.target.value) || 1),
                  }))
                }
              />
            </label>
            <div className="campaignActions" aria-label="Campaign actions">
              <button
                className="button buttonPrimary"
                type="submit"
                disabled={
                  !commandsAvailable ||
                  Boolean(data.campaign) ||
                  isActive ||
                  commandPending !== null
                }
                title={
                  !commandsAvailable
                    ? "Connect the authorized local controller to enable commands"
                    : data.campaign
                      ? "Use Continue to resume the existing campaign"
                      : undefined
                }
              >
                {commandPending === "start" ? "Starting…" : "Start"}
              </button>
              <button
                className="button buttonDanger"
                type="button"
                disabled={
                  !commandsAvailable ||
                  !isActive ||
                  isStopping ||
                  commandPending !== null
                }
                onClick={() => void sendCommand("stop", { mode: "graceful" })}
              >
                {commandPending === "stop" || isStopping
                  ? "Stopping safely…"
                  : "Stop safely"}
              </button>
              <button
                className="button buttonQuiet"
                type="button"
                disabled={
                  !commandsAvailable || !canResume || commandPending !== null
                }
                onClick={() =>
                  void sendCommand("resume", {
                    extendHours: settings.hours,
                    provider: settings.provider,
                    parallelProblems: settings.parallelProblems,
                    maxCalls: settings.maxCalls,
                  })
                }
              >
                {commandPending === "resume"
                  ? "Resuming…"
                  : `Continue +${settings.hours}h`}
              </button>
            </div>
          </form>
          <div className="commandFeedback" aria-live="polite">
            {feedback}
          </div>
          {data.campaign && (
            <div className="callBudget">
              <div>
                <span>Call budget</span>
                <strong>
                  {data.campaign.budget.callsStarted}/
                  {data.campaign.budget.maxCalls}
                </strong>
              </div>
              <div
                className="budgetTrack"
                role="progressbar"
                aria-label={`${data.campaign.budget.callsStarted} of ${data.campaign.budget.maxCalls} calls started`}
                aria-valuemin={0}
                aria-valuemax={data.campaign.budget.maxCalls}
                aria-valuenow={data.campaign.budget.callsStarted}
              >
                <span style={{ width: `${callPercent}%` }} />
              </div>
              <small>
                {data.campaign.budget.callsCompleted} completed ·{" "}
                {data.campaign.budget.callsFailed} failed
              </small>
            </div>
          )}
        </section>

        {firstManualPacket && (
          <section className="manualBanner" role="alert">
            <div>
              <p className="sectionKicker">Manual Pro input required</p>
              <h2>A schema-validated response is waiting</h2>
              <p>
                Packet <code>{firstManualPacket.packetId}</code>
                {firstManualPacket.role ? ` · ${firstManualPacket.role}` : ""}
              </p>
            </div>
            <details className="manualDetails">
              <summary>Review and respond</summary>
              {firstManualPacket.prompt ? (
                <>
                  <button
                    className="textButton"
                    type="button"
                    onClick={() => void copyManualPrompt()}
                  >
                    Copy prompt
                  </button>
                  <pre tabIndex={0}>{firstManualPacket.prompt}</pre>
                </>
              ) : (
                <p>The controller is preparing the prompt body.</p>
              )}
              <label>
                <span>Paste the Pro JSON response</span>
                <textarea
                  value={manualResponse}
                  onChange={(event) => setManualResponse(event.target.value)}
                  rows={6}
                  spellCheck={false}
                />
              </label>
              <button
                type="button"
                className="button buttonPrimary"
                disabled={
                  !commandsAvailable ||
                  !manualResponse.trim() ||
                  commandPending !== null
                }
                onClick={() => void submitManualResponse()}
              >
                Validate and resume
              </button>
            </details>
          </section>
        )}

        <main id="main-content">
          <section className="kpiGrid" aria-label="Campaign overview">
            <KpiCard
              label="Problem catalog"
              value={data.counts.catalog}
              detail="vetted and deduplicated"
              accent="#3478aa"
            />
            <KpiCard
              label="Up next"
              value={data.counts.queued}
              detail="ranked by expected value"
              accent="#b07b27"
            />
            <KpiCard
              label="Active"
              value={data.counts.active}
              detail={`${settings.parallelProblems} worker slots configured`}
              accent="#14786f"
            />
            <KpiCard
              label="Candidates"
              value={data.counts.candidates}
              detail="including verified partials"
              accent="#7656a6"
            />
            <KpiCard
              label="Reproduced"
              value={data.counts.reproduced}
              detail="independent checks passed"
              accent="#2f8053"
            />
          </section>

          <div className="workspaceGrid">
            <section className="panel catalogPanel" aria-labelledby="queue-heading">
              <div className="panelHeader">
                <div>
                  <p className="sectionKicker">Live portfolio</p>
                  <h2 id="queue-heading">Problem queue</h2>
                </div>
                <span className="rankHint">
                  Expected value + verifier leverage
                </span>
              </div>
              <p className="panelIntro">
                One lease per problem keeps parallel workers from duplicating
                the same attack.
              </p>
              <div className="nudgeBar" aria-label="Catalog nudges">
                <button
                  type="button"
                  className="button buttonQuiet"
                  disabled={
                    !commandsAvailable ||
                    !data.campaign ||
                    commandPending !== null
                  }
                  onClick={requestMoreProblems}
                  title="Runs another sourced and independently vetted discovery cycle"
                >
                  Find more
                </button>
                <form className="suggestProblemForm" onSubmit={suggestProblem}>
                  <label className="srOnly" htmlFor="suggest-problem">
                    Problem name or source URL
                  </label>
                  <input
                    id="suggest-problem"
                    type="text"
                    value={problemSuggestion}
                    maxLength={500}
                    placeholder="Problem name or source URL"
                    onChange={(event) =>
                      setProblemSuggestion(event.target.value)
                    }
                    disabled={!commandsAvailable || !data.campaign}
                  />
                  <button
                    type="submit"
                    className="button buttonQuiet"
                    disabled={
                      !commandsAvailable ||
                      !data.campaign ||
                      !problemSuggestion.trim() ||
                      commandPending !== null
                    }
                  >
                    Add
                  </button>
                </form>
                {nudgeCommandsInFlight > 0 && (
                  <span className="nudgeStatus">
                    {nudgeCommandsInFlight} queued
                  </span>
                )}
              </div>
              {data.catalog.length ? (
                <ol className="catalogList">
                  {data.catalog.map((problem) => {
                    const selected = problem.id === effectiveSelectedId;
                    return (
                      <li key={problem.id}>
                        <button
                          type="button"
                          className={`catalogItem ${selected ? "catalogItemSelected" : ""}`}
                          aria-current={selected ? "true" : undefined}
                          onClick={() => setSelectedId(problem.id)}
                        >
                          <span className="catalogRank" aria-label={`Rank ${problem.rank}`}>
                            {problem.rank}
                          </span>
                          <span className="catalogBody">
                            <span className="catalogTopline">
                              <strong>{problem.title}</strong>
                              <StatusChip status={problem.state} />
                            </span>
                            <span className="catalogDomain">{problem.domain}</span>
                            <span className="catalogScores">
                              <span>
                                Interest <strong>{problem.interest.toFixed(1)}</strong>
                              </span>
                              <span>
                                Solvability{" "}
                                <strong>{problem.solvability.toFixed(1)}</strong>
                              </span>
                              <span className="catalogPriority">
                                Priority <strong>{Math.round(problem.priority)}</strong>
                              </span>
                              {(problem.counterexampleBonus ?? 0) > 0 && (
                                <span className="counterexampleLift">
                                  Counterexample +
                                  <strong>
                                    {problem.counterexampleBonus?.toFixed(1)}
                                  </strong>
                                </span>
                              )}
                            </span>
                            {(problem.attemptCount ?? 0) > 0 && (
                              <span className="attemptFootprint">
                                {problem.attemptCount} attempt
                                {problem.attemptCount === 1 ? "" : "s"} ·{" "}
                                {formatDuration(problem.totalActiveWorkMs ?? 0)} worked
                                {" · "}
                                {problem.totalCalls ?? 0} calls
                                {(problem.failedAttemptCount ?? 0) > 0
                                  ? ` · ${problem.failedAttemptCount} failed`
                                  : ""}
                              </span>
                            )}
                            <span className="selectionReason">
                              {problem.selectionReason}
                            </span>
                            {problem.workerSlot && (
                              <span className="workerLease">
                                <span aria-hidden="true">↳</span> {problem.workerSlot}
                              </span>
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ol>
              ) : (
                <div className="emptyState">
                  <strong>
                    {connection === "connecting"
                      ? "Connecting to the controller."
                      : connection === "offline" && !data.campaign
                        ? "No live campaign connection."
                      : !data.campaign
                        ? "No campaign has been started."
                        : isActive
                          ? "Discovery is building the first catalog."
                          : "No vetted problems are available."}
                  </strong>
                  <span>
                    {connection === "connecting"
                      ? "Live campaign state will appear momentarily."
                      : connection === "offline" && !data.campaign
                        ? "Open the local controller at 127.0.0.1:4317 to start or monitor research."
                      : !data.campaign
                        ? "Choose your trial settings above, then press Start."
                        : isActive
                          ? "New problems will appear after their open status is vetted."
                          : "Resume the campaign to run another discovery cycle."}
                  </span>
                </div>
              )}
            </section>

            <section className="panel detailPanel" aria-labelledby="problem-heading">
              {catalogProblem || activeProblem ? (
                <>
                  <div className="problemHeader">
                    <div>
                      <p className="sectionKicker">
                        {activeProblem ? `Round ${activeProblem.round}` : "Queued"}
                        {" · "}
                        {activeProblem?.domain ?? catalogProblem?.domain}
                      </p>
                      <h2 id="problem-heading">
                        {activeProblem?.title ?? catalogProblem?.title}
                      </h2>
                    </div>
                    <StatusChip
                      status={
                        activeProblem?.status ?? catalogProblem?.state ?? "queued"
                      }
                    />
                  </div>

                  {catalogProblem && (
                    <div className="scoreGrid" aria-label="Problem ranking">
                      <ScoreMeter
                        label="Interest"
                        value={catalogProblem.interest}
                        max={5}
                      />
                      <ScoreMeter
                        label="Solvability"
                        value={catalogProblem.solvability}
                        max={5}
                      />
                      <ScoreMeter
                        label="Priority"
                        value={catalogProblem.priority}
                        max={100}
                        priority
                      />
                      {(catalogProblem.counterexampleOpportunity ?? 0) > 0 && (
                        <ScoreMeter
                          label="Counterexample"
                          value={catalogProblem.counterexampleOpportunity ?? 0}
                          max={5}
                        />
                      )}
                    </div>
                  )}

                  {activeProblem ? (
                    <>
                      <section
                        className="coordinatorNote"
                        aria-labelledby="coordinator-heading"
                      >
                        <div className="noteIcon" aria-hidden="true">
                          ∑
                        </div>
                        <div>
                          <p className="sectionKicker">
                            Portfolio coordinator
                          </p>
                          <h3 id="coordinator-heading">
                            {selectedProblemIsRunning
                              ? "What is happening now"
                              : "Final attempt report"}
                          </h3>
                          <p>
                            {activeProblem.coordinatorNote ??
                              "The first branch deltas are still being collected."}
                          </p>
                        </div>
                        <div className="problemRuntime">
                          <span className="activeTime">
                            {formatDuration(activeProblem.activeWorkMs)}{" "}
                            {selectedProblemIsRunning ? "active" : "worked"}
                          </span>
                          <small>{activeProblem.callsStarted ?? 0} calls</small>
                          {selectedProblemIsRunning && activeProblem.attemptId && (
                            <button
                              type="button"
                              className="textButton switchButton"
                              disabled={
                                !commandsAvailable ||
                                commandPending !== null ||
                                Boolean(activeProblem.switchRequestedAt)
                              }
                              onClick={switchSelectedProblem}
                            >
                              {activeProblem.switchRequestedAt
                                ? "Switch pending"
                                : "Switch out"}
                            </button>
                          )}
                        </div>
                      </section>

                      {activeProblem.statement && (
                        <details className="statementDisclosure">
                          <summary>Exact problem statement and sources</summary>
                          <p>{activeProblem.statement}</p>
                          {activeProblem.sourceUrls?.length ? (
                            <ul>
                              {activeProblem.sourceUrls.map((url) => (
                                <li key={url}>
                                  <a href={url} target="_blank" rel="noreferrer">
                                    {url}
                                  </a>
                                </li>
                              ))}
                            </ul>
                          ) : null}
                        </details>
                      )}

                      <section
                        className="attemptsSection"
                        aria-labelledby="attempts-heading"
                      >
                        <div className="subsectionHeading">
                          <div>
                            <p className="sectionKicker">Isolated workspaces</p>
                            <h3 id="attempts-heading">Parallel attempts</h3>
                          </div>
                          <span>
                            {activeProblem.branches.filter((branch) =>
                              ["running", "active", "verifying"].includes(
                                branch.status,
                              ),
                            ).length}{" "}
                            moving
                          </span>
                        </div>
                        <div className="branchList">
                          {activeProblem.branches.map((branch) => {
                            const latest = branch.history?.at(-1);
                            return (
                              <details
                                className="branchCard"
                                key={branch.id}
                              >
                                <summary>
                                  <span
                                    className={`branchRail status-${statusTone(branch.status)}`}
                                    aria-hidden="true"
                                  />
                                  <span className="branchSummaryMain">
                                    <span className="branchTitleRow">
                                      <strong>{branch.title}</strong>
                                      <StatusChip status={branch.status} />
                                    </span>
                                    <span className="branchMeta">
                                      Turn {branch.turn} · Round {branch.round}
                                    </span>
                                    <span className="branchLatest">
                                      {branch.latestSummary ??
                                        latest?.summary ??
                                        "Waiting for the first research delta."}
                                    </span>
                                  </span>
                                  <span className="branchAction">
                                    {titleCase(
                                      branch.nextAction ??
                                        latest?.nextAction ??
                                        "waiting",
                                    )}
                                  </span>
                                </summary>
                                <div className="branchDetail">
                                  {(branch.hypothesis || branch.falsifier) && (
                                    <dl className="branchContract">
                                      {branch.hypothesis && (
                                        <div>
                                          <dt>Hypothesis</dt>
                                          <dd>{branch.hypothesis}</dd>
                                        </div>
                                      )}
                                      {branch.falsifier && (
                                        <div>
                                          <dt>Falsifier</dt>
                                          <dd>{branch.falsifier}</dd>
                                        </div>
                                      )}
                                    </dl>
                                  )}
                                  <div className="branchFeedback">
                                    <span>Coordinator note</span>
                                    <p>
                                      {branch.feedback ||
                                        "No new direction has been issued."}
                                    </p>
                                  </div>
                                  <div className="branchStats">
                                    <span>
                                      <strong>
                                        {branch.verifiedFactsCount ?? 0}
                                      </strong>{" "}
                                      verified facts
                                    </span>
                                    <span>
                                      <strong>
                                        {branch.failedApproachesCount ?? 0}
                                      </strong>{" "}
                                      failed paths recorded
                                    </span>
                                    <span>
                                      <strong>
                                        {branch.noProgressEpochs ?? 0}
                                      </strong>{" "}
                                      stagnant rounds
                                    </span>
                                    {(branch.progressKind ??
                                      latest?.progressKind) && (
                                      <span className="evidenceTag">
                                        {titleCase(
                                          branch.progressKind ??
                                            latest?.progressKind ??
                                            "",
                                        )}
                                      </span>
                                    )}
                                  </div>
                                </div>
                              </details>
                            );
                          })}
                        </div>
                      </section>

                      <section
                        className="verificationSection"
                        aria-labelledby="verification-heading"
                      >
                        <div className="subsectionHeading">
                          <div>
                            <p className="sectionKicker">Adversarial checks</p>
                            <h3 id="verification-heading">Verification</h3>
                          </div>
                          <span>{verificationRuns.length} candidate runs</span>
                        </div>
                        {verificationRuns.length ? (
                          <div className="verificationList">
                            {verificationRuns.map((run) => (
                              <article
                                className="verificationCard"
                                key={run.candidateHash}
                              >
                                <div className="verificationTopline">
                                  <div>
                                    <span className="candidateHash">
                                      Candidate {run.candidateHash.slice(0, 8)}
                                    </span>
                                    <h4>
                                      {run.candidateClaim ??
                                        "Candidate under independent review"}
                                    </h4>
                                  </div>
                                  <StatusChip status={run.status} />
                                </div>
                                <ol className="passList">
                                  {run.passes.map((pass) => (
                                    <li key={pass.pass}>
                                      <span
                                        className={`passIndex status-${statusTone(pass.verdict)}`}
                                      >
                                        {pass.pass}
                                      </span>
                                      <span>
                                        <strong>
                                          Pass {pass.pass} ·{" "}
                                          {titleCase(pass.verdict)}
                                        </strong>
                                        <small>{pass.note}</small>
                                      </span>
                                    </li>
                                  ))}
                                </ol>
                              </article>
                            ))}
                          </div>
                        ) : (
                          <div className="emptyState compact">
                            <strong>No candidate is under review yet.</strong>
                            <span>
                              Verifiers start automatically when a branch produces
                              a checkable claim.
                            </span>
                          </div>
                        )}
                      </section>
                    </>
                  ) : (
                    <div className="queuedDetail">
                      <p className="sectionKicker">Selection rationale</p>
                      <h3>Waiting for a worker slot</h3>
                      <p>
                        {catalogProblem?.selectionReason ??
                          "This problem has passed vetting and is waiting in the ranked queue."}
                      </p>
                      {(catalogProblem?.counterexampleBonus ?? 0) > 0 &&
                        catalogProblem?.counterexampleVerificationPlan && (
                          <p className="counterexamplePlan">
                            <strong>Counterexample route:</strong>{" "}
                            {catalogProblem.counterexampleVerificationPlan}
                          </p>
                        )}
                      {catalogProblem && (
                        <div className="queuedActions">
                          <button
                            type="button"
                            className="button buttonPrimary"
                            disabled={
                              !commandsAvailable ||
                              commandPending !== null ||
                              catalogProblem.operatorPinned ||
                              !data.campaign
                            }
                            onClick={prioritizeSelectedProblem}
                          >
                            {catalogProblem.operatorPinned
                              ? "Queued next"
                              : "Run next"}
                          </button>
                          <span>
                            Moves this problem ahead of the automatic ranking.
                          </span>
                        </div>
                      )}
                      {catalogProblem?.lastOutcome && (
                        <p className="lastOutcome">
                          Previous outcome: {catalogProblem.lastOutcome}
                        </p>
                      )}
                      {(catalogProblem?.attemptHistory?.length ?? 0) > 0 && (
                        <div className="attemptHistory">
                          <p className="sectionKicker">Recorded attempts</p>
                          <ol>
                            {catalogProblem?.attemptHistory?.map(
                              (attempt, index) => (
                                <li key={attempt.attemptId}>
                                  <strong>
                                    Attempt {index + 1} ·{" "}
                                    {titleCase(attempt.outcome)}
                                  </strong>
                                  <span>
                                    {formatDuration(attempt.activeWorkMs)} worked ·{" "}
                                    {attempt.callsStarted} calls · {attempt.rounds} rounds
                                    {attempt.candidateKind
                                      ? ` · ${titleCase(attempt.candidateKind)}`
                                      : ""}
                                  </span>
                                  {attempt.note && <small>{attempt.note}</small>}
                                </li>
                              ),
                            )}
                          </ol>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="emptyState detailEmpty">
                  <strong>No problem selected.</strong>
                  <span>The coordinator is preparing the first ranked batch.</span>
                </div>
              )}
            </section>
          </div>

          <section className="panel notesPanel" aria-labelledby="notes-heading">
            <div className="panelHeader notesHeader">
              <div>
                <p className="sectionKicker">Live, human-readable updates</p>
                <h2 id="notes-heading">Research notes</h2>
              </div>
              <label className="diagnosticsToggle">
                <input
                  type="checkbox"
                  checked={showDiagnostics}
                  onChange={(event) => setShowDiagnostics(event.target.checked)}
                />
                <span aria-hidden="true" />
                Show model diagnostics
              </label>
            </div>
            <p className="panelIntro">
              Coordinator decisions, genuine information gain, failed routes, and
              independent checks. Refreshes every two seconds without stealing
              focus.
            </p>
            {visibleEvents.length ? (
              <ol className="timeline">
                {visibleEvents.map((event) => (
                  <li key={event.id} className={`event-${event.level}`}>
                    <div className="timelineMarker" aria-hidden="true" />
                    <div className="timelineTime">
                      <time dateTime={event.at}>{formatUtcTime(event.at)}</time>
                      <span>{titleCase(event.kind)}</span>
                    </div>
                    <div className="timelineContent">
                      <h3>{event.title}</h3>
                      <p>{event.note}</p>
                    </div>
                    <div className="timelineScope">
                      {event.problemId && <span>{event.problemId}</span>}
                      {event.branchId && <span>{event.branchId}</span>}
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="emptyState compact">
                <strong>No research notes yet.</strong>
                <span>Important updates will appear after the first agent turn.</span>
              </div>
            )}
          </section>
        </main>

        <footer className="appFooter">
          <span>Autoprover keeps one canonical lease per problem.</span>
          <span>Claims remain candidates until independently reproduced.</span>
        </footer>
      </div>
    </>
  );
}
