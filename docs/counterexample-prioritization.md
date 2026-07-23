# Counterexample prioritization research note

Checked: 2026-07-23

## Question

Are current AI systems empirically more likely to resolve an open mathematical
problem by finding a counterexample than by proving the conjecture?

## Finding

Not in general. The visible recent counterexamples are important, but the
available comparative evidence does not support a blanket "disproof is easier"
prior.

- The largest systematic open-problem experiment I found, [Advancing
  Mathematics Research with AI-Driven Formal Proof
  Search](https://arxiv.org/abs/2605.22763), attempted 353 formalized open
  Erdős problems and resolved 9, while proving 44 of 492 selected OEIS
  conjectures. Its nine reported Erdős resolutions are proofs or constructive
  existence arguments, not counterexamples. This dataset is biased toward
  Lean-formalizable problems, but it is much stronger evidence than a feed of
  memorable announcements.
- The most direct contrary comparison is
  [REFUTE](https://openreview.net/forum?id=M7cl4Ldw61): on incorrect
  competitive-programming solutions, the best tested reasoning agent created
  counterexamples for under 9%, despite model ratings indicating it could solve
  up to 48% of the corresponding problems from scratch. This is not pure
  mathematics, but it directly tests falsification with an executable checker.
- [BrokenMath](https://arxiv.org/abs/2510.04721) found that even its best model
  still produced a purported proof for a false advanced-mathematics statement
  29% of the time. Current models do not reliably notice that they should
  switch from proving to refuting.

There is, however, good evidence for a narrower operational advantage:
counterexamples become attractive when the negation has a concrete witness and
the witness has a cheap exact verifier.

- [Learning to
  Disprove](https://arxiv.org/abs/2603.19514) reports large gains from training
  specifically for formal counterexample generation. On its 1,058-item
  For-Counter benchmark, the specialized system reports 222 pass@1 successes
  versus 127 for the strongest listed baseline. The benchmark is curated rather
  than a sample of open problems, so this shows trainability and verifier
  leverage, not a general open-problem base rate.
- [DISPROVE](https://openreview.net/forum?id=5ck1jRE65S) certified all 15 false
  targets in a small 16-target benchmark by combining finite enumeration,
  widening, SMT, and Lean checking. The result is encouraging but small and
  deliberately selected for certified falsification.

## Product decision

Autoprover does not boost a problem merely because it is called a conjecture or
could be false. It assigns a bounded counterexample bonus only after discovery
and independent vetting record:

1. the logical form of the falsification route;
2. a 0-5 estimate of realistic searchability;
3. a concrete decisive verification plan; and
4. whether checking is finite, exact, formalizable, or merely informal.

The maximum lift is 8 priority points. Finite exact witnesses receive the full
multiplier; computational, constructive, and general-negation routes receive
progressively less. A high-searchability problem also receives an early
adversarial branch. This makes the policy a preference for **verifier leverage**,
not a claim that conjectures are usually false.

Every completed campaign attempt now records the candidate kind (`proof` or
`disproof`). That will let future versions estimate the proof/disproof base rate
from Autoprover's own attempts instead of continuing to rely only on external
benchmarks.
