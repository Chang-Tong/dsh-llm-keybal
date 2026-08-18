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
 * Configuration is editable: the `llm-keybal` user-settings section holds the
 * live provider dict, and profile facts resolve per request, so a changed
 * key, endpoint, model, or knob reaches the next request without a restart.
 * A changed *route set* re-registers the same adapter instance in place.
 *
 * ```yaml
 * - id: llm-keybal
 *   name: 'dsh-llm-keybal'
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
 * @module dsh-llm-keybal
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AdapterRegistrationHandle, DirectoryRegistrationHandle, LlmConfigurableProvider } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { KeyBalAdapter, buildRoutes } from './adapter.ts'
import type { KeyBalRoute } from './adapter.ts'
import { assertServiceable, Config, resolveConfig } from './config.ts'
import { installCommands } from './commands.ts'

export { KeyBalAdapter } from './adapter.ts'
export type { KeyBalRoute } from './adapter.ts'
export { installCommands, renderProviders, renderStatus } from './commands.ts'
export type { CommandConfigSource, CommandServices } from './commands.ts'
export { Config, resolveConfig } from './config.ts'
export type {
  Config as KeyBalConfig,
  KeyBalDefaults,
  KeyBalModelConfig,
  KeyBalProviderConfig,
  KeyBalStrategy,
  ResolvedKeyBalConfig,
} from './config.ts'
export { createPool, acquire, report, poolStatus } from './pool.ts'
export type { KeyEntry, KeyPool } from './pool.ts'
export { KeyBalancer } from './balancer.ts'
export type { ModelPoolView, PickedCredential } from './balancer.ts'
export { serializeRequest, serializeMessages } from './serialize.ts'
export { parseSse } from './sse.ts'
export { translate } from './translate.ts'
export type * from './types.ts'

export const name = 'llm-keybal'
export const inject = ['llm']

const NS = settingsNamespace('llm-keybal')

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(config: Config): unknown {
  return Object.entries(config.providers)
    .map(([provider, profile]) => ({
      provider,
      displayName: profile.displayName,
    }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/**
 * The configurable-provider directory: every route the current configuration
 * declares. keybal has no installed catalog — every route is a hand-declared
 * pool — so `declared` is always true and the Models page offers the route's
 * settings address for editing.
 */
function directoryEntries(config: Config): LlmConfigurableProvider[] {
  return Object.entries(config.providers).map(([provider, profile]) => ({
    provider,
    displayName: profile.displayName ?? provider,
    settingsNs: NS,
    settingsPath: ['providers', provider],
    declared: true,
  }))
}

/**
 * Register the keybal adapter for every configured provider route. Route
 * facts resolve per request from the live configuration (plugin default +
 * `llm-keybal` settings section), so key, pool, and knob changes reach the
 * next request without a restart; only a changed route set re-registers.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let memoized: ReadonlyMap<string, KeyBalRoute> | undefined
  /**
   * The routes for the current configuration, memoized by the raw snapshot's
   * identity. Rebuilding per request would discard each pool's in-memory
   * selection and cooldown state; caching by snapshot keeps a pool stable
   * across operations that observe no change while a settings edit still
   * lands atomically on the next call.
   */
  const routes = (): ReadonlyMap<string, KeyBalRoute> => {
    const raw = current()
    if (raw === lastRaw && memoized !== undefined) return memoized
    const next = buildRoutes(resolveConfig(raw))
    lastRaw = raw
    memoized = next
    return next
  }
  routes()

  const adapter = new KeyBalAdapter(routes)
  let directory: DirectoryRegistrationHandle | undefined
  let directoryFacts: unknown
  const ensureDirectory = (): void => {
    const entries = directoryEntries(current())
    if (deepEqualJson(entries, directoryFacts)) return
    // The registry refuses an empty *initial* registration, and a bare keybal
    // mount has no routes until a settings section supplies providers — the
    // dormant posture. An already-registered directory may still be replaced
    // with an empty set (a section that emptied leaves no provider
    // configurable), so only the first mount skips.
    if (entries.length === 0 && directory === undefined) {
      directoryFacts = entries
      return
    }
    if (directory === undefined) {
      directory = ctx.llm.registerConfigurableProviders(entries)
    } else {
      directory.replace(entries)
    }
    directoryFacts = entries
  }
  ensureDirectory()

  let registration: AdapterRegistrationHandle | undefined
  let registeredFacts: unknown
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(current())
    if (deepEqualJson(facts, registeredFacts)) return
    const routeNames = [...routes().keys()]
    if (registration === undefined) {
      // Dormant bare mount: nothing is registered until a section supplies
      // providers, and an empty section keeps it that way.
      if (routeNames.length === 0) {
        registeredFacts = facts
        return
      }
      registration = ctx.llm.registerAdapter(routeNames, adapter)
    } else {
      // A section that emptied still holds the registration, now with zero
      // routes; the same adapter instance comes back when providers return.
      registration.replace(routeNames)
    }
    registeredFacts = facts
  }
  ensureRegistrationFacts()

  installSettingsSection(ctx, NS, Config, config, {
    // Refuse an unserviceable section where it is written: without this a
    // schema-valid provider the adapter cannot serve (an empty key pool)
    // would be stored and then silently disable every route in this
    // namespace.
    validate: assertServiceable,
    setSource: (source) => {
      current = source
    },
    onChange: () => {
      // Same containment as the settings watcher: a refused registry swap
      // keeps the previous routes serving and costs only a diagnostic.
      try {
        ensureRegistrationFacts()
      } catch (error) {
        ctx.logger.error('llm-keybal: keeping the previously registered routes after a refused update')
        ctx.logger.error(error)
      }
      try {
        ensureDirectory()
      } catch (error) {
        ctx.logger.error('llm-keybal: keeping the previous configurable-provider directory after a refused update')
        ctx.logger.error(error)
      }
    },
  })

  // Native commands ride the optional `commands` service: absent (bare mount,
  // test composition), nothing registers; present, the four pool-admin
  // commands appear. The config reader is the same live source the adapter
  // resolves per request, so a command edit lands on the next request.
  installCommands(ctx, routes, current)
}
