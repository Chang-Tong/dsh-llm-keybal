# dsh-llm-keybal

Multi-provider API-key load-balancing LLM adapter for the DeepSeek Harness
(dsh). Published to npm as `dsh-llm-keybal`.

One plugin instance registers an `LlmAdapter` for every configured provider
route. Each (provider, model) owns a **pool of API keys**; requests are
load-balanced across them with automatic failover and failure cooldown. This
is the pattern for running several subscriptions of the same provider
(chatgpt / claude / qwen / deepseek accounts) behind one route.

## Installation

```sh
# in your dsh profile directory (e.g. ~/.dsh/profiles/web)
pnpm add dsh-llm-keybal
```

Then insert the plugin row into the profile's `cordis.patch.yml`. The
package's own bundle layer inserts the row already, but **API keys never
live in the published package**: add them by overriding the row config in
your profile patch:

```yaml
- id: llm-keybal
  config:
    strategy: round-robin
    maxRetries: 2
    cooldownMs: 30000
    providers:
      deepseek_pool:
        displayName: DeepSeek Pool
        baseURL: https://api.deepseek.com
        models:
          deepseek-v4-flash:
            keys: [sk-…]        # your keys, in YOUR profile only
```

## Configuration

```yaml
- id: llm-keybal
  name: dsh-llm-keybal
  config:
    strategy: round-robin      # round-robin | random | least-used | health
    maxRetries: 2              # additional key attempts after the first failure
    cooldownMs: 30000          # key cooldown after repeated failures (ms)
    providers:
      deepseek_pool:           # route key IS the provider name shown in selectors
        displayName: DeepSeek 池
        baseURL: https://api.deepseek.com
        models:
          deepseek-v4-flash:
            keys: [sk-a, sk-b, sk-c]   # multiple keys, load-balanced
            # optional per-model overrides:
            # strategy: health
            # maxRetries: 1
            # cooldownMs: 60000
            # contextWindow: 131072
            # maxTokens: 8192
      openai_pool:
        baseURL: https://api.openai.com/v1
        models:
          gpt-4o-mini:
            keys: [sk-…]
      qwen_pool:
        baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1
        models:
          qwen-max:
            keys: [sk-…]
```

Provider route keys follow the `<name>_pool` convention so selectors read
naturally (`deepseek_pool`, `openai_pool`, `claude_pool`, `qwen_pool`). Any
OpenAI-compatible endpoint works: chatgpt/claude/qwen subscription gateways
that expose `/chat/completions` are valid `baseURL`s.

### Load-balancing strategies

| Strategy | Behavior |
| --- | --- |
| `round-robin` (default) | Cycles through healthy keys in order. |
| `random` | Picks a random healthy key. |
| `least-used` | Picks the key with the fewest in-flight + total requests. |
| `health` | Picks the key with the lowest failure weight (failures×10 + uses). |

A key that fails twice consecutively (or with 401/403) enters a `cooldownMs`
cooldown and is skipped while cooling; when every key is cooling the pool
falls back to the key closest to recovery so the route keeps serving. A
request that fails with 429 / 5xx / auth / transport errors automatically
retries the next key, up to `maxRetries` additional attempts.

## Model Experience

### What the model sees

The selected model receives `GenerateOptions.system`, history, tools, and
sampling fields serialized to the OpenAI-compatible chat-completions format.
This package adds no prompt prose. Requests always stream with usage
reporting; reasoning content is replayed to the wire only on tool-call turns
(the DeepSeek thinking-mode passback rule).

### Reasoning effort

Each model entry may pin a default reasoning effort (`off`, `high`, `max`)
with `reasoningEffort:`; the model selector always offers the same Off / High /
Max choices as the DeepSeek provider, with the pinned level preselected (an
unpinned model defaults to `high`). The
effort is materialized per request: `off` sends `thinking: {type: disabled}`,
`high` / `max` send `thinking: {type: enabled}` plus
`reasoning_effort: high|max`. Without a pin the request carries no effort
field and the provider's own default applies.

