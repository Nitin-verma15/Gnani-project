// Google Gemini as the assistant's model, through the generateContent REST API.
// It presents the same small interface as the Anthropic client the agent loop uses
// (client.beta.messages.stream(params) -> { on("text"), finalMessage() }), so the loop,
// the tools, Undo and the ledger work unchanged. History stays in the agent's own format;
// this file translates it to Gemini's on every call.
// Reference: https://aistudio.google.com/api-reference/generate-content/generate-content.md

export const GEMINI_DEFAULT_MODEL = "gemini-3.8-flash";
const BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const TIMEOUT_MS = 90_000;
const THINKING_LEVELS = ["MINIMAL", "LOW", "MEDIUM", "HIGH"];
const REFUSALS = new Set(["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"]);

export class GeminiApiError extends Error {
  constructor(status, detail) {
    super(`Gemini API error ${status}: ${detail}`);
    this.status = status;
    this.detail = detail;
  }
}

/** Gemini accepts a subset of JSON Schema: no additionalProperties, and enums only on strings. */
export function toGeminiSchema(schema) {
  const out = {};
  if (schema.type) out.type = schema.type;
  let description = schema.description ?? "";
  if (Array.isArray(schema.enum)) {
    if (schema.enum.every((v) => typeof v === "string")) out.enum = schema.enum;
    else description = `${description}${description ? " " : ""}One of: ${schema.enum.join(", ")}.`;
  }
  if (description) out.description = description;
  if (schema.properties) {
    out.properties = Object.fromEntries(Object.entries(schema.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
  }
  if (schema.required?.length) out.required = schema.required;
  if (schema.items) out.items = toGeminiSchema(schema.items);
  return out;
}

export function toGeminiTools(tools) {
  return [{
    functionDeclarations: tools.map((t) => {
      const declaration = { name: t.name, description: t.description };
      // A tool with no inputs is declared without parameters at all.
      if (Object.keys(t.input_schema.properties ?? {}).length) declaration.parameters = toGeminiSchema(t.input_schema);
      return declaration;
    }),
  }];
}

function toolResponse(block) {
  const raw = typeof block.content === "string" ? block.content : JSON.stringify(block.content);
  if (block.is_error) return { error: raw };
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { result: parsed };
  } catch {
    return { result: raw };
  }
}

/** The agent's history (Anthropic-shaped) to Gemini contents. Signatures go back on their original part. */
export function toGeminiContents(messages) {
  const names = new Map();
  const contents = [];
  for (const message of messages) {
    const role = message.role === "assistant" ? "model" : "user";
    const blocks = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    const parts = [];
    for (const b of blocks) {
      if (b.type === "text") {
        const part = { text: b.text };
        if (b.gemini_signature) part.thoughtSignature = b.gemini_signature;
        if (part.text || part.thoughtSignature) parts.push(part);
      } else if (b.type === "tool_use") {
        names.set(b.id, b.name);
        const call = { name: b.name, args: b.input ?? {} };
        if (b.gemini_id) call.id = b.gemini_id;
        const part = { functionCall: call };
        if (b.gemini_signature) part.thoughtSignature = b.gemini_signature;
        parts.push(part);
      } else if (b.type === "tool_result") {
        const response = { name: names.get(b.tool_use_id) ?? "unknown", response: toolResponse(b) };
        if (b.gemini_id) response.id = b.gemini_id;
        parts.push({ functionResponse: response });
      }
      // Anything else (Claude thinking blocks, for example) has no Gemini equivalent.
    }
    if (!parts.length) continue;
    // Gemini wants turns to alternate, so neighbouring turns from the same side are joined.
    const previous = contents.at(-1);
    if (previous?.role === role) previous.parts.push(...parts);
    else contents.push({ role, parts });
  }
  return contents;
}

/** A Gemini response to the agent's message shape: { stop_reason, content }. */
export function fromGeminiResponse(body, nextId) {
  if (body.promptFeedback?.blockReason) return { stop_reason: "refusal", content: [] };
  const candidate = body.candidates?.[0];
  if (!candidate) throw new GeminiApiError(502, "No response from the model");
  if (REFUSALS.has(candidate.finishReason)) return { stop_reason: "refusal", content: [] };
  if (candidate.finishReason === "MALFORMED_FUNCTION_CALL") throw new GeminiApiError(502, "The model produced a malformed tool call");
  const content = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.thought) continue; // summaries of its reasoning, if any were returned
    if (part.functionCall) {
      const block = { type: "tool_use", id: part.functionCall.id || nextId(), name: part.functionCall.name, input: part.functionCall.args ?? {} };
      if (part.functionCall.id) block.gemini_id = part.functionCall.id;
      if (part.thoughtSignature) block.gemini_signature = part.thoughtSignature;
      content.push(block);
    } else if (typeof part.text === "string" || part.thoughtSignature) {
      const block = { type: "text", text: part.text ?? "" };
      if (part.thoughtSignature) block.gemini_signature = part.thoughtSignature;
      content.push(block);
    }
  }
  const calls = content.some((b) => b.type === "tool_use");
  const stop_reason = candidate.finishReason === "MAX_TOKENS" ? "max_tokens" : calls ? "tool_use" : "end_turn";
  return { stop_reason, content };
}

