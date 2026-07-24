# Autoprover

Autoprover is a resumable research loop that discovers promising open mathematics problems, attacks several in parallel, and keeps working within a configured wall-clock and cost budget. It produces auditable research state and candidate results; it does not certify that a theorem has been solved.

It is intentionally not a single chat receiving an endless stream of “keep going.” Each research epoch must create information: an exact fact, a falsified route, certified search-space pruning, a new falsifiable representation, or a candidate with a concrete verification plan. Empty epochs trigger a fresh-context reframe. Candidate authors never approve their own result.

## Why another prompt can help

A model does not keep thinking between chat turns. “Keep going” starts another bounded inference and tool-use episode. That helps for four reasons:

1. It allocates more test-time compute: more hypotheses, searches, code, and checks.
2. Failed experiments become feedback, so the next episode can prune or change course.
3. A new episode can sample a different tactic.
4. The previous turn may have stopped because “no result yet” was an acceptable conversational endpoint, not because the mathematical search was exhausted.

It becomes harmful when the state does not change. The model then tends to repeat an anchored approach or lower its threshold for declaring victory. Long transcripts also accumulate noisy logs and speculative lemmas. Autoprover therefore requires structured state deltas, persists artifacts, and can reset a stagnant branch into a fresh model context with a reframed strategy.

## Run it from the dashboard

The simplest operating mode is the local dashboard:

```bash
npm install --prefix dashboard
npm run dashboard
```

Open the printed `http://127.0.0.1:4317/` URL, choose a provider, a 12- or 24-hour limit, and the number of parallel problem slots, then press **Start**. The page polls only the local controller and uses an in-memory command token for mutations. A hosted copy of the UI is a read-only demonstration; it cannot control a process on your computer.

The campaign keeps one persistent, deduplicated catalog under `runs/_catalog/`. When the eligible queue runs low it launches a fresh discovery-and-vetting cycle, records immutable packet versions, and rechecks stale open-status evidence. Discovery requires substantive human mathematical study or an authoritative source; a machine-generated conjecture list alone is not accepted as evidence of interest or open status.

Problem selection is automatic and quality-diverse. The displayed priority still summarizes mathematical interest, predicted solvability, verifiability, source quality, prior progress, and counterexample opportunity, but the controller does not deterministically take the top rows. It combines that quality estimate with catalog coverage, uncertainty, prior effort, similarity to problems already running, and a durable run-specific random seed. This works for any number of problem slots, spreads independent installations over different qualified problems, and reproduces the same decisions after resume. There is no dashboard setting to tune.

Counterexample routes receive a bounded ranking lift only when discovery and independent vetting identify a concrete search space and decisive checker. A conjecture/disproof label alone receives no boost. Finite exact witnesses can add up to 8 priority points; less mechanically checkable routes receive less. See the [counterexample prioritization research note](docs/counterexample-prioritization.md) for the empirical basis and caveats.

Each problem gets one fenced lease and one immutable child run directory. Free worker slots refill continuously, while every problem's internal strategies use isolated branch workspaces. The planner proposes more strategies than will run; the controller fingerprints their representations, tools, central claims, and falsifiers, suppresses exact duplicates, and chooses a mutually dissimilar subset. Compact strategy-coverage receipts are carried into later attempts so retries avoid previously exhausted mechanisms unless they introduce a different algorithm, parameter shard, or falsifier. This anti-duplication machinery is internal and adds no operator controls.

A crash can resume the same discovery or attempt without replaying completed model calls. **Pause** prevents new model calls, lets calls already in flight checkpoint, freezes the unused campaign time, and leaves the campaign resumable. **Continue** restores those exact attempts; optionally adding time extends the frozen remainder rather than silently replacing it. Completed attempts remain in the dashboard with their coordinator report, branch histories, failed paths, artifacts, and verification passes.

Dashboard campaigns are continuous by default. For subscription-backed `max` and `fable`, the configured call count is a renewal batch used for accounting and checkpointing; reaching it no longer ends a run before its wall-clock deadline. API-billed `pro` retains hard call and dollar caps. The local dashboard supervises a continuous child process and restarts it from durable state after an unexpected exit. On macOS it also inhibits idle system sleep while the campaign process is active.

The queue includes four durable operator nudges:

- **Find more** starts another sourced and independently vetted discovery cycle.
- **Add** accepts a problem name or source URL and asks discovery to recover and vet its exact current statement before cataloging it.
- **Run next** pins a selected backlog problem ahead of automatic portfolio selection.
- **Switch out** checkpoints the active model call, records the interrupted attempt and its effort, cools that problem down for one hour, and frees the slot for another queued problem.

