import { extractJson, sleep, terminalStatus } from "../utils.mjs";

export class OpenAIResponsesProvider {
  constructor(config, options = {}) {
    this.config = config;
    this.apiKey = options.apiKey ?? process.env.OPENAI_API_KEY;
    this.baseUrl = options.baseUrl ?? process.env.OPENAI_BASE_URL ?? "https://api.openai.com/v1";
    this.fetch = options.fetch ?? globalThis.fetch;
    this.sleep = options.sleep ?? sleep;
    this.networkTimeoutMs = options.networkTimeoutMs ?? 60_000;
    if (!this.apiKey) throw new Error("OPENAI_API_KEY is required for the Responses provider");
    if (!Number.isFinite(this.networkTimeoutMs) || this.networkTimeoutMs <= 0) {
      throw new Error("Responses provider networkTimeoutMs must be positive");
    }
    const endpoint = new URL(this.baseUrl);
    if (endpoint.protocol !== "https:") {
      throw new Error("Responses API endpoint must use HTTPS");
    }
    if (
      endpoint.hostname !== "api.openai.com" &&
      options.allowCustomBaseUrl !== true
    ) {
      throw new Error(
        "Refusing to send OPENAI_API_KEY to a custom endpoint without allowCustomBaseUrl=true",
      );
    }
    this.baseUrl = this.baseUrl.replace(/\/+$/, "");
  }

  async run(request) {
    const runDeadline = deadlineFromTimeout(request.timeoutMs);
    let response;
    let activeResponseId = null;
    const pendingResponseId = request.resumeId ?? request.pendingResponseId;
    try {
      if (pendingResponseId) {
        activeResponseId = pendingResponseId;
        response = await this.retrieveUntilTerminal(
          pendingResponseId,
          remainingUntil(runDeadline),
        );
      } else {
        const body = this.buildBody(request);
        response = await this.requestJson("POST", "/responses", body, { deadlineMs: runDeadline });
        activeResponseId = response.id ?? null;
        await request.onStarted?.(response.id);
        if (!terminalStatus(response.status)) {
          response = await this.retrieveUntilTerminal(response.id, remainingUntil(runDeadline));
        }
      }

      if (response.status !== "completed") {
        const detail = response.error?.message ?? response.incomplete_details?.reason ?? response.status;
        const error = new Error(`Responses API run did not complete: ${detail}`);
        error.usage = normalizeUsage(response.usage);
        throw error;
      }

      const text = extractOutputText(response);
      return {
        sessionId: response.id,
        data: extractJson(text),
        rawText: text,
        usage: normalizeUsage(response.usage),
        evidence: extractToolEvidence(response),
        response,
      };
    } catch (error) {
      if (response?.usage && !error.usage) {
        error.usage = normalizeUsage(response.usage);
      }
      if (
        activeResponseId &&
        (!response || !terminalStatus(response.status))
      ) {
        await this.cancel(activeResponseId, {
          timeoutMs: Math.min(this.networkTimeoutMs, 15_000),
        }).catch(() => {});
      }
      throw error;
    }
  }

  buildBody(request) {
    const tools = [];
    if (request.tools?.webSearch !== false) tools.push({ type: "web_search" });
    if (request.tools?.codeInterpreter !== false) {
      tools.push({
        type: "code_interpreter",
        container: {
          type: "auto",
          memory_limit: this.config.responses.codeInterpreterMemory,
        },
      });
    }
    const body = {
      model: request.model.model,
      instructions: request.instructions,
      input: request.prompt,
      background: true,
      store: true,
      reasoning: {
        mode: request.model.mode,
        effort: request.model.effort,
        context: request.sessionId ? "all_turns" : "current_turn",
      },
      text: {
        format: {
          type: "json_schema",
          name: request.schema.name,
          strict: true,
          schema: request.schema.schema,
        },
      },
      max_output_tokens:
        request.maxOutputTokens ?? this.config.responses.maxOutputTokens,
      include: ["web_search_call.action.sources", "code_interpreter_call.outputs"],
      tools,
    };
    if (request.sessionId) body.previous_response_id = request.sessionId;
    return body;
  }

  async retrieveUntilTerminal(responseId, remainingRunMs = Infinity) {
    const timeout = Math.min(
      this.config.responses.requestTimeoutMinutes * 60_000,
      remainingRunMs,
    );
    const deadlineMs = deadlineFromTimeout(timeout);
    let response = await this.requestJson(
      "GET",
      `/responses/${encodeURIComponent(responseId)}`,
      undefined,
      { deadlineMs },
    );
    while (!terminalStatus(response.status)) {
      const remainingMs = remainingUntil(deadlineMs);
      if (remainingMs <= 0) {
        await this.cancel(responseId, { timeoutMs: Math.min(this.networkTimeoutMs, 15_000) }).catch(() => {});
        throw new Error("Responses API run timed out before its deadline");
      }
      await this.sleep(Math.min(this.config.responses.pollIntervalSeconds * 1000, remainingMs));
      if (remainingUntil(deadlineMs) <= 0) continue;
      response = await this.requestJson(
        "GET",
        `/responses/${encodeURIComponent(responseId)}`,
        undefined,
        { deadlineMs },
      );
    }
    return response;
  }

