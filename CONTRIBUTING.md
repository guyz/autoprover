# Contributing

Autoprover is experimental research software. Contributions that improve
reproducibility, conservative result labeling, provider isolation, or useful
failure records are especially welcome.

## Before opening a pull request

```bash
npm run check
npm test
npm install --prefix dashboard
npm run lint --prefix dashboard
npm test --prefix dashboard
```

Do not commit API keys, provider session data, local campaign state, generated
artifacts, or `.openai/hosting.json`.

When changing the research loop, add a deterministic test for the relevant
checkpoint, resume, budget, or verification behavior. A model agreeing with its
own result is not sufficient verification.
