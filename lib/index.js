import { CallId, EMPTY_RESPONSE_CODE, LlmAdapter, LlmError, attributionHeaders } from "@deepseek-ai/dsh-llm";
import z from "@deepseek-ai/schemastery";
import { EventSourceParserStream } from "eventsource-parser/stream";
const KeyBalStrategySchema = z.union([
	"round-robin",
	"random",
	"least-used",
	"health"
]);
const modelConfig = z.object({
	keys: z.array(z.string()).default([]),
	name: z.string(),
	description: z.string(),
	contextWindow: z.number().step(1).min(1),
	maxTokens: z.number().step(1).min(1),
	strategy: KeyBalStrategySchema,
	maxRetries: z.number().step(1).min(0),
	cooldownMs: z.natural()
});
const providerConfig = z.object({
	displayName: z.string(),
	baseURL: z.string().required(),
	models: z.dict(modelConfig).default({})
});
/** Runtime schema for {@link Config}; fills every default. */
const Config = z.object({
	strategy: KeyBalStrategySchema.default("round-robin"),
	maxRetries: z.number().step(1).min(0).default(2),
	cooldownMs: z.natural().default(3e4),
	providers: z.dict(providerConfig).default({})
});
/** Materialize every schema default into one resolved snapshot. */
function resolveConfig(config) {
	return {
		strategy: config.strategy ?? "round-robin",
		maxRetries: config.maxRetries ?? 2,
		cooldownMs: config.cooldownMs ?? 3e4,
		providers: config.providers
	};
}
/**
* Reject a configuration the adapter could not serve, naming the offending
* route or model. Keys are the whole credential plane here (unlike
* reference-based adapters), so an empty pool is the one unserviceable shape.
*/
function assertServiceable(config) {
	for (const [provider, profile] of Object.entries(config.providers)) {
		if (profile.baseURL.length === 0) throw new Error(`keybal: provider "${provider}" needs a non-empty baseURL`);
		for (const [model, entry] of Object.entries(profile.models)) if (entry.keys.length === 0) throw new Error(`keybal: provider "${provider}" model "${model}" has no keys configured`);
	}
}
//#endregion
//#region lib/types/pool.js
/**
* The key pool: per-(provider, model) API-key entries with load-balancing
* strategies, failure tracking, and cooldown. This is the load-balancing core
* of the keybal adapter. One `KeyPool` owns the keys of exactly one model on
* one provider route; `KeyBalancer` owns every pool of one adapter instance.
*
* @module @deepseek-ai/dsh-llm-keybal/pool
*/
/** Create one pool over the given keys. */
function createPool(keys, options, model) {
	return {
		model,
		strategy: options.strategy,
		cooldownMs: options.cooldownMs,
		maxRetries: options.maxRetries,
		rr: 0,
		entries: keys.map((key) => ({
			key,
			uses: 0,
			failures: 0,
			consecutiveFailures: 0,
			disabledUntil: 0,
			inflight: 0
		}))
	};
}
function healthy(now, entries) {
	return entries.filter((entry) => entry.disabledUntil <= now);
}
function pickRandom(entries) {
	return entries[Math.floor(Math.random() * entries.length)];
}
/**
* Acquire one key for a request. Skips cooling keys; when every key is
* cooling, falls back to the key closest to recovery so a degraded pool keeps
* serving rather than deadlocking. Selection honors the pool strategy; the
* round-robin cursor advances past the picked entry.
*/
function acquire(pool) {
	const ready = healthy(Date.now(), pool.entries);
	if (ready.length === 0) {
		if (pool.entries.length === 0) return null;
		const soonest = [...pool.entries].sort((a, b) => a.disabledUntil - b.disabledUntil)[0];
		soonest.inflight++;
		return soonest;
	}
	let entry;
	if (pool.strategy === "random") entry = pickRandom(ready);
	else if (pool.strategy === "least-used") entry = ready.reduce((a, b) => a.inflight + a.uses <= b.inflight + b.uses ? a : b);
	else if (pool.strategy === "health") entry = ready.reduce((a, b) => a.failures * 10 + a.uses <= b.failures * 10 + b.uses ? a : b);
	else {
		entry = ready[pool.rr % ready.length];
		pool.rr = (pool.rr + 1) % ready.length;
	}
	entry.inflight++;
	return entry;
}
/**
* Report one request outcome back to the pool. Success resets the
* consecutive-failure streak; failure marks the key, and a key that fails
* twice in a row (or with an auth error) enters cooldown for {@link KeyPool.cooldownMs}.
*/
function report(pool, entry, ok, status) {
	entry.inflight = Math.max(0, entry.inflight - 1);
	entry.uses++;
	if (ok) {
		entry.consecutiveFailures = 0;
		return;
	}
	entry.failures++;
	entry.consecutiveFailures++;
	if (entry.consecutiveFailures >= 2 || status === 401 || status === 403) entry.disabledUntil = Date.now() + pool.cooldownMs;
}
/** Detached pool health view for diagnostics. */
function poolStatus(pool, now = Date.now()) {
	return {
		model: pool.model,
		strategy: pool.strategy,
		total: pool.entries.length,
		healthy: healthy(now, pool.entries).length,
		cooling: pool.entries.filter((entry) => entry.disabledUntil > now).length,
		uses: pool.entries.reduce((sum, entry) => sum + entry.uses, 0),
		failures: pool.entries.reduce((sum, entry) => sum + entry.failures, 0),
		inflight: pool.entries.reduce((sum, entry) => sum + entry.inflight, 0)
	};
}
//#endregion
//#region lib/types/balancer.js
/**
* The per-route key-pool registry: one {@link KeyPool} per model, created
* from provider configuration with plugin defaults applied. The adapter asks
* the balancer to acquire a credential and reports outcomes back by entry
* index.
*
* @module @deepseek-ai/dsh-llm-keybal/balancer
*/
/**
* Registry of per-model key pools for one provider route. Model config may
* override the plugin-wide strategy, retry, and cooldown defaults.
*/
var KeyBalancer = class {
	profile;
	defaults;
	pools = /* @__PURE__ */ new Map();
	constructor(profile, defaults) {
		this.profile = profile;
		this.defaults = defaults;
		for (const [model, config] of Object.entries(profile.models)) this.pools.set(model, createPool(config.keys, {
			strategy: config.strategy ?? defaults.strategy,
			cooldownMs: config.cooldownMs ?? defaults.cooldownMs,
			maxRetries: config.maxRetries ?? defaults.maxRetries
		}, model));
	}
	/** Pick one credential for a model using the pool's strategy. */
	acquire(model) {
		const pool = this.pools.get(model);
		if (pool === void 0) return null;
		const entry = acquire(pool);
		if (entry === null) return null;
		return {
			entry,
			entryIndex: pool.entries.indexOf(entry)
		};
	}
	/** Report one request outcome against the pool entry that served it. */
	report(model, entryIndex, ok, status) {
		const pool = this.pools.get(model);
		if (pool === void 0) return;
		const entry = pool.entries[entryIndex];
		if (entry === void 0) return;
		report(pool, entry, ok, status);
	}
	/** The pool for one model, when configured. */
	model(model) {
		const pool = this.pools.get(model);
		if (pool === void 0) return void 0;
		const config = this.profile.models[model];
		return {
			model,
			contextWindow: config?.contextWindow ?? 131072,
			maxTokens: config?.maxTokens ?? 8192,
			strategy: pool.strategy,
			status: () => ({
				strategy: pool.strategy,
				total: pool.entries.length,
				healthy: pool.entries.filter((entry) => entry.disabledUntil <= Date.now()).length,
				cooling: pool.entries.filter((entry) => entry.disabledUntil > Date.now()).length,
				uses: pool.entries.reduce((sum, entry) => sum + entry.uses, 0),
				failures: pool.entries.reduce((sum, entry) => sum + entry.failures, 0),
				inflight: pool.entries.reduce((sum, entry) => sum + entry.inflight, 0)
			})
		};
	}
	/** Every configured model, in configuration order. */
	models() {
		return Object.keys(this.profile.models).map((model) => this.model(model)).filter(Boolean);
	}
	maxRetries(model) {
		return this.profile.models[model]?.maxRetries ?? this.defaults.maxRetries;
	}
};
//#endregion
//#region lib/types/serialize.js
/**
* Serialize harness messages into the OpenAI-compatible chat-completions
* wire format. User text is joined; assistant text becomes `content`, tool
* calls become `tool_calls`, reasoning is replayed as `reasoning_content`
* only on tool-call turns (the DeepSeek thinking-mode passback rule), and
* tool results become separate `role: 'tool'` messages.
*
* @module @deepseek-ai/dsh-llm-keybal/serialize
*/
/** Join the text blocks of a message (used for user/tool-result content). */
function flattenText(blocks) {
	return blocks.filter((block) => block.type === "text").map((block) => block.text).join("");
}
/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message) {
	const text = flattenText(message.content);
	const reasoning = message.content.filter((block) => block.type === "reasoning").map((block) => block.text).join("");
	const toolCalls = message.content.filter((block) => block.type === "tool-call").map((block) => ({
		id: block.id,
		type: "function",
		function: {
			name: block.name,
			arguments: block.arguments
		}
	}));
	return {
		role: "assistant",
		content: text,
		...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
		...toolCalls.length > 0 ? { tool_calls: toolCalls } : {}
	};
}
/**
* Serialize the conversation. `tool-result` blocks become standalone
* `{role: 'tool'}` messages; a mixed user message contributes its text first
* and its tool results as separate wire messages after.
*/
function serializeMessages(messages) {
	const wire = [];
	for (const message of messages) {
		if (message.role === "system") {
			wire.push({
				role: "system",
				content: flattenText(message.content)
			});
			continue;
		}
		if (message.role === "assistant") {
			wire.push(serializeAssistant(message));
			continue;
		}
		const toolResults = message.content.filter((block) => block.type === "tool-result");
		const text = flattenText(message.content);
		if (text.length > 0 || toolResults.length === 0) wire.push({
			role: "user",
			content: text
		});
		for (const result of toolResults) wire.push({
			role: "tool",
			tool_call_id: result.toolCallId,
			content: flattenText(result.content) || "(no output)"
		});
	}
	return wire;
}
/**
* Build the full wire request. Always streaming with usage reporting on;
* optional fields are omitted rather than sent as null.
*/
function serializeRequest(options) {
	const messages = [];
	if (options.system !== void 0) messages.push({
		role: "system",
		content: options.system
	});
	messages.push(...serializeMessages(options.messages));
	const tools = options.tools?.map((tool) => ({
		type: "function",
		function: {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters
		}
	}));
	return {
		model: options.model,
		messages,
		stream: true,
		stream_options: { include_usage: true },
		...tools !== void 0 && tools.length > 0 ? { tools } : {},
		...options.temperature !== void 0 ? { temperature: options.temperature } : {},
		...options.maxTokens === void 0 ? {} : { max_tokens: options.maxTokens },
		...options.stop !== void 0 ? { stop: options.stop } : {}
	};
}
/** Reject an unsupported reasoning effort before it reaches the wire. */
function assertSupportedEffort(effort) {
	if (effort !== void 0 && effort !== "off" && effort !== "high" && effort !== "max") throw new LlmError(`keybal does not support reasoning effort "${effort}"`, "UNSUPPORTED_REASONING_EFFORT");
}
/**
* Parse an SSE byte stream into data payloads. Yields `[DONE]` as the final
* value and returns; throws `LlmError('STREAM_CLOSED')` when the stream ends
* without it.
*/
async function* parseSse(stream) {
	const events = stream.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream());
	for await (const { data } of events) {
		yield data;
		if (data === "[DONE]") return;
	}
	throw new LlmError("SSE stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/translate.js
/**
* Translate OpenAI-compatible SSE payloads into harness `StreamChunk`s. One
* stateful block per content, reasoning, or tool-call index; an empty initial
* reasoning delta does not open a block; finish reason and the latest usage
* are deferred until `[DONE]`.
*
* @module @deepseek-ai/dsh-llm-keybal/translate
*/
/** Map the wire finish_reason vocabulary to the harness FinishReason. */
function mapFinishReason(reason) {
	switch (reason) {
		case "stop": return { kind: "stop" };
		case "tool_calls": return { kind: "tool-calls" };
		case "length": return { kind: "max-tokens" };
		default: return {
			kind: "error",
			failure: {
				message: `model stopped: ${reason}`,
				code: reason.toUpperCase()
			}
		};
	}
}
/** Map wire usage fields to disjoint harness counts (cache hits subtracted). */
function mapUsage(usage) {
	const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
	const reasoning = usage.completion_tokens_details?.reasoning_tokens;
	return {
		inputTokens: usage.prompt_tokens - (cacheRead ?? 0),
		outputTokens: usage.completion_tokens,
		...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
		...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
	};
}
/** Assemble the final ContentBlock for one open block. */
function closeBlock(block) {
	switch (block.kind) {
		case "text": return {
			type: "text",
			text: block.text
		};
		case "reasoning": return {
			type: "reasoning",
			text: block.text
		};
		case "tool-call": return {
			type: "tool-call",
			id: CallId(block.callId ?? ""),
			name: block.name ?? "",
			arguments: block.text
		};
	}
}
/**
* Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks.
* Malformed JSON payloads abort the stream with `MALFORMED_RESPONSE`.
*/
async function* translate(payloads) {
	let nextIndex = 0;
	let textBlock;
	let reasoningBlock;
	const toolBlocks = /* @__PURE__ */ new Map();
	const order = [];
	let pendingFinish;
	let pendingUsage;
	function open(kind) {
		const block = {
			index: nextIndex++,
			kind,
			text: ""
		};
		order.push(block);
		return block;
	}
	for await (const payload of payloads) {
		if (payload === "[DONE]") {
			for (const block of order) yield {
				type: "block-end",
				index: block.index,
				block: closeBlock(block)
			};
			if (pendingUsage) yield {
				type: "usage",
				usage: pendingUsage
			};
			const reason = pendingFinish ?? { kind: "stop" };
			yield {
				type: "finish",
				reason: reason.kind === "stop" && order.length === 0 ? {
					kind: "error",
					failure: {
						message: "model returned a completed response with no content",
						code: EMPTY_RESPONSE_CODE
					}
				} : reason
			};
			return;
		}
		let chunk;
		try {
			chunk = JSON.parse(payload);
		} catch {
			throw new LlmError(`malformed SSE payload: ${payload.slice(0, 120)}`, "MALFORMED_RESPONSE");
		}
		for (const choice of chunk.choices ?? []) {
			const delta = choice.delta;
			const reasoning = delta?.reasoning_content;
			if (typeof reasoning === "string" && reasoning.length > 0) {
				if (!reasoningBlock) {
					reasoningBlock = open("reasoning");
					yield {
						type: "block-start",
						index: reasoningBlock.index,
						blockType: "reasoning"
					};
				}
				reasoningBlock.text += reasoning;
				yield {
					type: "reasoning-delta",
					index: reasoningBlock.index,
					text: reasoning
				};
			}
			const content = delta?.content;
			if (typeof content === "string" && content.length > 0) {
				if (!textBlock) {
					textBlock = open("text");
					yield {
						type: "block-start",
						index: textBlock.index,
						blockType: "text"
					};
				}
				textBlock.text += content;
				yield {
					type: "text-delta",
					index: textBlock.index,
					text: content
				};
			}
			for (const call of delta?.tool_calls ?? []) {
				let block = toolBlocks.get(call.index ?? 0);
				if (!block) {
					block = open("tool-call");
					toolBlocks.set(call.index ?? 0, block);
					yield {
						type: "block-start",
						index: block.index,
						blockType: "tool-call"
					};
				}
				if (call.id !== void 0) block.callId = call.id;
				if (call.function?.name !== void 0) block.name = call.function.name;
				const fragment = call.function?.arguments ?? "";
				block.text += fragment;
				yield {
					type: "tool-call-delta",
					index: block.index,
					id: CallId(block.callId ?? ""),
					...block.name !== void 0 ? { name: block.name } : {},
					argumentsDelta: fragment
				};
			}
			if (typeof choice.finish_reason === "string") pendingFinish = mapFinishReason(choice.finish_reason);
		}
		if (chunk.usage) pendingUsage = mapUsage(chunk.usage);
	}
	throw new LlmError("SSE payload stream ended without [DONE]", "STREAM_CLOSED");
}
//#endregion
//#region lib/types/adapter.js
/**
* The keybal LlmAdapter: one instance serves every configured provider route,
* routing each stream call through the route's per-model key pool with
* automatic failover. Transport is the standard OpenAI-compatible
* chat-completions SSE endpoint reached through the global `fetch`; a failed
* or rate-limited key is reported back to the pool and the next key tried,
* up to the pool's maxRetries.
*
* @module @deepseek-ai/dsh-llm-keybal/adapter
*/
/** Map an HTTP status to a stable harness error code. */
function httpErrorCode(status, error) {
	const detail = [
		error?.code,
		error?.type,
		error?.message
	].filter(Boolean).join(" ");
	if (status === 401 || status === 403) return "AUTH";
	if (detail.includes("insufficient_quota") || detail.includes("quota")) return "QUOTA";
	if (status === 429) return "RATE_LIMIT";
	if (status === 400) return "INVALID_REQUEST";
	if (status >= 500) return "SERVER";
	return `HTTP_${status}`;
}
function providerRetryAfterMs(value) {
	if (value === null) return void 0;
	if (/^\d+$/.test(value)) {
		const delay = Number(value) * 1e3;
		return Number.isFinite(delay) && delay > 0 ? delay : void 0;
	}
	const delay = Date.parse(value) - Date.now();
	return Number.isFinite(delay) && delay > 0 ? delay : void 0;
}
/**
* Load-balancing LlmAdapter. Route facts are re-read from the provider
* function per operation so a configuration change reaches the next request
* without re-registration.
*/
var KeyBalAdapter = class extends LlmAdapter {
	routes;
	constructor(routes) {
		super();
		this.routes = routes;
	}
	providerInfo(provider) {
		return {
			id: provider,
			name: this.routes().get(provider)?.displayName ?? provider
		};
	}
	listModels(provider) {
		const route = this.routes().get(provider);
		if (route === void 0) return Promise.resolve([]);
		return Promise.resolve(route.pools.models().map((pool) => ({
			provider,
			id: pool.model,
			name: pool.model,
			inputModalities: ["text"]
		})));
	}
	resolveModel(provider, model, _signal) {
		const pool = this.routes().get(provider)?.pools.model(model);
		return Promise.resolve({
			provider,
			id: model,
			name: model,
			inputModalities: ["text"],
			...pool === void 0 ? {} : {
				context: { contextWindow: pool.contextWindow },
				defaultMaxTokens: pool.maxTokens
			}
		});
	}
	/**
	* Stream one model call. Picks a key from the route's pool, performs the
	* request, and on a failure reports the key and retries with the next one
	* (up to the pool's maxRetries). Chunks pass through the SSE translation.
	*/
	async *stream(options) {
		assertSupportedEffort(options.reasoningEffort);
		const route = this.routes().get(options.provider);
		if (route === void 0) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: `no keybal route for provider "${options.provider}"`,
						code: "NO_ADAPTER"
					}
				}
			};
			return;
		}
		const body = serializeRequest(options);
		const attempts = 1 + route.pools.maxRetries(options.model);
		for (let attempt = 0; attempt < attempts; attempt++) {
			const credential = this.acquireCredential(route, options.model);
			if (credential === null) {
				yield {
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: `provider "${options.provider}" model "${options.model}" has no keys configured`,
							code: "MISSING_CREDENTIAL"
						}
					}
				};
				return;
			}
			const outcome = await this.requestOnce(route, credential, body, options);
			route.pools.report(options.model, credential.entryIndex, outcome.ok, outcome.status);
			if (outcome.ok) {
				yield* outcome.chunks;
				return;
			}
			if (outcome.status === 400 || outcome.status === 404 || outcome.status === 422) {
				yield* outcome.chunks;
				return;
			}
			if (attempt === attempts - 1) yield* outcome.chunks;
		}
	}
	acquireCredential(route, model) {
		const picked = route.pools.acquire(model);
		if (picked === null) return null;
		return {
			key: picked.entry.key,
			entryIndex: picked.entryIndex
		};
	}
	async requestOnce(route, credential, body, options) {
		const controller = new AbortController();
		const signal = options.signal === void 0 ? controller.signal : AbortSignal.any([options.signal, controller.signal]);
		try {
			const response = await fetch(`${route.baseURL.replace(/\/+$/, "")}/chat/completions`, {
				method: "POST",
				headers: {
					"authorization": `Bearer ${credential.key}`,
					"content-type": "application/json",
					"accept": "text/event-stream",
					...attributionHeaders()
				},
				body: JSON.stringify(body),
				signal
			});
			if (!response.ok) {
				let message = `keybal upstream error (HTTP ${response.status})`;
				try {
					const parsed = await response.json();
					if (parsed.error?.message) message = parsed.error.message;
				} catch {}
				const delay = providerRetryAfterMs(response.headers.get("retry-after"));
				throw new LlmError(message, httpErrorCode(response.status), {
					status: response.status,
					...delay === void 0 ? {} : { providerRetryAfterMs: delay }
				});
			}
			if (response.body === null) throw new LlmError("keybal upstream returned no response body", "EMPTY_RESPONSE");
			const chunks = [];
			for await (const chunk of translate(parseSse(response.body))) chunks.push(chunk);
			return {
				ok: true,
				status: 200,
				chunks
			};
		} catch (error) {
			if (options.signal?.aborted) return {
				ok: true,
				status: 0,
				chunks: [{
					type: "finish",
					reason: {
						kind: "aborted",
						failure: {
							message: "keybal request aborted by caller",
							code: "ABORTED"
						}
					}
				}]
			};
			const failure = error instanceof LlmError ? error : new LlmError(`keybal request failed: ${error instanceof Error ? error.message : String(error)}`, "TRANSPORT");
			const status = failure.failure.status;
			return {
				ok: false,
				status: status ?? 0,
				chunks: [{
					type: "finish",
					reason: {
						kind: "error",
						failure: {
							message: failure.message,
							code: failure.code,
							...status !== void 0 ? { status } : {}
						}
					}
				}]
			};
		} finally {
			controller.abort("keybal stream consumer stopped");
		}
	}
};
/** Resolve the adapter routes from a resolved configuration snapshot. */
function buildRoutes(config) {
	const routes = /* @__PURE__ */ new Map();
	for (const [provider, profile] of Object.entries(config.providers)) {
		const pools = new KeyBalancer(profile, config);
		routes.set(provider, {
			baseURL: profile.baseURL,
			...profile.displayName === void 0 ? {} : { displayName: profile.displayName },
			pools
		});
	}
	return routes;
}
//#endregion
//#region lib/types/index.js
/**
* keybal — multi-provider API-key load-balancing LLM adapter.
*
* One plugin instance registers a {@link KeyBalAdapter} for every configured
* provider route; the route key is the provider name shown in selectors
* (convention `<name>_pool`, e.g. `deepseek_pool`, `openai_pool`,
* `claude_pool`, `qwen_pool`). Each (provider, model) owns a pool of API
* keys; requests are load-balanced across them with automatic failover and
* failure cooldown. Keys are literal configuration values (a key pool is
* several credentials, not one reference), so this adapter takes them
* directly from the plugin config rather than through the credential seam.
*
* ```yaml
* - id: llm-keybal
*   name: '@deepseek-ai/dsh-llm-keybal'
*   config:
*     strategy: round-robin
*     maxRetries: 2
*     cooldownMs: 30000
*     providers:
*       deepseek_pool:
*         displayName: DeepSeek 池
*         baseURL: https://api.deepseek.com
*         models:
*           deepseek-v4-flash:
*             keys: [sk-…, sk-…]
*       openai_pool:
*         displayName: OpenAI 池
*         baseURL: https://api.openai.com/v1
*         models:
*           gpt-4o-mini:
*             keys: [sk-…]
* ```
*
* @module @deepseek-ai/dsh-llm-keybal
*/
const name = "llm-keybal";
const inject = ["llm"];
/**
* Register the keybal adapter for every configured provider route. Routes are
* a static composition fact (keys are literal config), so there is no
* settings section: re-registration is unnecessary because route and pool
* facts never change after load.
*/
function apply(ctx, config) {
	assertServiceable(config);
	const routes = buildRoutes(resolveConfig(config));
	const routeNames = [...routes.keys()];
	const adapter = new KeyBalAdapter(() => routes);
	if (routeNames.length > 0) ctx.llm.registerAdapter(routeNames, adapter);
	ctx.logger.info(`llm-keybal: registered ${routeNames.length} provider route(s): ${routeNames.join(", ")}`);
}
//#endregion
export { Config, KeyBalAdapter, KeyBalancer, acquire, apply, createPool, inject, name, parseSse, poolStatus, report, resolveConfig, serializeMessages, serializeRequest, translate };
