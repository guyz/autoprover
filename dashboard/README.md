# Autoprover dashboard

The dashboard is the low-effort control surface for a local Autoprover
campaign. It shows catalog discovery, the ranked backlog, active parallel
attempts, branch notes, retained failures, verification, budgets, and durable
operator nudges.

Run it from the repository root:

```bash
npm install --prefix dashboard
npm run dashboard
```

Then open the printed local URL (normally `http://127.0.0.1:4317/`). The local
controller serves both the UI and the mutation API. A statically hosted build is
read-only and is intended only as a product demonstration.

Runs started here are continuous by default. Subscription-backed providers
renew their call-accounting batch until the selected time expires; API-billed
Pro keeps hard call and cost limits. Pause waits for current calls to checkpoint
and freezes the remaining time. Continue resumes the same attempts and can add
an optional extension. The controller restarts an unexpectedly exited
continuous campaign from its durable checkpoint, and on macOS keeps the system
from entering idle sleep while research is active.

For build and lint checks:

```bash
npm run lint --prefix dashboard
npm test --prefix dashboard
```

See the repository [README](../README.md) for provider setup, campaign
semantics, persistence, and result-label definitions.