### Token effect

Provider tokenization governs exact input. Serialization adds no
model-visible text.

### KV Cache effect

No provider-side cache is primed or invalidated by this package. Prompt
cache hits reported by the provider are passed through as `cacheReadTokens`.

## Native commands

When the dsh `commands` service is present (every interactive profile), the
plugin registers four pool-administration commands. They read live balancer
state and edit the `llm-keybal` settings section through the settings
service, so every change lands on the same validated path a settings
document edit uses (a refused write leaves the previous configuration
serving). A bare mount without `commands` or `settings` simply skips them.

| Command | Effect |
| --- | --- |
| `/keybal-status` | Live per-pool line: provider/model, strategy, healthy/total keys, cooling keys, uses, failures. |
| `/keybal-providers` | Configured providers, display names, and per-provider model lists. |
| `/keybal-add-key <provider> <model> <key>` | Append one API key to a pool (creates the pool when the model is unconfigured). Persists into the settings document. |
| `/keybal-set-strategy <provider> <round-robin\|random\|least-used\|health>` | Switch every model of a provider to a strategy. Persists into the settings document. |

## Settings section

The browser settings panel gains a **KeyBal 池** section (id `llm-keybal`)
when the package's client bundle is loaded. It shows every configured pool:
provider route, model name, current strategy, and the number of keys (never
the keys themselves — API keys are `role('secret')` and never cross the wire;
the descriptor's `secrets` side table only reports how many a pool holds).
The strategy dropdown writes back through the settings wire with revision
checking. Appending keys stays on the host side (`/keybal-add-key` or the
config file) because the wire is write-only for secrets: a browser form
cannot read a pool's existing keys, so it cannot rewrite the array without
destroying them.

## Layout

| File | Purpose |
| --- | --- |
| `src/config.ts` | Config schema, defaults, and serviceability validation. |
| `src/pool.ts` | Per-(provider, model) key pool: strategies, cooldown, health. |
| `src/balancer.ts` | Per-route pool registry wiring config to pools. |
| `src/serialize.ts` | Harness messages → wire chat-completions request. |
| `src/sse.ts` | SSE byte stream → data payloads. |
| `src/translate.ts` | Wire chunks → harness `StreamChunk`s. |
| `src/adapter.ts` | `KeyBalAdapter` (LlmAdapter) with load-balanced streaming. |
| `src/commands.ts` | Native pool-administration commands (status / providers / add-key / set-strategy). |
| `src/client/index.ts` | Client bundle entry: registers the KeyBal settings section. |
| `src/client/KeyBalSection.tsx` | Settings page: pool overview + strategy editing. |
| `src/index.ts` | Plugin entry: registers routes on `ctx.llm`, commands, and the settings section. |

## Publishing

This repository is the standalone home of `dsh-llm-keybal`; publish it with a
plain `npm publish` from the repo root (the `prepublishOnly` script builds
and tests first):

```sh
npm login                  # an account allowed to publish unscoped packages
npm publish                # builds, tests, then publishes dsh-llm-keybal
```

Host packages (`@deepseek-ai/cordis`, `@deepseek-ai/dsh-llm`,
`@deepseek-ai/dsh-invariants`, `@deepseek-ai/schemastery`) are
`peerDependencies`: the dsh runtime that loads this plugin already provides
them, so the published tarball carries only `eventsource-parser`.

## Known Limitations and Deferred Work

- Keys are literal configuration values (a pool is several credentials, not
  one reference). The browser settings section is deliberately read-mostly
  for secrets: keys are `role('secret')` on the wire, so a client form can
  only add keys through the host command (`/keybal-add-key`); editing or
  removing keys means a settings-document or profile config edit.
- The wire protocol is OpenAI-compatible chat-completions only; native
  Anthropic `/v1/messages` is not yet supported (Anthropic-compatible
  gateways that expose `/chat/completions` work).
- The adapter performs a non-incremental stream read per request before
  emitting chunks; a true token-incremental SSE passthrough is deferred.
