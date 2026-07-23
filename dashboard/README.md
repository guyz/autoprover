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

For build and lint checks:

```bash
npm run lint --prefix dashboard
npm test --prefix dashboard
```

See the repository [README](../README.md) for provider setup, campaign
semantics, persistence, and result-label definitions.
