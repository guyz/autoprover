import { resolveProviderName } from "../config.mjs";
import { ClaudeCliProvider } from "./claude-cli.mjs";
import { CodexCliProvider } from "./codex-cli.mjs";
import { OpenAIResponsesProvider } from "./openai-responses.mjs";
import { ProManualProvider } from "./pro-manual.mjs";

export function createProvider(config, options = {}) {
  const name = resolveProviderName(config);
  let provider;
  if (name === "pro") {
    provider = new OpenAIResponsesProvider(
      config,
      options.pro ?? options.responses,
    );
  } else if (name === "max") {
    provider = new CodexCliProvider(config, options.max ?? options.codex);
  } else if (name === "fable") {
    provider = new ClaudeCliProvider(config, options.fable ?? options.claude);
  } else if (name === "pro-manual") {
    provider = new ProManualProvider(
      config,
      options["pro-manual"] ?? options.proManual,
    );
  } else {
    throw new Error(`Unsupported provider: ${name}`);
  }
  return { name, provider };
}
