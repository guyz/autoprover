import assert from "node:assert/strict";
import test from "node:test";
import {
  activeVerificationScope,
  attemptDecision,
  isSolvedVerification,
  verificationRunLabel,
  verificationSummary,
  type VerificationRun,
} from "../app/problem-status.ts";

function run(
  candidateKind: string | null,
  status = "checking",
): VerificationRun {
  return {
    candidateHash: `${candidateKind ?? "unknown"}-${status}`,
    candidateClaim: "A checkable research claim.",
    candidateKind,
    status,
    passes: [],
  };
}

test("an active partial claim is never presented as a proposed solution", () => {
  const partial = run("partial");

  assert.equal(activeVerificationScope([partial]), "partial");
  assert.equal(verificationRunLabel(partial), "Checking a research note");
  assert.match(verificationSummary([partial]), /research note/i);
  assert.equal(isSolvedVerification(partial), false);
});

test("proof and disproof candidates are labeled as proposed solutions", () => {
  for (const kind of ["proof", "disproof"]) {
    const candidate = run(kind);
    assert.equal(activeVerificationScope([candidate]), "solution");
    assert.equal(
      verificationRunLabel(candidate),
      "Testing a possible proof or counterexample",
    );
    assert.match(
      verificationSummary([candidate]),
      /possible proof or counterexample/i,
    );
  }
});

test("only a reproduced complete proof or disproof is solved", () => {
  const reproducedDisproof = run("disproof", "agent-reproduced-candidate");
  const verifiedPartial = run("partial", "verified-partial-lead");
  const misleadingLegacyPartial = run("partial", "verified");
  const unclassifiedLegacyResult = run(null, "verified");

  assert.equal(isSolvedVerification(reproducedDisproof), true);
  assert.equal(isSolvedVerification(verifiedPartial), false);
  assert.equal(isSolvedVerification(misleadingLegacyPartial), false);
  assert.equal(isSolvedVerification(unclassifiedLegacyResult), false);
  assert.equal(
    verificationRunLabel(verifiedPartial),
    "Partial result saved as research evidence",
  );
  assert.match(
    verificationSummary([verifiedPartial]),
    /problem was not solved/i,
  );
});

test("public attempt decisions are solved, not solved, or complete-candidate human review", () => {
  assert.equal(
    attemptDecision({
      outcome: "solved",
      problemStatus: "candidate-complete-agent-reproduced",
      candidateKind: "disproof",
      hasCandidate: true,
    }),
    "solved",
  );
  assert.equal(
    attemptDecision({
      outcome: "human-review",
      problemStatus: "candidate-complete-needs-expert",
      candidateKind: "proof",
      hasCandidate: true,
    }),
    "human-review",
  );
  assert.equal(
    attemptDecision({
      outcome: "verified-partial",
      candidateKind: "partial",
      hasCandidate: false,
    }),
    "not-solved",
  );
});

test("unclassified and rejected claims stay explicit", () => {
  const unclassified = run(null);
  const rejected = run("partial", "rejected");

  assert.equal(activeVerificationScope([unclassified]), "claim");
  assert.match(verificationSummary([unclassified]), /unclassified/i);
  assert.equal(verificationRunLabel(rejected), "Partial result rejected");
  assert.match(verificationSummary([rejected]), /claim was rejected/i);
});
