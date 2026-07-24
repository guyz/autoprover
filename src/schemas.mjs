import { FALSIFICATION_TYPES } from "./falsification.mjs";

const nonEmptyString = { type: "string", minLength: 1 };
const stringArray = { type: "array", items: { type: "string" } };
const nonEmptyStringArray = {
  type: "array",
  minItems: 1,
  items: nonEmptyString,
};
const httpUrlArray = {
  type: "array",
  minItems: 1,
  items: { type: "string", minLength: 8, pattern: "^https?://" },
};

const artifactSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    name: nonEmptyString,
    kind: {
      type: "string",
      enum: ["proof", "counterexample", "code", "data", "lemma", "search-log", "other"],
    },
    content: nonEmptyString,
    verification: nonEmptyString,
  },
  required: ["name", "kind", "content", "verification"],
};

const candidateSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    present: { type: "boolean" },
    kind: { type: "string", enum: ["proof", "disproof", "partial", "none"] },
    claim: { type: "string" },
    solution: { type: "string" },
    verificationPlan: { type: "string" },
  },
  required: ["present", "kind", "claim", "solution", "verificationPlan"],
};

export const DISCOVERY_SCHEMA = {
  name: "open_problem_discovery",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      problems: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: nonEmptyString,
            title: nonEmptyString,
            domain: nonEmptyString,
            statement: nonEmptyString,
            assumptions: stringArray,
            sourceUrls: httpUrlArray,
            openStatusEvidence: nonEmptyStringArray,
            knownResults: stringArray,
            verificationMode: {
              type: "string",
              enum: ["finite-witness", "exact-computation", "formalizable", "informal-proof", "unknown"],
            },
            interest: { type: "integer", minimum: 1, maximum: 5 },
            tractability: { type: "integer", minimum: 1, maximum: 5 },
            verifiability: { type: "integer", minimum: 1, maximum: 5 },
            sourceQuality: { type: "integer", minimum: 1, maximum: 5 },
            falsificationType: {
              type: "string",
              enum: FALSIFICATION_TYPES,
            },
            counterexampleSearchability: {
              type: "integer",
              minimum: 0,
              maximum: 5,
            },
            counterexampleVerificationPlan: nonEmptyString,
            whyPromising: nonEmptyString,
            risks: stringArray,
          },
          required: [
            "id",
            "title",
            "domain",
            "statement",
            "assumptions",
            "sourceUrls",
            "openStatusEvidence",
            "knownResults",
            "verificationMode",
            "interest",
            "tractability",
            "verifiability",
            "sourceQuality",
            "falsificationType",
            "counterexampleSearchability",
            "counterexampleVerificationPlan",
            "whyPromising",
            "risks"
          ],
        },
      },
    },
    required: ["problems"],
  },
};

export const VET_SCHEMA = {
  name: "problem_vetting",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      exactStatementVerified: { type: "boolean" },
      openStatusVerified: { type: "boolean" },
      sourceQualityVerified: { type: "boolean" },
      substantiveHumanStudyVerified: { type: "boolean" },
      correctedStatement: { type: "string" },
      correctedAssumptions: stringArray,
      canonicalSourceUrls: stringArray,
      statusEvidence: stringArray,
      materialErrors: stringArray,
      literatureRisks: stringArray,
      correctedFalsificationType: {
        type: "string",
        enum: FALSIFICATION_TYPES,
      },
      correctedCounterexampleSearchability: {
        type: "integer",
        minimum: 0,
        maximum: 5,
      },
      counterexampleAssessment: nonEmptyString,
      recommendation: { type: "string", enum: ["attack", "defer", "reject"] },
    },
    required: [
      "exactStatementVerified",
      "openStatusVerified",
      "sourceQualityVerified",
      "substantiveHumanStudyVerified",
      "correctedStatement",
      "correctedAssumptions",
      "canonicalSourceUrls",
      "statusEvidence",
      "materialErrors",
      "literatureRisks",
      "correctedFalsificationType",
      "correctedCounterexampleSearchability",
      "counterexampleAssessment",
      "recommendation"
    ],
  },
};

export const PLAN_SCHEMA = {
  name: "research_portfolio_plan",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      baseline: nonEmptyString,
      acceptanceContract: nonEmptyString,
      strategies: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            id: nonEmptyString,
            title: nonEmptyString,
            hypothesis: nonEmptyString,
            predictedObservation: nonEmptyString,
            falsifier: nonEmptyString,
            noveltyVector: stringArray,
            preferredTools: stringArray,
          },
          required: [
            "id",
            "title",
            "hypothesis",
            "predictedObservation",
            "falsifier",
            "noveltyVector",
            "preferredTools"
          ],
        },
      },
    },
    required: ["baseline", "acceptanceContract", "strategies"],
  },
};

export const EPOCH_SCHEMA = {
  name: "research_epoch_result",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      status: { type: "string", enum: ["progress", "candidate", "stalled", "blocked"] },
      progressKind: {
        type: "string",
        enum: ["verified-fact", "refuted-path", "search-pruning", "candidate", "reframe", "none"],
      },
      summary: nonEmptyString,
      verifiedFacts: stringArray,
      plausibleClaims: stringArray,
      failedApproaches: stringArray,
      unresolvedQuestions: stringArray,
      artifacts: { type: "array", items: artifactSchema },
      candidate: candidateSchema,
      nextAction: { type: "string", enum: ["deepen", "branch", "verify", "reframe", "stop"] },
      nextActionReason: nonEmptyString,
    },
    required: [
      "status",
      "progressKind",
      "summary",
      "verifiedFacts",
      "plausibleClaims",
      "failedApproaches",
      "unresolvedQuestions",
      "artifacts",
      "candidate",
      "nextAction",
      "nextActionReason"
    ],
  },
};

export const SYNTHESIS_SCHEMA = {
  name: "portfolio_synthesis",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      sharedVerifiedFacts: stringArray,
      rejectedClaims: stringArray,
      duplicateDirections: stringArray,
      informationGain: { type: "boolean" },
      portfolioSummary: nonEmptyString,
      branchDirectives: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            branchId: nonEmptyString,
            action: { type: "string", enum: ["deepen", "branch", "verify", "reframe", "stop"] },
            instruction: nonEmptyString,
          },
          required: ["branchId", "action", "instruction"],
        },
      },
      candidate: candidateSchema,
    },
    required: [
      "sharedVerifiedFacts",
      "rejectedClaims",
      "duplicateDirections",
      "informationGain",
      "portfolioSummary",
      "branchDirectives",
      "candidate"
    ],
  },
};

export const VERIFICATION_SCHEMA = {
  name: "candidate_verification",
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      verdict: { type: "string", enum: ["pass", "fail", "inconclusive"] },
      statementAlignment: nonEmptyString,
      exactnessAssessment: nonEmptyString,
      reproducedChecks: stringArray,
      fatalIssues: stringArray,
      nonFatalIssues: stringArray,
      independentArtifact: { type: "string" },
      recommendedStatus: {
        type: "string",
        enum: ["mechanically-verified-candidate", "candidate-only", "rejected", "needs-expert-review"],
      },
      feedbackToResearcher: nonEmptyString,
    },
    required: [
      "verdict",
      "statementAlignment",
      "exactnessAssessment",
      "reproducedChecks",
      "fatalIssues",
      "nonFatalIssues",
      "independentArtifact",
      "recommendedStatus",
      "feedbackToResearcher"
    ],
  },
};
