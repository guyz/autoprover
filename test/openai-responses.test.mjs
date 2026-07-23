import assert from "node:assert/strict";
import test from "node:test";
import { loadConfig } from "../src/config.mjs";
import {
  AmbiguousOpenAICreateError,
  ModelRefusalError,
  OpenAIResponsesProvider,
  extractOutputText,
  normalizeUsage,
} from "../src/providers/openai-responses.mjs";

test("Responses provider emits Pro and Max independently", async () => {
  const config = await loadConfig(null, {});
  const provider = new OpenAIResponsesProvider(config, { apiKey: "test-key", fetch: async () => {} });
  const body = provider.buildBody({
    model: { model: "gpt-5.6-sol", mode: "pro", effort: "max" },
    instructions: "policy",
    prompt: "problem",
    schema: { name: "result", schema: { type: "object" } },
    sessionId: "resp_previous",
    tools: { webSearch: true, codeInterpreter: true },
  });
  assert.equal(body.model, "gpt-5.6-sol");
  assert.deepEqual(body.reasoning, { mode: "pro", effort: "max", context: "all_turns" });
  assert.equal(body.previous_response_id, "resp_previous");
  assert.deepEqual(body.tools.map((tool) => tool.type), ["web_search", "code_interpreter"]);
});

test("extractOutputText joins message parts and normalizes usage", () => {
  const response = {
    output: [
      { type: "reasoning" },
      {
        type: "message",
        content: [
          { type: "output_text", text: "{\"a\":" },
          { type: "output_text", text: "1}" },
        ],
      },
    ],
  };
  assert.equal(extractOutputText(response), "{\"a\":\n1}");
  assert.deepEqual(
    normalizeUsage({
      input_tokens: 100,
      output_tokens: 20,
      input_tokens_details: { cached_tokens: 40 },
      output_tokens_details: { reasoning_tokens: 7 },
    }),
    {
      inputTokens: 100,
      cachedInputTokens: 40,
      cacheWriteTokens: 0,
      outputTokens: 20,
      reasoningTokens: 7,
    },
  );
});

test("permanent API errors fail immediately", async () => {
  const config = await loadConfig(null, {});
  let calls = 0;
  const provider = new OpenAIResponsesProvider(config, {
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "invalid schema" } }), { status: 400 });
    },
  });
  await assert.rejects(() => provider.requestJson("POST", "/responses", {}), /invalid schema/);
  assert.equal(calls, 1);
});

test("ambiguous create transport failures are not retried", async () => {
  const config = await loadConfig(null, {});
  let calls = 0;
  const provider = new OpenAIResponsesProvider(config, {
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      throw new TypeError("socket reset");
    },
  });

  await assert.rejects(
    () => provider.requestJson("POST", "/responses", {}),
    AmbiguousOpenAICreateError,
  );
  assert.equal(calls, 1);
});

test("ambiguous create server failures are not retried", async () => {
  const config = await loadConfig(null, {});
  let calls = 0;
  const provider = new OpenAIResponsesProvider(config, {
    apiKey: "test-key",
    fetch: async () => {
      calls += 1;
      return new Response(JSON.stringify({ error: { message: "upstream failed" } }), { status: 500 });
    },
  });
  await assert.rejects(
    () => provider.requestJson("POST", "/responses", {}),
    AmbiguousOpenAICreateError,
  );
  assert.equal(calls, 1);
});

test("per-fetch timeout is bounded by the request's remaining time", async () => {
  const config = await loadConfig(null, {});
  let calls = 0;
  const provider = new OpenAIResponsesProvider(config, {
    apiKey: "test-key",
    networkTimeoutMs: 10_000,
    fetch: async (_url, { signal }) => {
      calls += 1;
      assert.ok(signal);
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        text: () =>
          new Promise((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      };
    },
  });

  const started = Date.now();
  await assert.rejects(
    () => provider.requestJson("POST", "/responses", {}, { timeoutMs: 30 }),
    AmbiguousOpenAICreateError,
  );
  assert.equal(calls, 1);
  assert.ok(Date.now() - started < 1_000);
});

test("structured-output refusals are surfaced as typed errors", () => {
  assert.throws(
    () =>
      extractOutputText({
        output: [
          {
            type: "message",
            content: [{ type: "refusal", refusal: "Cannot comply" }],
          },
        ],
      }),
    ModelRefusalError,
  );
});