Attempt rows show cumulative active time, model-call count, outcomes, and failed or interrupted histories. Nudges are stored under the campaign directory, so refreshing or restarting the dashboard does not lose them.

The equivalent CLI commands are:

```bash
node src/cli.mjs campaign --yes \
  --provider max --hours 24 --parallel-problems 2 \
  --max-calls 60 --continuous

node src/cli.mjs campaign --yes --resume --continuous
node src/cli.mjs campaign --yes --resume --extend-hours 12 --continuous
```

`--max-cycles 0` means discovery can continue until the wall-clock or call/cost guard stops it. A positive value is useful for bounded evaluations. Campaign-global limits are enforced across every child run, so parallel workers cannot each consume the full call budget independently.

`parallelProblems` and `maxConcurrentCalls` are different controls. For example, six problem slots with four concurrent calls means six problem portfolios remain active, but at most four model invocations run at once; the other portfolios wait for the shared call semaphore without losing their leases or state.

## Model choice

The harness exposes four explicit providers behind the same structured research loop:

| Provider | Worker | Authentication and cost |
| --- | --- | --- |
| `max` | GPT-5.6 Sol through `codex exec`, Max reasoning | ChatGPT/Codex subscription allowance |
| `pro` | GPT-5.6 Sol through Responses API, Pro mode + Max reasoning | `OPENAI_API_KEY`; separately API billed |
| `pro-manual` | ChatGPT Pro through schema-checked copy/paste packets | ChatGPT subscription; requires a human for every packet |
| `fable` | Claude Fable 5 through `claude --print`, Max effort | Claude.ai Max subscription allowance |

`codex`, `responses`, and `claude` remain accepted as aliases for `max`, `pro`, and `fable`. `auto` always selects subscription-backed `max`; an ambient `OPENAI_API_KEY` never switches a run onto API billing. Select `pro` explicitly when API usage is intended:

```bash
node src/cli.mjs run --yes --provider max
node src/cli.mjs run --yes --provider pro --max-usd 100
node src/cli.mjs run --yes --provider fable
node src/cli.mjs run --yes --provider pro-manual
```

The Fable adapter uses the full `claude-fable-5` model ID, Max effort, a separate resumable session for every branch, JSON Schema output, safe mode, and the local Claude.ai login. Its required `subscriptionOnly: true` setting removes Anthropic API/proxy environment variables before launching Claude so a subscription run cannot silently become an API-billed run. The Max adapter enforces the same subscription-only rule for Codex and strips OpenAI API billing credentials from its child process.

The Max adapter similarly uses the ChatGPT-authenticated Codex CLI. Each Max worker starts with `--ignore-user-config`: authentication is retained, but personal plugins, MCP servers, browser sessions, and connectors are not inherited. Workers still have native web search and their isolated shell workspace. For the default `workspace-write` sandbox, the harness explicitly enables outbound command-line network access so public corpora can be fetched without the operator's browser. This keeps autonomous research reproducible, prevents an unrelated browser/download preference from stalling a branch, and avoids exposing personal integrations to a math worker. Public machine-readable artifacts are fetched non-interactively into the branch workspace and recorded with their source, size, and SHA-256 digest; interactive browsing is reserved for reading pages.

The Pro adapter is the only provider whose token usage contributes to `maxEstimatedUsd`. Ordinary CLI runs treat `maxCalls` as a hard guard for every provider. A campaign started with `--continuous` renews that allowance only for subscription-backed providers and still stops at its wall-clock deadline.

Run `npm run doctor` before a job. It checks both CLIs, supported Claude version, local authentication state, subscription type, API-key presence, and the selected provider. To prove live inference with one small structured call:

```bash
node src/cli.mjs smoke --yes --provider max
node src/cli.mjs smoke --yes --provider fable
node src/cli.mjs smoke --yes --provider pro  # incurs API usage
```

The selected canonical provider is stored in `run.json`. Resumes are pinned to it because Codex threads, Responses IDs, Claude sessions, and manual packet IDs are not interchangeable. Start a new run to switch provider.

### Manual ChatGPT Pro

`pro-manual` does not automate or scrape ChatGPT. It pauses on a stable packet containing the exact prompt and required schema:

```bash
# A curated file avoids spending manual turns re-vetting a packet you already trust.
node src/cli.mjs run --yes --provider pro-manual \
  --problem-file problems.json --trust-problem-file

node src/cli.mjs manual list --run-dir runs/<run-id>
node src/cli.mjs manual show --packet runs/<run-id>/manual-pro/<packet-id>
```

Paste `prompt.md` into a ChatGPT conversation with Pro explicitly selected, save the response locally, then import it:

```bash
node src/cli.mjs manual import \
  --packet runs/<run-id>/manual-pro/<packet-id> \
  --response-file answer.txt \
  --source-url https://chatgpt.com/share/<id>

node src/cli.mjs resume --yes --run-dir runs/<run-id>
```