export function createGeminiClient({ apiKey, model = GEMINI_DEFAULT_MODEL, thinking = null, baseUrl = BASE_URL, fetchImpl = fetch }) {
  let counter = 0;
  const nextId = () => `gemini_${Date.now().toString(36)}_${++counter}`;
  const level = thinking && THINKING_LEVELS.includes(thinking.toUpperCase()) ? thinking.toUpperCase() : null;

  async function generate(params) {
    // The tool results the agent sends back need the call's Gemini id, which lives on the tool_use block.
    const ids = new Map();
    for (const m of params.messages) {
      if (m.role === "assistant" && Array.isArray(m.content)) {
        for (const b of m.content) if (b.type === "tool_use" && b.gemini_id) ids.set(b.id, b.gemini_id);
      }
    }
    const messages = params.messages.map((m) => (m.role === "user" && Array.isArray(m.content)
      ? { ...m, content: m.content.map((b) => (b.type === "tool_result" && ids.has(b.tool_use_id) ? { ...b, gemini_id: ids.get(b.tool_use_id) } : b)) }
      : m));

    const body = {
      systemInstruction: { parts: [{ text: params.system }] },
      contents: toGeminiContents(messages),
      tools: toGeminiTools(params.tools ?? []),
      generationConfig: { maxOutputTokens: params.max_tokens ?? 16000, ...(level ? { thinkingConfig: { thinkingLevel: level } } : {}) },
    };
    let res;
    try {
      res = await fetchImpl(`${baseUrl}/models/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new GeminiApiError(0, err.message);
    }
    if (!res.ok) {
      const text = await res.text();
      let detail = text.slice(0, 400);
      try { detail = JSON.parse(text).error?.message ?? detail; } catch { /* keep the raw text */ }
      throw new GeminiApiError(res.status, detail);
    }
    return fromGeminiResponse(await res.json(), nextId);
  }

  return {
    provider: "gemini",
    model,
    beta: {
      messages: {
        stream(params) {
          let onText = () => {};
          return {
            on(event, handler) {
              if (event === "text") onText = handler;
              return this;
            },
            async finalMessage() {
              const message = await generate(params);
              const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
              if (text) onText(text);
              return message;
            },
          };
        },
      },
    },
  };
}

/** Words for the owner when Gemini fails, in both languages since they may be read aloud. */
export function geminiFriendlyError(err) {
  const s = err.status;
  if (s === 0) return "Internet connection nahi mil raha. Can't reach Gemini, please check your connection.";
  if (s === 401 || s === 403 || (s === 400 && /api key/i.test(err.detail ?? ""))) {
    return "Gemini API key sahi nahi hai. The Gemini key isn't working; check GEMINI_API_KEY in .env.";
  }
  if (s === 404) return "Gemini model nahi mila. Check GEMINI_MODEL in .env, or remove it to use the default.";
  if (s === 429) return "Gemini ki free limit abhi poori ho gayi, ek minute baad try kijiye. The free limit is used up for now, please try again in a minute.";
  return "Kuch gadbad ho gayi, please dobara try kijiye. Something went wrong, please try again.";
}
