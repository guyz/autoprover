export type VerificationPass = {
  pass: number;
  verdict: string;
  note: string;
};

export type VerificationRun = {
  candidateHash: string;
  candidateClaim?: string;
  candidateKind?: string | null;
  status: string;
  passes: VerificationPass[];
};

export type VerificationScope = "solution" | "partial" | "claim";

export type AttemptDecision =
  | "solved"
  | "human-review"
  | "not-solved"
  | "paused"
  | "error";

export type AttemptDecisionInput = {
  outcome?: string | null;
  problemStatus?: string | null;
  candidateKind?: string | null;
  hasCandidate?: boolean;
};

export const ACTIVE_VERIFICATION_STATES = new Set([
  "checking",
  "running",
  "pending",
  "verifying",
]);

export const SOLVED_VERIFICATION_STATES = new Set([
  "agent-reproduced-candidate",
  "reproduced",
  "verified",
]);

export function verificationScope(run: VerificationRun): VerificationScope {
  if (run.candidateKind === "proof" || run.candidateKind === "disproof") {
    return "solution";
  }
  if (run.candidateKind === "partial") return "partial";
  return "claim";
}

export function isActiveVerification(run: VerificationRun) {
  return ACTIVE_VERIFICATION_STATES.has(run.status);
}

export function isSolvedVerification(run: VerificationRun) {
  return (
    SOLVED_VERIFICATION_STATES.has(run.status) &&
    verificationScope(run) === "solution"
  );
}

export function isRejectedVerification(run: VerificationRun) {
  return /reject|fail|refut/i.test(run.status);
}

export function attemptDecision(
  attempt: AttemptDecisionInput,
): AttemptDecision {
  const outcome = String(attempt.outcome ?? "").toLowerCase();
  const problemStatus = String(attempt.problemStatus ?? "").toLowerCase();
  const isCompleteCandidate =
    ["proof", "disproof"].includes(attempt.candidateKind ?? "") ||
    problemStatus.startsWith("candidate-complete");

  if (
    isCompleteCandidate &&
    (
      problemStatus === "candidate-complete-agent-reproduced" ||
      ["solved", "agent-reproduced", "agent-reproduced-candidate"].includes(
        outcome,
      )
    )
  ) {
    return "solved";
  }
  if (
    isCompleteCandidate &&
    (
      problemStatus === "candidate-complete-needs-expert" ||
      outcome === "human-review" ||
      attempt.hasCandidate
    )
  ) {
    return "human-review";
  }
  if (outcome === "interrupted") return "paused";
  if (outcome === "failed") return "error";
  return "not-solved";
}

export function activeVerificationScope(
  runs: VerificationRun[],
): VerificationScope | null {
  const active = runs.filter(isActiveVerification);
  if (active.some((run) => verificationScope(run) === "solution")) {
    return "solution";
  }
  if (active.some((run) => verificationScope(run) === "partial")) {
    return "partial";
  }
  return active.length ? "claim" : null;
}

export function verificationRunLabel(run: VerificationRun) {
  const scope = verificationScope(run);
  if (isSolvedVerification(run)) return "Solution independently reproduced";
  if (run.status === "verified-partial-lead") {
    return "Partial result saved as research evidence";
  }
  if (isActiveVerification(run)) {
    if (scope === "solution") {
      return "Testing a possible proof or counterexample";
    }
    if (scope === "partial") return "Checking a research note";
    return "Checking a research claim";
  }
  if (run.status === "inconclusive-budget-ended") {
    if (scope === "solution") return "Solution check stopped at budget";
    if (scope === "partial") return "Partial check stopped at budget";
    return "Claim check stopped at budget";
  }
  if (isRejectedVerification(run)) {
    if (scope === "solution") return "Proposed solution rejected";
    if (scope === "partial") return "Partial result rejected";
    return "Research claim rejected";
  }
  if (run.status === "candidate-needs-expert") {
    return "Complete candidate needs human review";
  }
  if (run.status === "partial-needs-expert") {
    return "Partial result set aside";
  }
  if (run.status === "inconclusive") {
    if (scope === "solution") return "Solution check inconclusive";
    if (scope === "partial") return "Partial check inconclusive";
    return "Claim check inconclusive";
  }
  return run.status
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function verificationSummary(runs: VerificationRun[]) {
  if (!runs.length) return "";

  const activeScope = activeVerificationScope(runs);
  if (activeScope === "solution") {
    return "Independent checks are testing a possible proof or counterexample.";
  }
  if (activeScope === "partial") {
    return "Internal checks are running on a research note. This is not a solution.";
  }
  if (activeScope === "claim") {
    return "Independent checks are running on an unclassified research claim.";
  }
  if (runs.some(isSolvedVerification)) {
    return "A complete proof or disproof was independently reproduced.";
  }
  if (runs.some((run) => run.status === "verified-partial-lead")) {
    return "A partial result passed internal checks and was saved as research context. The problem was not solved.";
  }

  const stopped = runs.find(
    (run) => run.status === "inconclusive-budget-ended",
  );
  if (stopped) {
    const passed = stopped.passes.filter(
      (pass) => pass.verdict === "pass",
    ).length;
    return `Checking stopped at the budget · ${passed} check${passed === 1 ? "" : "s"} passed · not accepted as a solution.`;
  }

  const rejected = runs.filter(isRejectedVerification).length;
  if (rejected) {
    return `${rejected} claim${rejected === 1 ? " was" : "s were"} rejected; research can continue.`;
  }
  return "A saved claim has an unfinished verification record.";
}
