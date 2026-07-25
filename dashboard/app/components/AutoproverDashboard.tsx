"use client";

import {
  type FormEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  activeVerificationScope,
  attemptDecision,
  isRejectedVerification,
  isSolvedVerification,
  verificationRunLabel,
  verificationScope,
  verificationSummary as summarizeVerification,
  type VerificationRun,
} from "../problem-status";

type ConnectionState = "connecting" | "live" | "offline";

type Campaign = {
  id: string;
  status: string;
  phase: string;
  cycle: number;
  provider: string;
  continuous?: boolean;
  parallelProblems?: number;
  maxConcurrentCalls?: number;
  tournament?: {
    enabled: boolean;
    stage: string;
    round: number;
    probeTarget?: number | null;
    probesCompleted?: number;
    semifinalTarget?: number | null;
    semifinalsCompleted?: number;
    deepTarget?: number | null;
    deepCompleted?: number;
    finalists?: number;
    latestEvaluation?: {
      stage: string;
      problemsCompared: number;
      solverTurns: number;
      decisiveLeads: number;
      verdict: string;
    } | null;
  } | null;
  discovery?: {
    active: boolean;
    cycle?: number | null;
    callsRunning: number;
    callsCompleted: number;
    callsFailed: number;
    phase?: string | null;
  };
  timeLeftMs: number;
  pausedAt?: string | null;
  latestNote?: string;
  budget: {
    callsStarted: number;
    callsCompleted: number;
    callsFailed: number;
    inFlight?: number;
    maxCalls: number;
    callBudgetBatch?: number;
    estimatedUsd?: number;
    maxEstimatedUsd?: number;
  };
};

type DashboardCounts = {
  catalog: number;
  queued: number;
  active: number;
  candidates: number;
  partialResults: number;
  unclassifiedClaims: number;
  rejectedClaims: number;
  reproduced: number;
};

type CatalogAttempt = {
  attemptId: string;
  outcome: string;
  problemStatus?: string | null;
  activeWorkMs: number;
  callsStarted: number;
  rounds: number;
  evidenceCount: number;
  note?: string;
  candidateKind?: string | null;
  hasCandidate?: boolean;
  hasVerifiedPartial?: boolean;
};

type CatalogProblem = {
  id: string;
  title: string;
  domain: string;
  rank: number;
  state: string;
  lifecycle?: string;
  selectionReason: string;
  lastOutcome?: string;
  attemptHistory?: CatalogAttempt[];
  totalActiveWorkMs?: number;
  totalCalls?: number;
  operatorPinned?: boolean;
};

type Branch = {
  id: string;
  title: string;
  status: string;
  turn: number;
  round: number;
  latestSummary?: string;
  progressKind?: string;
  nextAction?: string;
  hypothesis?: string;
  falsifier?: string;
  feedback?: string;
  verifiedFactsCount?: number;
  failedApproachesCount?: number;
};

type ResearchProblem = {
  id: string;
  attemptId?: string;
  title: string;
  domain: string;
  status: string;
  stage?: string;
  activeWorkMs: number;
  callsStarted?: number;
  coordinatorNote?: string;
  statement?: string;
  sourceUrls?: string[];
  switchRequestedAt?: string | null;
  branches: Branch[];
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
};

type ManualPacket = {
  packetId: string;
  role?: string;
  prompt?: string;
};

type OperatorCommand = {
  id: string;
  type: string;
  status: string;
};

type DashboardServer = {
  commandToken?: string | null;
  campaignProcessRunning?: boolean;
  recentProcessNotes?: Array<{
    at: string;
    level: string;
    message: string;
  }>;
};

type DashboardData = {
  server: DashboardServer;
  campaign: Campaign | null;
  counts: DashboardCounts;
  catalog: CatalogProblem[];
  activeProblems: ResearchProblem[];
  completedProblems: ResearchProblem[];
  events: ResearchEvent[];
  manualQueue: ManualPacket[];
  operatorCommands: OperatorCommand[];
};

type CampaignSettings = {
  provider: string;
  hours: number;
  parallelProblems: number;
  maxCalls: number;
  maxEstimatedUsd: number;
};

type ProblemState =
  | "working"
  | "human-review"
  | "solved"
  | "not-solved"
  | "saved"
  | "failed"
  | "paused"
  | "waiting";

type ProblemView = {
  catalog: CatalogProblem;
  live?: ResearchProblem;
  saved?: ResearchProblem;
  state: ProblemState;
};