The import is rejected unless it matches the packet's exact JSON Schema. Packet, prompt, response, and provenance hashes are persisted under `manual-pro/`. The default `waitForResponse: false` releases the process and records `awaiting-manual`; set it to `true` if you prefer the original process to poll while you respond from another terminal.

## Research state machine

```text
discover -> independently vet exact statement/status -> plan diverse portfolio
    -> run evidence-producing epochs
        -> deepen / branch / verify / reframe / stop
    -> candidate -> blind verifier 1 -> blind verifier 2
        -> reject and repair
        -> candidate reproduced by fresh agent contexts
        -> candidate requiring expert/formal review
```

The system never turns model consensus into mathematical truth. These labels are intentionally conservative:

| Label | Meaning |
| --- | --- |
| `candidate-complete-agent-reproduced` | A proof/disproof candidate for a `finite-witness` or `exact-computation` problem had a decisive artifact and survived the configured independent reproduction passes. It is still a candidate, not a certified solution. |
| `candidate-complete-needs-expert` | A complete proof/disproof candidate passed the configured critics, but it did not meet the exact artifact-reproduction gate. Informal proofs normally end here. |
| `verified-partial-lead` | An internal verification result for a useful lemma or partial result. Research continues; the full problem is not complete. |
| `rejected` or `inconclusive` | A verification attempt failed or did not establish enough. The originating branch may receive repair feedback. |

A trusted external checker, formal proof, specialist review, and precedence search remain necessary before publicly calling the underlying problem solved.

## Quick start

Requirements: Node.js 20 or newer for the research harness. The optional
dashboard currently requires Node.js 22.13 or newer and installs its own web
dependencies under `dashboard/`.

```bash
cp config.example.json config.json
npm run check
npm test
npm run doctor
```

Subscription-backed Max run:

```bash
codex login status
node src/cli.mjs run --yes --provider max --hours 12 --parallel-problems 2 --max-calls 60
```

API Pro run:

```bash
export OPENAI_API_KEY="..."
node src/cli.mjs run --yes --provider pro --hours 12 --max-usd 100
```

Claude Max / Fable 5 run:

```bash
claude auth status
node src/cli.mjs run --yes --provider fable --hours 12
```

Use `--hours 24` for a fresh 24-hour window:

```bash
node src/cli.mjs run --yes --hours 24 --parallel-problems 2 --max-calls 120 --max-usd 200
```

For a fresh run longer than 12 hours, each problem must pass a checkpoint after 12 hours of its own active worker time: it needs either an evidence-bearing proof/code/data/counterexample artifact with reproduction instructions, or a verifier pass with reproduced checks and an independent artifact. Queue time and time while the harness is offline do not count toward this checkpoint. A problem with no such evidence stops as `exhausted-no-result` instead of consuming further compute. The overall run still has one wall-clock deadline, and calls or API cost can stop it earlier.

Use an exact manually curated problem packet instead of automatic discovery. `problems.example.json` is a schema-shaped template with placeholder text and an `example.com` URL; it is intentionally rejected until you replace every placeholder with a real, sourced problem:

```bash
cp problems.example.json problems.json
# Edit problems.json with the exact statement, assumptions, sources, status evidence,
# verification mode, and 1-5 scores.
node src/cli.mjs validate --problem-file problems.json
node src/cli.mjs run --yes --problem-file problems.json --hours 12
```

`validate` is a local shape and source-URL check and makes no model calls. `run --problem-file` independently vets the exact statement and open status with a model before attacking it. `--trust-problem-file` skips that model vetting, but not the local packet validation; use it only for a packet you have already audited.

Inspect or resume:

```bash
node src/cli.mjs status
node src/cli.mjs status --run-dir runs/<run-id>
node src/cli.mjs resume --yes --run-dir runs/<run-id> --extend-hours 12
```

`status` is read-only and makes no model calls. `resume --extend-hours 12` extends the deadline by 12 hours from the later of the current time or stored deadline and reopens deadline-stopped problems. `--hours` is intentionally a new-run option and is rejected by `resume`; use `--extend-hours` there. Resume does not reopen a problem already marked `exhausted-no-result`, and a budget-stopped run also requires a higher `--max-calls` or `--max-usd` value. Use a fresh `--hours 24` run when you want one initial 24-hour experiment with the hour-12 evidence gate.

All commands that can make live model calls print a preflight and require `--yes` (or `AUTOPROVER_CONFIRM=1`). Help, validation, status, syntax checks, tests, `doctor`, and manual queue inspection/import do not start research calls.

## Status semantics