  async cancel(responseId, options = {}) {
    return this.requestJson("POST", `/responses/${encodeURIComponent(responseId)}/cancel`, undefined, options);
  }

  async requestJson(method, resource, body, options = {}) {
    const deadlineMs = resolveDeadline(options);
    const isCreate = method === "POST" && resource === "/responses";
    let lastError;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const remainingMs = remainingUntil(deadlineMs);
      if (remainingMs <= 0) {
        if (lastError) throw lastError;
        throw new OpenAINetworkTimeoutError("OpenAI request deadline elapsed before the request started");
      }

      let response;
      let text;
      try {
        ({ response, text } = await this.fetchWithTimeout(`${this.baseUrl}${resource}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        }, Math.min(this.networkTimeoutMs, remainingMs)));
      } catch (error) {
        if (isCreate) {
          throw new AmbiguousOpenAICreateError(
            "The Responses create request lost its transport before a complete response was received; it was not retried because the run may already exist",
            { cause: error },
          );
        }
        lastError = error;
      }

      if (response) {
        let data = {};
        try {
          data = text ? JSON.parse(text) : {};
        } catch {
          data = { error: { message: text || `${response.status} ${response.statusText}` } };
        }
        if (response.ok) return data;
        const message = data.error?.message ?? `${response.status} ${response.statusText}`;
        if (![408, 409, 429, 500, 502, 503, 504].includes(response.status)) {
          throw new NonRetryableOpenAIError(message);
        }
        if (isCreate && response.status !== 429) {
          throw new AmbiguousOpenAICreateError(
            `Responses create returned ${response.status}; it was not retried because the server may already have accepted the run: ${message}`,
          );
        }
        lastError = new Error(message);
      }

      if (attempt === 5) break;
      const backoffMs = Math.min(30_000, 750 * 2 ** attempt + Math.random() * 500);
      const retryRemainingMs = remainingUntil(deadlineMs);
      if (retryRemainingMs <= 0) break;
      await this.sleep(Math.min(backoffMs, retryRemainingMs));
    }
    throw lastError ?? new Error("OpenAI request failed");
  }

  async fetchWithTimeout(url, init, timeoutMs) {
    const controller = new AbortController();
    const timeoutError = new OpenAINetworkTimeoutError(
      `OpenAI network operation timed out after ${Math.ceil(timeoutMs)} ms`,
    );
    const timer = setTimeout(() => controller.abort(timeoutError), Math.max(1, timeoutMs));
    try {
      const response = await this.fetch(url, { ...init, signal: controller.signal });
      const text = await response.text();
      return { response, text };
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason === timeoutError) throw timeoutError;
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

function deadlineFromTimeout(timeoutMs = Infinity) {
  return Number.isFinite(timeoutMs) ? Date.now() + Math.max(0, timeoutMs) : Infinity;
}

function resolveDeadline({ deadlineMs = Infinity, timeoutMs = Infinity } = {}) {
  return Math.min(deadlineMs, deadlineFromTimeout(timeoutMs));
}

function remainingUntil(deadlineMs) {
  return Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs - Date.now()) : Infinity;
}

export function extractOutputText(response) {
  const parts = [];
  const refusals = [];
  for (const item of response.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (content.type === "output_text" && content.text) parts.push(content.text);
      if (content.type === "refusal") refusals.push(content.refusal ?? "The model refused the request");
    }
  }
  if (refusals.length) throw new ModelRefusalError(refusals.join("\n"));
  if (!parts.length && response.output_text) return response.output_text;
  if (!parts.length) throw new Error("Responses API returned no output text");
  return parts.join("\n");
}

export function normalizeUsage(usage = {}) {
  return {
    inputTokens: usage.input_tokens ?? 0,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? 0,
    cacheWriteTokens: usage.input_tokens_details?.cache_write_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? 0,
  };
}

export function extractToolEvidence(response) {
  const evidence = [];
  for (const item of response.output ?? []) {
    if (["web_search_call", "code_interpreter_call"].includes(item.type)) evidence.push(item);
    if (item.type === "message") {
      for (const content of item.content ?? []) {
        if (content.type === "output_text" && content.annotations?.length) {
          evidence.push({ type: "message_annotations", annotations: content.annotations });
        }
      }
    }
  }
  return evidence;
}

export class ModelRefusalError extends Error {
  constructor(message) {
    super(message);
    this.name = "ModelRefusalError";
  }
}

export class AmbiguousOpenAICreateError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "AmbiguousOpenAICreateError";
  }
}

export class OpenAINetworkTimeoutError extends Error {
  constructor(message) {
    super(message);
    this.name = "OpenAINetworkTimeoutError";
  }
}

class NonRetryableOpenAIError extends Error {
  constructor(message) {
    super(message);
    this.name = "NonRetryableOpenAIError";
  }
}
