export const FALSIFICATION_TYPES = Object.freeze([
  "finite-counterexample",
  "computational-counterexample",
  "constructive-counterexample",
  "formal-negation",
  "not-applicable",
]);

const TYPE_FACTORS = Object.freeze({
  "finite-counterexample": 1,
  "computational-counterexample": 0.9,
  "constructive-counterexample": 0.65,
  "formal-negation": 0.25,
  "not-applicable": 0,
});

const VERIFICATION_FACTORS = Object.freeze({
  "finite-witness": 1,
  "exact-computation": 0.95,
  formalizable: 0.55,
  "informal-proof": 0.2,
  unknown: 0.05,
});

const LEGACY_FALSIFICATION_PATTERN =
  /\b(counterexample|counter-example|disproof|disprove|refut(?:e|ation)|falsif(?:y|ication))\b/i;

export function resolveFalsificationProfile(packet = {}) {
  const explicitSearchability = Number(packet.counterexampleSearchability);
  const hasExplicitSearchability =
    Number.isInteger(explicitSearchability) &&
    explicitSearchability >= 0 &&
    explicitSearchability <= 5;
  const explicitType = FALSIFICATION_TYPES.includes(packet.falsificationType)
    ? packet.falsificationType
    : null;

  if (hasExplicitSearchability || explicitType) {
    const searchability = hasExplicitSearchability
      ? explicitSearchability
      : explicitType === "not-applicable"
        ? 0
        : 1;
    return {
      type: explicitType ?? inferTypeFromVerification(packet.verificationMode),
      searchability,
      assessment:
        String(packet.counterexampleVerificationPlan ?? "").trim() ||
        "No counterexample verification plan was recorded.",
      source: "explicit",
    };
  }

  const legacyText = [
    packet.title,
    packet.statement,
    packet.whyPromising,
    ...(Array.isArray(packet.risks) ? packet.risks : []),
  ]
    .filter(Boolean)
    .join(" ");
  if (!LEGACY_FALSIFICATION_PATTERN.test(legacyText)) {
    return {
      type: "not-applicable",
      searchability: 0,
      assessment: "No concrete counterexample route was identified.",
      source: "legacy-default",
    };
  }

  return {
    type: inferTypeFromVerification(packet.verificationMode),
    searchability: boundedInteger(packet.tractability, 1, 5, 1),
    assessment:
      "Inferred conservatively from a legacy packet that explicitly mentions a counterexample or disproof; re-score during the next vetting pass.",
    source: "legacy-inferred",
  };
}

export function counterexampleOpportunity(packet = {}) {
  const profile = resolveFalsificationProfile(packet);
  const typeFactor = TYPE_FACTORS[profile.type] ?? 0;
  const verificationFactor =
    VERIFICATION_FACTORS[packet.verificationMode] ??
    VERIFICATION_FACTORS.unknown;
  const verifiability = boundedNumber(packet.verifiability, 1, 5, 3) / 5;
  const opportunity =
    (profile.searchability / 5) *
    typeFactor *
    verificationFactor *
    (0.5 + 0.5 * verifiability);
  return {
    ...profile,
    typeFactor,
    verificationFactor,
    opportunity: Number(Math.max(0, Math.min(1, opportunity)).toFixed(4)),
  };
}

function inferTypeFromVerification(verificationMode) {
  if (verificationMode === "finite-witness") return "finite-counterexample";
  if (verificationMode === "exact-computation") {
    return "computational-counterexample";
  }
  if (verificationMode === "formalizable") return "constructive-counterexample";
  return "formal-negation";
}

function boundedInteger(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}

function boundedNumber(value, minimum, maximum, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(minimum, Math.min(maximum, parsed));
}