const EMPTY_DATA: DashboardData = {
  server: { commandToken: null },
  campaign: null,
  counts: {
    catalog: 0,
    queued: 0,
    active: 0,
    candidates: 0,
    partialResults: 0,
    unclassifiedClaims: 0,
    rejectedClaims: 0,
    reproduced: 0,
  },
  catalog: [],
  activeProblems: [],
  completedProblems: [],
  events: [],
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

const LIVE_PROBLEM_STATES = new Set([
  "active",
  "running",
  "verifying",
  "planning",
  "starting",
]);

const PROBLEM_STATE_LABELS: Record<ProblemState, string> = {
  working: "Working",
  "human-review": "Human review",
  solved: "Solved",
  "not-solved": "Not solved",
  saved: "Saved",
  failed: "Run error",
  paused: "Paused",
  waiting: "Waiting",
};

const PROBLEM_STATE_ORDER: Record<ProblemState, number> = {
  solved: 0,
  "human-review": 1,
  working: 2,
  paused: 3,
  "not-solved": 4,
  saved: 5,
  failed: 6,
  waiting: 7,
};

function normalizeDashboard(input: unknown): DashboardData {
  if (!input || typeof input !== "object") {
    throw new Error("Dashboard response is not an object");
  }
  const raw = input as {
    server?: DashboardServer;
    campaign?: Campaign | null;
    counts?: Partial<DashboardCounts>;
    catalog?: CatalogProblem[] | { items?: CatalogProblem[] };
    activeProblems?: ResearchProblem[];
    completedProblems?: ResearchProblem[];
    events?: ResearchEvent[];
    notes?: ResearchEvent[];
    manualQueue?: ManualPacket[];
    operatorCommands?: OperatorCommand[];
  };
  const catalog = Array.isArray(raw.catalog)
    ? raw.catalog
    : Array.isArray(raw.catalog?.items)
      ? raw.catalog.items
      : [];
  const activeProblems = Array.isArray(raw.activeProblems)
    ? raw.activeProblems
    : [];
  const completedProblems = Array.isArray(raw.completedProblems)
    ? raw.completedProblems
    : [];
  const researchEvents = Array.isArray(raw.events)
    ? raw.events
    : Array.isArray(raw.notes)
      ? raw.notes
      : [];
  const processEvents: ResearchEvent[] = (
    raw.server?.recentProcessNotes ?? []
  ).map((note, index) => {
    const message = note.message.trim();
    const frontendDiagnostic =
      message.includes("hydrated but some attributes") ||
      message.includes("multiple renderers concurrently") ||
      message.includes("MaxListenersExceededWarning");
    return {
      id: `controller-${note.at}-${index}`,
      at: note.at,
      level: frontendDiagnostic
        ? "diagnostic"
        : note.level === "error"
          ? "error"
          : note.level === "warning"
            ? "warning"
            : "diagnostic",
      kind: "controller",
      title: frontendDiagnostic
        ? "Dashboard diagnostic"
        : note.level === "error"
          ? "Controller error"
          : note.level === "warning"
            ? "Controller warning"
            : "Controller update",
      note: message,
    };
  });
  const events = [...researchEvents, ...processEvents]
    .filter((event) => event.level !== "diagnostic")
    .sort((left, right) => right.at.localeCompare(left.at));
  const derivedCounts: DashboardCounts = {
    catalog: catalog.length,
    queued: catalog.filter((problem) =>
      ["queued", "vetted", "ready"].includes(problem.state),
    ).length,
    active: activeProblems.filter((problem) =>
      LIVE_PROBLEM_STATES.has(problem.status),
    ).length,
    candidates: activeProblems.reduce(
      (sum, problem) =>
        sum +
        verificationRuns(problem).filter(
          (run) => verificationScope(run) === "solution",
        ).length,
      0,
    ),
    partialResults: activeProblems.reduce(
      (sum, problem) =>
        sum +
        verificationRuns(problem).filter(
          (run) => verificationScope(run) === "partial",
        ).length,
      0,
    ),
    unclassifiedClaims: activeProblems.reduce(
      (sum, problem) =>
        sum +
        verificationRuns(problem).filter(
          (run) => verificationScope(run) === "claim",
        ).length,
      0,
    ),
    rejectedClaims: activeProblems.reduce(
      (sum, problem) =>
        sum +
        verificationRuns(problem).filter(isRejectedVerification).length,
      0,
    ),
    reproduced: activeProblems.reduce(
      (sum, problem) =>
        sum +
        verificationRuns(problem).filter(isSolvedVerification).length,
      0,
    ),
  };
  return {
    server: raw.server ?? { commandToken: null },
    campaign: raw.campaign === undefined ? null : raw.campaign,
    counts: { ...derivedCounts, ...(raw.counts ?? {}) },
    catalog,
    activeProblems,
    completedProblems,
    events,
    manualQueue: Array.isArray(raw.manualQueue) ? raw.manualQueue : [],
    operatorCommands: Array.isArray(raw.operatorCommands)
      ? raw.operatorCommands
      : [],
  };
}

function verificationRuns(problem?: ResearchProblem) {
  return problem?.verification ?? problem?.verificationRuns ?? [];
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

function titleCase(value: string) {
  return value
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function campaignIsActive(campaign: Campaign | null) {
  return campaign ? ACTIVE_CAMPAIGN_STATES.has(campaign.status) : false;
}

function campaignStatusLabel(
  campaign: Campaign,
  campaignProcessRunning = true,
) {
  if (campaignIsActive(campaign)) {
    return campaignProcessRunning ? "Running" : "Recovering";
  }
  if (campaign.status === "budget-exhausted") return "Call limit reached";
  if (campaign.status === "deadline-reached") return "Time limit reached";
  if (["stopped", "paused"].includes(campaign.status)) return "Paused";
  if (campaign.status === "awaiting-manual") return "Waiting for input";
  if (campaign.status === "catalog-exhausted") return "Needs more problems";
  return titleCase(campaign.status);
}

function classifyProblem(
  catalog: CatalogProblem,
  live?: ResearchProblem,
  saved?: ResearchProblem,
): ProblemState {
  const allVerification = [
    ...verificationRuns(live),
    ...verificationRuns(saved),
  ];
  if (
    allVerification.some(isSolvedVerification) ||
    saved?.status === "candidate-complete-agent-reproduced" ||
    catalog.attemptHistory?.some(
      (attempt) => attemptDecision(attempt) === "solved",
    )
  ) {
    return "solved";
  }
  if (
    saved?.status === "candidate-complete-needs-expert" ||
    allVerification.some(
      (run) =>
        run.status === "candidate-needs-expert" &&
        verificationScope(run) === "solution",
    ) ||
    catalog.attemptHistory?.some(
      (attempt) => attemptDecision(attempt) === "human-review",
    )
  ) {
    return "human-review";
  }
  const lifecycle = (catalog.lifecycle ?? catalog.state).toLowerCase();
  if (live && LIVE_PROBLEM_STATES.has(live.status)) return "working";
  if (catalog.state === "saved") return "saved";
  const latestOutcome =
    catalog.attemptHistory?.at(-1)?.outcome ?? catalog.lastOutcome ?? "";
  const hasProjectedAttempt = Boolean(catalog.attemptHistory?.length);
  if (
    latestOutcome === "interrupted" ||
    ["paused", "stopped", "deadline-reached", "budget-exhausted"].includes(
      lifecycle,
    ) ||
    (
      !hasProjectedAttempt &&
      saved &&
      ["paused", "stopped", "deadline-reached", "budget-exhausted"].includes(
        saved.status,
      )
    )
  ) {
    return "paused";
  }
  if (
    lifecycle === "quarantined" ||
    (
      catalog.attemptHistory?.at(-1) &&
      attemptDecision(catalog.attemptHistory.at(-1)!) === "error"
    )
  ) {
    return "failed";
  }
  if (
    ["cooldown", "retired"].includes(lifecycle) ||
    Boolean(saved) ||
    Boolean(catalog.attemptHistory?.length)
  ) {
    return "not-solved";
  }
  return "waiting";
}

function problemHeadline(view: ProblemView) {
  const { live, state } = view;
  if (state === "human-review") {
    return "Complete candidate found; human review recommended";
  }
  if (state === "solved") {
    return "Proof or counterexample independently reproduced";
  }
  if (state === "working") {
    if (activeVerificationScope(verificationRuns(live)) === "solution") {
      return "Testing a possible proof or counterexample";
    }
    if (live?.stage === "probing solution potential") {
      return "Completing an initial solver turn";
    }
    if (live?.stage === "testing a promising lead") {
      return "Testing whether the lead survives another solver turn";
    }
    if (live?.stage === "deep solving") {
      return "Building the strongest lead toward a complete solution";
    }
    const count = live?.branches.length ?? 0;
    return count
      ? `${count} approach${count === 1 ? "" : "es"} in progress`
      : "Preparing research approaches";
  }
  if (state === "paused") return "Saved at a checkpoint; ready to continue";
  if (state === "failed") return "Run ended with a system error";
  if (state === "not-solved") {
    return "No proof or counterexample was established";
  }
  if (state === "saved") {
    return "Checkpoint saved; a more decisive lead received the next turns";
  }
  return "Waiting to be picked up";
}

function attemptOutcome(attempt: CatalogAttempt) {
  const decision = attemptDecision(attempt);
  if (decision === "solved") return "Solved";
  if (decision === "human-review") return "Human review recommended";
  if (decision === "paused") return "Paused before completion";
  if (decision === "error") return "Run error";
  return "Not solved";
}

function verificationSummary(view: ProblemView) {
  const runs = [
    ...verificationRuns(view.live),
    ...verificationRuns(view.saved),
  ];
  return summarizeVerification(runs);
}

function latestProgress(view: ProblemView) {
  const liveSummary = view.live?.branches
    .map((branch) => branch.latestSummary)
    .find(Boolean);
  if (liveSummary) return liveSummary;
  const savedVerification = verificationSummary(view);
  if (savedVerification) return savedVerification;
  return (
    view.catalog.attemptHistory?.at(-1)?.note ??
    view.catalog.selectionReason
  );
}

function totalWork(view: ProblemView) {
  return (
    (view.catalog.totalActiveWorkMs ?? 0) +
    (view.live?.activeWorkMs ?? 0)
  );
}

function totalCalls(view: ProblemView) {
  return (
    (view.catalog.totalCalls ?? 0) +
    (view.live?.callsStarted ?? 0)
  );
}

function attemptCount(view: ProblemView) {
  return (
    (view.catalog.attemptHistory?.length ?? 0) +
    (view.live ? 1 : 0)
  );
}

function ProblemCard({
  view,
  commandsAvailable,
  commandPending,
  onPrioritize,
  onSwitch,
}: {
  view: ProblemView;
  commandsAvailable: boolean;
  commandPending: string | null;
  onPrioritize: (problem: CatalogProblem) => void;
  onSwitch: (problem: ResearchProblem) => void;
}) {
  const { catalog, live, saved, state } = view;
  const runs = [...verificationRuns(live), ...verificationRuns(saved)];
  const savedBranches = saved?.branches ?? [];
  return (
    <details className={`problemCard problem-${state}`}>
      <summary>
        <span className={`problemStatus problemStatus-${state}`}>
          {PROBLEM_STATE_LABELS[state]}
        </span>
        <span className="problemSummary">
          <span className="problemTitleRow">
            <strong>{catalog.title}</strong>
            <small>{catalog.domain}</small>
          </span>
          <span className="problemHeadline">{problemHeadline(view)}</span>
          <span className="problemMeta">
            {formatDuration(totalWork(view))} · {totalCalls(view)} calls ·{" "}
            {attemptCount(view)} attempt
            {attemptCount(view) === 1 ? "" : "s"}
          </span>
        </span>
        <span className="expandLabel" aria-hidden="true">
          Details
        </span>
      </summary>

      <div className="problemDetails">
        <section className="detailBlock currentStateBlock">
          <div className="detailHeading">
            <h3>Current state</h3>
            <span className={`problemStatus problemStatus-${state}`}>
              {PROBLEM_STATE_LABELS[state]}
            </span>
          </div>
          <p className="stateHeadline">{problemHeadline(view)}</p>
          <p>{latestProgress(view)}</p>
        </section>

        {live && (
          <section className="detailBlock">
            <div className="detailHeading">
              <h3>Approaches running now</h3>
              <span>{live.branches.length}</span>
            </div>
            {live.branches.length ? (
              <ul className="approachList">
                {live.branches.map((branch) => (
                  <li key={branch.id}>
                    <div>
                      <strong>{branch.title}</strong>
                      <span>{titleCase(branch.status)}</span>
                    </div>
                    <p>
                      {branch.latestSummary ||
                        "Waiting for the first research update."}
                    </p>
                  </li>
                ))}
              </ul>
            ) : (
              <p>Planning distinct approaches now.</p>
            )}
          </section>
        )}

        {runs.length > 0 && (
          <section className="detailBlock verificationBlock">
            <div className="detailHeading">
              <h3>Verification</h3>
              <span>{runs.length}</span>
            </div>
            <div className="verificationList">
              {runs.map((run) => (
                <article key={run.candidateHash}>
                  <div className="verificationTitle">
                    <strong>{verificationRunLabel(run)}</strong>
                    <code>{run.candidateHash.slice(0, 8)}</code>
                  </div>
                  <p>{run.candidateClaim || "Saved research claim"}</p>
                  <p className="claimScope">
                    {verificationScope(run) === "solution"
                      ? "Claims to settle the full problem"
                      : verificationScope(run) === "partial"
                        ? "Partial result only · original problem remains open"
                        : "Not classified as a full solution"}
                  </p>
                  {run.status === "inconclusive-budget-ended" && (
                    <p className="verificationWarning">
                      This did not solve the problem. Verification stopped
                      before completion.
                    </p>
                  )}
                  {run.passes.length > 0 && (
                    <ol>
                      {run.passes.map((pass) => (
                        <li key={pass.pass}>
                          <strong>
                            Check {pass.pass}: {titleCase(pass.verdict)}
                          </strong>
                          <span>{pass.note}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {(catalog.attemptHistory?.length ?? 0) > 0 && (
          <section className="detailBlock">
            <div className="detailHeading">
              <h3>Attempt history</h3>
              <span>{catalog.attemptHistory?.length}</span>
            </div>
            <ol className="attemptList">
              {catalog.attemptHistory?.map((attempt, index) => (
                <li key={attempt.attemptId}>
                  <div>
                    <strong>
                      Attempt {index + 1}: {attemptOutcome(attempt)}
                    </strong>
                    <span>
                      {formatDuration(attempt.activeWorkMs)} ·{" "}
                      {attempt.callsStarted} calls
                    </span>
                  </div>
                  {attempt.note && <p>{attempt.note}</p>}
                </li>
              ))}
            </ol>
          </section>
        )}

        {!live && savedBranches.length > 0 && (
          <section className="detailBlock">
            <div className="detailHeading">
              <h3>Approaches saved from the last attempt</h3>
              <span>{savedBranches.length}</span>
            </div>
            <ul className="approachList">
              {savedBranches.map((branch) => (
                <li key={branch.id}>
                  <div>
                    <strong>{branch.title}</strong>
                    <span>Saved</span>
                  </div>
                  <p>{branch.latestSummary || "No final branch note."}</p>
                </li>
              ))}
            </ul>
          </section>
        )}

        {(live?.statement || saved?.statement) && (
          <details className="statementDetails">
            <summary>Problem statement and sources</summary>
            <p>{live?.statement ?? saved?.statement}</p>
            {(live?.sourceUrls ?? saved?.sourceUrls ?? []).length > 0 && (
              <ul>
                {(live?.sourceUrls ?? saved?.sourceUrls ?? []).map((url) => (
                  <li key={url}>
                    <a href={url} target="_blank" rel="noreferrer">
                      {url}
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </details>
        )}

        <div className="problemActions">
          {live && (
            <button
              type="button"
              className="textButton dangerText"
              disabled={
                !commandsAvailable ||
                commandPending !== null ||
                Boolean(live.switchRequestedAt)
              }
              onClick={() => onSwitch(live)}
            >
              {live.switchRequestedAt
                ? "Switch requested"
                : "Stop this attempt and pick another"}
            </button>
          )}
          {!live && ["not-solved", "saved", "waiting", "failed"].includes(state) && (
            <button
              type="button"
              className="button buttonSecondary"
              disabled={
                !commandsAvailable ||
                commandPending !== null ||
                catalog.operatorPinned
              }
              onClick={() => onPrioritize(catalog)}
            >
              {catalog.operatorPinned
                ? "Scheduled next"
                : state === "not-solved"
                  ? "Try this problem again"
                  : "Run this problem next"}
            </button>
          )}
        </div>
      </div>
    </details>
  );
}

export default function AutoproverDashboard() {
  const [data, setData] = useState<DashboardData>(EMPTY_DATA);
  const [connection, setConnection] =
    useState<ConnectionState>("connecting");
  const [lastSync, setLastSync] = useState("Connecting");
  const [settings, setSettings] = useState<CampaignSettings>({
    provider: "max",
    hours: 24,
    parallelProblems: 6,
    maxCalls: 240,
    maxEstimatedUsd: 100,
  });
  const [resumeExtraHours, setResumeExtraHours] = useState<number | null>(
    null,
  );
  const [commandPending, setCommandPending] = useState<string | null>(null);
  const [feedback, setFeedback] = useState("");
  const [problemSuggestion, setProblemSuggestion] = useState("");
  const [manualResponse, setManualResponse] = useState("");
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
        setLastSync(formatUtcTime(new Date().toISOString()));
        if (
          next.campaign &&
          hydratedCampaignId.current !== next.campaign.id
        ) {
          hydratedCampaignId.current = next.campaign.id;
          setSettings((current) => ({
            ...current,
            provider: next.campaign?.provider ?? current.provider,
            parallelProblems:
              next.campaign?.parallelProblems ?? current.parallelProblems,
            maxCalls: next.campaign?.budget.maxCalls ?? current.maxCalls,
            maxEstimatedUsd:
              next.campaign?.budget.maxEstimatedUsd ??
              current.maxEstimatedUsd,
          }));
        }
      } catch {
        if (cancelled) return;
        setConnection("offline");
        if (!hasLiveData.current) setData(EMPTY_DATA);
        setLastSync(
          hasLiveData.current ? "Showing last update" : "Controller unavailable",
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

  const isActive = campaignIsActive(data.campaign);
  const campaignProcessRunning =
    data.server.campaignProcessRunning !== false;
  const isStopping = data.campaign?.status === "stopping";
  const canResume = Boolean(
    data.campaign && RESUMABLE_CAMPAIGN_STATES.has(data.campaign.status),
  );
  const commandToken = data.server.commandToken;
  const commandsAvailable =
    connection === "live" &&
    typeof commandToken === "string" &&
    commandToken.length > 0;
  const inFlightCalls =
    data.campaign?.budget.inFlight ??
    Math.max(
      0,
      (data.campaign?.budget.callsStarted ?? 0) -
        (data.campaign?.budget.callsCompleted ?? 0) -
        (data.campaign?.budget.callsFailed ?? 0),
    );
  const maxConcurrentCalls = data.campaign?.maxConcurrentCalls ?? 4;
  const configuredProblemSlots =
    data.campaign?.parallelProblems ?? settings.parallelProblems;
  const isContinuous =
    data.campaign?.continuous === true &&
    data.campaign.provider !== "pro";
  const effectiveResumeExtraHours =
    resumeExtraHours ??
    (data.campaign?.status === "deadline-reached" ? 24 : 0);
  const apiResumeNeedsHigherLimit = Boolean(
    data.campaign?.provider === "pro" &&
      data.campaign.status === "budget-exhausted" &&
      (
        data.campaign.budget.callsStarted >= settings.maxCalls ||
        (data.campaign.budget.estimatedUsd ?? 0) >=
          settings.maxEstimatedUsd
      ),
  );
  const callPercent = data.campaign?.budget.maxCalls
    ? Math.min(
        100,
        (data.campaign.budget.callsStarted /
          data.campaign.budget.maxCalls) *
          100,
      )
    : 0;
  const firstManualPacket = data.manualQueue[0];
  const problemViews: ProblemView[] = data.catalog
    .map((catalog) => {
      const live = data.activeProblems.find(
        (problem) => problem.id === catalog.id,
      );
      const saved = data.completedProblems.find(
        (problem) => problem.id === catalog.id,
      );
      return {
        catalog,
        live,
        saved,
        state: classifyProblem(catalog, live, saved),
      };
    })
    .sort(
      (left, right) =>
        PROBLEM_STATE_ORDER[left.state] -
          PROBLEM_STATE_ORDER[right.state] ||
        left.catalog.rank - right.catalog.rank,
    );
  const stateCounts = problemViews.reduce(
    (counts, view) => {
      counts[view.state] += 1;
      return counts;
    },
    {
      working: 0,
      "human-review": 0,
      solved: 0,
      "not-solved": 0,
      saved: 0,
      failed: 0,
      paused: 0,
      waiting: 0,
    } satisfies Record<ProblemState, number>,
  );
  const workingNow = stateCounts.working;
  const notSolvedCount = stateCounts["not-solved"] + stateCounts.failed;

  async function sendCommand(
    action: "start" | "stop" | "resume",
    payload: Record<string, unknown>,
  ) {
    if (!commandsAvailable || !commandToken) {
      setFeedback("The local controller is not connected.");
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
        result.message ??
          (action === "stop"
            ? "Finishing current calls and saving checkpoints."
            : action === "resume"
              ? "Resuming saved work."
              : "Campaign is starting."),
      );
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "The command failed.",
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
      setFeedback("The local controller is not connected.");
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
      setFeedback(result.message ?? "Saved.");
      return true;
    } catch (error) {
      setFeedback(
        error instanceof Error ? error.message : "The action failed.",
      );
      return false;
    } finally {
      setCommandPending(null);
    }
  }

  function startCampaign(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendCommand("start", {
      provider: settings.provider,
      wallClockHours: settings.hours,
      parallelProblems: settings.parallelProblems,
      maxCalls: settings.maxCalls,
      maxEstimatedUsd: settings.maxEstimatedUsd,
      continuous: true,
    });
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

  function prioritizeProblem(problem: CatalogProblem) {
    void sendNudge("prioritize", "/api/catalog/prioritize", {
      problemKey: problem.id,
    });
  }

  function switchProblem(problem: ResearchProblem) {
    if (!problem.attemptId) return;
    void sendNudge("switch", "/api/attempt/switch", {
      attemptId: problem.attemptId,
      problemKey: problem.id,
      reason: "Operator chose to stop this attempt and work on another problem",
    });
  }

  async function copyManualPrompt() {
    if (!firstManualPacket?.prompt) return;
    try {
      await navigator.clipboard.writeText(firstManualPacket.prompt);
      setFeedback("Manual prompt copied.");
    } catch {
      setFeedback("Could not copy automatically.");
    }
  }

  async function submitManualResponse() {
    if (!firstManualPacket || !commandsAvailable || !commandToken) return;
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
      setFeedback("Response accepted. Work will continue.");
    } catch (error) {
      setFeedback(
        error instanceof SyntaxError
          ? "The response is not valid JSON."
          : error instanceof Error
            ? error.message
            : "The response could not be imported.",
      );
    } finally {
      setCommandPending(null);
    }
  }

  return (
    <>
      <a className="skipLink" href="#problems">
        Skip to problems
      </a>
      <div className="dashboardShell">
        <header className="appHeader">
          <div className="brandBlock">
            <span className="brandMark" aria-hidden="true">
              ∀
            </span>
            <div>
              <h1>Autoprover</h1>
              <p>Continuous mathematical research</p>
            </div>
          </div>
          <div className={`connection connection-${connection}`}>
            <span aria-hidden="true" />
            {connection === "live"
              ? "Live"
              : connection === "offline"
                ? "Offline"
                : "Connecting"}
            <small>{lastSync}</small>
          </div>
        </header>

        <section className="campaignBar" aria-label="Campaign status">
          {data.campaign ? (
            <>
              <div className="campaignState">
                <span
                  className={`runDot ${
                    isActive && campaignProcessRunning ? "runDotActive" : ""
                  }`}
                  aria-hidden="true"
                />
                <div>
                  <strong>
                    {campaignStatusLabel(
                      data.campaign,
                      campaignProcessRunning,
                    )}
                  </strong>
                  <span>
                    {isActive && !campaignProcessRunning
                      ? "Restarting from the last saved checkpoint"
                      : isActive && data.campaign.discovery?.active
                        ? `Finding and vetting open problems · ${data.campaign.discovery.callsRunning} model call${data.campaign.discovery.callsRunning === 1 ? "" : "s"} running`
                      : isActive
                      ? data.campaign.tournament?.stage === "probing"
                        ? `${workingNow}/${configuredProblemSlots} initial solver turns active · ${data.campaign.tournament.probesCompleted ?? 0}/${data.campaign.tournament.probeTarget ?? "?"} compared`
                        : data.campaign.tournament?.stage === "semifinal"
                          ? `${workingNow} promising lead${workingNow === 1 ? "" : "s"} active · ${data.campaign.tournament.semifinalsCompleted ?? 0}/${data.campaign.tournament.semifinalTarget ?? "?"} compared`
                        : data.campaign.tournament?.stage === "deep"
                          ? `${workingNow} strongest lead${workingNow === 1 ? "" : "s"} receiving deeper turns`
                          : `${workingNow}/${configuredProblemSlots} problems active`
                      : data.campaign.status === "budget-exhausted"
                        ? data.campaign.provider === "pro"
                          ? "Work is saved; raise the API limit to continue"
                          : "Work is saved; press Continue"
                        : `${workingNow} problem${workingNow === 1 ? "" : "s"} working`}
                  </span>
                </div>
              </div>
              <div className="campaignMetric">
                <strong>{formatDuration(data.campaign.timeLeftMs)}</strong>
                <span>{isActive ? "remaining" : "saved time"}</span>
              </div>
              <div className="campaignMetric">
                <strong>{data.campaign.budget.callsStarted}</strong>
                <span>
                  {isContinuous
                    ? "calls used"
                    : `of ${data.campaign.budget.maxCalls} calls`}
                </span>
              </div>
              <div className="campaignMetric campaignMetricSecondary">
                <strong>
                  {inFlightCalls}/{maxConcurrentCalls}
                </strong>
                <span>calls running</span>
              </div>
              {isActive && (
                <button
                  type="button"
                  className="button buttonDanger"
                  disabled={
                    !commandsAvailable ||
                    isStopping ||
                    commandPending !== null
                  }
                  onClick={() =>
                    void sendCommand("stop", { mode: "graceful" })
                  }
                >
                  {commandPending === "stop" || isStopping
                    ? "Saving…"
                    : "Pause"}
                </button>
              )}
              {canResume && (
                <button
                  type="button"
                  className="button buttonPrimary"
                  disabled={
                    !commandsAvailable ||
                    commandPending !== null ||
                    apiResumeNeedsHigherLimit
                  }
                  onClick={() =>
                    void sendCommand("resume", {
                      extendHours: effectiveResumeExtraHours,
                      provider: settings.provider,
                      parallelProblems: settings.parallelProblems,
                      maxCalls: settings.maxCalls,
                      maxEstimatedUsd: settings.maxEstimatedUsd,
                      continuous: true,
                    })
                  }
                >
                  {commandPending === "resume"
                    ? "Resuming…"
                    : effectiveResumeExtraHours > 0
                      ? `Continue +${effectiveResumeExtraHours}h`
                      : "Continue"}
                </button>
              )}
              {!isContinuous && (
                <div className="callProgress" aria-hidden="true">
                  <span style={{ width: `${callPercent}%` }} />
                </div>
              )}
              {canResume && (
                <details className="runSettings">
                  <summary>Change resume limits</summary>
                  <div>
                    <label>
                      <span>Add time (optional)</span>
                      <select
                        value={effectiveResumeExtraHours}
                        onChange={(event) =>
                          setResumeExtraHours(Number(event.target.value))
                        }
                      >
                        <option value={0}>No extra time</option>
                        <option value={1}>1 hour</option>
                        <option value={2}>2 hours</option>
                        <option value={12}>12 hours</option>
                        <option value={24}>24 hours</option>
                      </select>
                    </label>
                    <label>
                      <span>Problem slots</span>
                      <input
                        type="number"
                        min={1}
                        max={8}
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
                    {data.campaign.provider === "pro" && (
                      <>
                        <label>
                          <span>Total API call cap</span>
                          <input
                            type="number"
                            min={data.campaign.budget.callsStarted}
                            value={settings.maxCalls}
                            onChange={(event) =>
                              setSettings((current) => ({
                                ...current,
                                maxCalls: Math.max(
                                  data.campaign?.budget.callsStarted ?? 1,
                                  Number(event.target.value) || 1,
                                ),
                              }))
                            }
                          />
                        </label>
                        <label>
                          <span>Total API budget ($)</span>
                          <input
                            type="number"
                            min={data.campaign.budget.estimatedUsd ?? 0}
                            step="1"
                            value={settings.maxEstimatedUsd}
                            onChange={(event) =>
                              setSettings((current) => ({
                                ...current,
                                maxEstimatedUsd: Math.max(
                                  data.campaign?.budget.estimatedUsd ?? 0,
                                  Number(event.target.value) || 0,
                                ),
                              }))
                            }
                          />
                        </label>
                      </>
                    )}
                  </div>
                  {apiResumeNeedsHigherLimit && (
                    <p>Raise the exhausted API call or dollar limit.</p>
                  )}
                  {isContinuous && (
                    <p>
                      Subscription calls renew automatically until the saved
                      time runs out.
                    </p>
                  )}
                </details>
              )}
            </>
          ) : (
            <form className="startRun" onSubmit={startCampaign}>
              <div>
                <strong>Ready to run</strong>
                <span>Starts with the defaults below.</span>
              </div>
              <button
                type="submit"
                className="button buttonPrimary"
                disabled={!commandsAvailable || commandPending !== null}
              >
                {commandPending === "start"
                  ? "Starting…"
                  : `Start ${settings.hours}h run`}
              </button>
              <details className="runSettings">
                <summary>Change run settings</summary>
                <div>
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
                    <span>Hours</span>
                    <select
                      value={settings.hours}
                      onChange={(event) =>
                        setSettings((current) => ({
                          ...current,
                          hours: Number(event.target.value),
                        }))
                      }
                    >
                      <option value={1}>1</option>
                      <option value={2}>2</option>
                      <option value={12}>12</option>
                      <option value={24}>24</option>
                    </select>
                  </label>
                  <label>
                    <span>Problem slots</span>
                    <input
                      type="number"
                      min={1}
                      max={8}
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
                  {settings.provider === "pro" && (
                    <>
                      <label>
                        <span>Total API call cap</span>
                        <input
                          type="number"
                          min={1}
                          value={settings.maxCalls}
                          onChange={(event) =>
                            setSettings((current) => ({
                              ...current,
                              maxCalls: Math.max(
                                1,
                                Number(event.target.value) || 1,
                              ),
                            }))
                          }
                        />
                      </label>
                      <label>
                        <span>Total API budget ($)</span>
                        <input
                          type="number"
                          min={0}
                          step="1"
                          value={settings.maxEstimatedUsd}
                          onChange={(event) =>
                            setSettings((current) => ({
                              ...current,
                              maxEstimatedUsd: Math.max(
                                0,
                                Number(event.target.value) || 0,
                              ),
                            }))
                          }
                        />
                      </label>
                    </>
                  )}
                </div>
                {settings.provider !== "pro" && (
                  <p>
                    Subscription calls renew automatically until the selected
                    time runs out.
                  </p>
                )}
              </details>
            </form>
          )}
          {feedback && (
            <p className="commandFeedback" role="status">
              {feedback}
            </p>
          )}
        </section>

        {firstManualPacket && (
          <section className="manualBanner">
            <div>
              <strong>Manual Pro response needed</strong>
              <span>{firstManualPacket.role ?? "Research turn"}</span>
            </div>
            <details>
              <summary>Open prompt and import response</summary>
              {firstManualPacket.prompt && (
                <>
                  <button
                    type="button"
                    className="textButton"
                    onClick={() => void copyManualPrompt()}
                  >
                    Copy prompt
                  </button>
                  <pre>{firstManualPacket.prompt}</pre>
                </>
              )}
              <textarea
                rows={6}
                value={manualResponse}
                placeholder="Paste the JSON response"
                onChange={(event) => setManualResponse(event.target.value)}
              />
              <button
                type="button"
                className="button buttonPrimary"
                disabled={
                  !manualResponse.trim() || commandPending !== null
                }
                onClick={() => void submitManualResponse()}
              >
                Import response
              </button>
            </details>
          </section>
        )}

        <main id="problems">
          <section className="problemsPanel">
            <div className="problemsHeader">
              <div>
                <h2>Problems</h2>
                <p>
                  {workingNow} working · {stateCounts.solved} solved ·{" "}
                  {stateCounts["human-review"]} human review ·{" "}
                  {stateCounts.saved} saved · {notSolvedCount} not solved
                </p>
              </div>
              <details className="manageProblems">
                <summary>Manage list</summary>
                <div>
                  <button
                    type="button"
                    className="button buttonSecondary"
                    disabled={
                      !commandsAvailable ||
                      !data.campaign ||
                      commandPending !== null
                    }
                    onClick={() =>
                      void sendNudge("discover", "/api/catalog/discover")
                    }
                  >
                    Find more problems
                  </button>
                  <form onSubmit={suggestProblem}>
                    <label className="srOnly" htmlFor="suggest-problem">
                      Problem name or source URL
                    </label>
                    <input
                      id="suggest-problem"
                      value={problemSuggestion}
                      placeholder="Problem name or source URL"
                      onChange={(event) =>
                        setProblemSuggestion(event.target.value)
                      }
                    />
                    <button
                      type="submit"
                      className="button buttonSecondary"
                      disabled={
                        !problemSuggestion.trim() ||
                        commandPending !== null
                      }
                    >
                      Add
                    </button>
                  </form>
                </div>
              </details>
            </div>

            {problemViews.length ? (
              <div className="problemList">
                {problemViews.map((view) => (
                  <ProblemCard
                    key={view.catalog.id}
                    view={view}
                    commandsAvailable={commandsAvailable}
                    commandPending={commandPending}
                    onPrioritize={prioritizeProblem}
                    onSwitch={switchProblem}
                  />
                ))}
              </div>
            ) : (
              <div className="emptyState">
                <strong>
                  {connection === "connecting"
                    ? "Connecting to the controller…"
                    : data.campaign
                      ? "Finding open problems…"
                      : "No campaign yet."}
                </strong>
                <span>
                  {data.campaign
                    ? "Problems appear here as soon as they pass vetting."
                    : "Start a run above to build the problem list."}
                </span>
              </div>
            )}
          </section>

          <details className="activityLog">
            <summary>
              <span>Activity</span>
              <small>{data.events.length} saved updates</small>
            </summary>
            {data.events.length ? (
              <ol>
                {data.events.slice(0, 30).map((event) => (
                  <li key={event.id}>
                    <time dateTime={event.at}>
                      {formatUtcTime(event.at)}
                    </time>
                    <div>
                      <strong>{event.title}</strong>
                      <p>{event.note}</p>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <p>No activity yet.</p>
            )}
          </details>
        </main>

        <footer>
          Autoprover makes a final call: Solved or Not solved. Human review is
          reserved for a complete proof or counterexample the automated checks
          cannot decide.
        </footer>
      </div>
    </>
  );
}