The top-level status describes why the whole run stopped; each problem has its own status in `run.json` and `summary.json`.

| Run status | Meaning |
| --- | --- |
| `completed-with-candidate` | At least one problem reached one of the candidate-complete labels and no problem ended with an uncaught error. |
| `completed-no-result` | Every problem reached a terminal non-candidate outcome without an uncaught error. This does not disprove solvability. |
| `deadline-reached` | Wall-clock time ended while work remained. Resume with an extension if the partial state warrants it. |
| `budget-exhausted` | The call-count or estimated API-token cost guard stopped work. Raise a relevant cap before resuming. |
| `completed-with-errors` | At least one problem failed and no candidate completed. |
| `completed-with-candidate-and-errors` | A candidate completed, but at least one other problem failed. |
| `awaiting-manual` | A `pro-manual` run exported one or more packets and is waiting for schema-valid imports before resume. |

During execution, `created`, `discovering`, `ready`, and `running` are ordinary transient states. At problem level, `exhausted-no-result` means the configured branch, reframe, stagnation, or hour-12 evidence limits were exhausted—not that the mathematical problem has been shown impossible.

## Persistence and parallelism

Every run writes an append-only event log, atomic `run.json` checkpoint, branch histories, provider session IDs, and hashed artifacts under `runs/<run-id>/`. Scout, vet, planner, branch, synthesis, and verifier calls all have stable operation keys. A completed operation can be replayed from the checkpoint without another model call; in-flight Responses IDs, Codex threads, Claude sessions, and manual packets are checkpointed for resume. A per-run lock refuses concurrent resumes of the same run.

The run directory is also the no-result dossier:

```text
runs/<run-id>/
  run.json                         # authoritative checkpoint and full structured history
  events.jsonl                     # append-only event/audit log
  summary.json                     # compact index written when a CLI command finishes normally
  evidence/<role>/*.json           # captured hosted-tool evidence when the provider returns it
  problems/<problem>/branches/<branch>/
    workspace/                     # branch-local working files and provider intermediates
    artifacts/epoch-<n>/*          # proof text, code, data, or witnesses emitted by an epoch
```

`summary.json` is an index, not a proof report. For a no-result run, inspect the problem's `sharedState`, branch histories, `failedApproaches`, verification runs, stop reason, and artifact paths in `run.json`, then use `events.jsonl` for chronology. If the process crashes before summary export, `run.json` and `events.jsonl` remain the recovery sources. In the final 22+ hour phase, the research prompt asks branches to freeze speculation and produce precise partial-result and failure artifacts; whether useful artifacts exist still depends on what the workers actually found.

`parallelProblems` limits the number of active problem portfolios. `maxConcurrentCalls` limits model calls across discovery, branches, synthesis, and verification. `branchesPerProblem` controls independent strategies per problem. The 12/24-hour setting is a wall-clock deadline, not one gigantic model call. When a campaign is paused, its remaining wall-clock allowance is stored durably and does not count down while the harness is offline.

## Cost and safety

- API Pro+Max can be expensive. The API path refuses new calls after `maxCalls` or `maxEstimatedUsd`; calls already in flight can take the final token estimate beyond the dollar threshold. The estimate uses configured token prices and does not include every hosted-tool or external fee.
- Max/Codex and Fable/Claude use subscription-managed allowances, for which this program does not calculate a billed dollar amount. `maxCalls` is a hard guardrail unless an explicit continuous campaign turns it into a renewable accounting batch.
- Manual Pro records zero token usage because ChatGPT does not expose usage data through the copy/paste workflow.
- Responses workers use OpenAI-hosted web search and sandboxed Code Interpreter. The Codex fallback uses `workspace-write`, isolated branch workspaces, and an isolated Codex configuration by default. It grants outbound network access to shell commands so public data files can be acquired with auditable non-interactive tools rather than through the operator's browser. Subscription workers receive a secret-stripped environment, but operators should still treat arbitrary external data as untrusted.
- Automatic discovery can still misunderstand a variant or miss a recent paper. Every discovered problem is independently vetted before selection, but a human should audit the exact statement and precedence before public claims.
- Failed approaches are retained in structured branch history. A trustworthy no-result dossier is a valid run outcome; persistence must not become pressure to fabricate a solution.

## Suggested first evaluation

Before trusting live open-problem claims, compare equal compute on solved-but-hidden research problems and subtly false variants:

1. one long attempt;
2. naive repeated “keep going”;
3. Autoprover's structured epoch loop;
4. Autoprover's parallel portfolio.

Measure exact success, false-claim rate, independent reproduction rate, time, tokens, and value of partial results. The viral transcript that motivated this project shows that persistence can matter, but it does not isolate persistence from tool use, accumulated evidence, model randomness, or survivorship bias.
