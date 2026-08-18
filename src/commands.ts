/**
 * Native dsh commands for the keybal adapter. These are the model-visible
 * handle for pool administration: they read live pool state from the
 * registered balancers and edit the `llm-keybal` settings section through the
 * settings service, so every change lands on the same validated path a
 * settings document edit uses (a refused write leaves the previous
 * configuration serving).
 *
 * Both `commands` and `settings` are optional services here: a bare keybal
 * mount must still start (and serve) in a composition without them, so the
 * commands simply do not register and the read helpers degrade to undefined.
 *
 * @module dsh-llm-keybal/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { settingsNamespace, type SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { KeyBalRoute } from './adapter.ts'
import type { KeyBalStrategy } from './config.ts'

const NS = settingsNamespace('llm-keybal')

/** Strategy vocabulary shared with the config schema. */
const STRATEGIES: readonly KeyBalStrategy[] = ['round-robin', 'random', 'least-used', 'health']

/** The live configuration surface the commands edit. */
export interface CommandConfigSource {
  providers: Record<string, {
    displayName?: string
    strategy?: KeyBalStrategy
    models: Record<string, { keys?: string[] }>
  }>
}

/** The optional services a keybal command needs, resolved per invocation. */
export interface CommandServices {
  /** Settings provider owning the `llm-keybal` section, when present. */
  settings: SettingsProvider | undefined
  /** The command registry, when present. */
  commands: CommandRuntime | undefined
}

/**
 * One line of the status table for a model pool.
 * @param provider - the owning provider route.
 * @param view - live pool view.
 */
function poolLine(provider: string, view: { model: string; strategy: string; status(): Record<string, unknown> }): string {
  const status = view.status()
  return `  ${provider}/${view.model} [${view.strategy}] healthy=${String(status['healthy'])}/${String(status['total'])} cooling=${String(status['cooling'])} uses=${String(status['uses'])} failures=${String(status['failures'])}`
}

/**
 * Render the live pool status for every route, one line per model pool.
 * @param routes - the provider-function route map (re-read per request).
 */
export function renderStatus(routes: ReadonlyMap<string, KeyBalRoute>): string {
  if (routes.size === 0) return 'no keybal routes registered'
  const lines: string[] = []
  for (const [provider, route] of routes) {
    lines.push(provider)
    for (const view of route.pools.models()) lines.push(poolLine(provider, view))
  }
  return lines.join('\n')
}

/**
 * Render the provider/model directory from the current configuration.
 * @param config - the live resolved configuration.
 */
export function renderProviders(config: CommandConfigSource): string {
  const names = Object.keys(config.providers)
  if (names.length === 0) return 'no keybal providers configured'
  return names.map((provider) => {
    const profile = config.providers[provider]
    const label = profile?.displayName === undefined || profile.displayName === provider
      ? provider
      : `${provider} (${profile.displayName})`
    const models = Object.keys(profile?.models ?? {})
    return `${label}\n  models: ${models.length === 0 ? '(none)' : models.join(', ')}`
  }).join('\n')
}

/** Resolve the optional command services a keybal command needs. */
export function commandServices(ctx: Context): CommandServices {
  const settings: SettingsProvider | undefined = ctx.get('settings')
  const commands: CommandRuntime | undefined = ctx.get('commands')
  return { settings, commands }
}

/**
 * Register the keybal native commands on a context, each as a disposable
 * effect. When the `commands` service is absent nothing registers; when the
 * `settings` service is absent the mutating commands report an error instead
 * of persisting.
 * @param ctx - the plugin context.
 * @param routes - provider-function route map (live state source).
 * @param config - live configuration reader.
 */
export function installCommands(
  ctx: Context,
  routes: () => ReadonlyMap<string, KeyBalRoute>,
  config: () => CommandConfigSource,
): void {
  const { commands } = commandServices(ctx)
  if (commands === undefined) return

  commands.register({
    name: 'keybal-status',
    description: 'Show keybal pool health per provider/model (total, healthy, cooling, uses, failures)',
    handler: () => ({ kind: 'success' as const, text: renderStatus(routes()) }),
  })

  commands.register({
    name: 'keybal-providers',
    description: 'List configured keybal providers and their models',
    handler: () => ({ kind: 'success' as const, text: renderProviders(config()) }),
  })

  commands.register({
    name: 'keybal-add-key',
    description: 'Append one API key to a keybal provider/model pool (persisted to the llm-keybal settings section)',
    input: { hint: '<provider> <model> <key>' },
    handler: async (invocation) => {
      const parts = invocation.rawInput.trim().split(/\s+/)
      const [provider, model] = parts
      const key = parts.slice(2).join('')
      if (provider === undefined || model === undefined || key === '') {
        return { kind: 'error' as const, text: 'usage: /keybal-add-key <provider> <model> <key>' }
      }
      const services = commandServices(ctx)
      if (services.settings === undefined) {
        return { kind: 'error' as const, text: 'settings service is not available; cannot persist the key' }
      }
      const current = config()
      const profile = current.providers[provider]
      if (profile === undefined) {
        return { kind: 'error' as const, text: `unknown provider "${provider}"` }
      }
      const keys = profile.models[model]?.keys ?? []
      const next: Record<string, unknown> = {}
      for (const [name, entry] of Object.entries(profile.models)) {
        next[name] = { ...entry }
      }
      next[model] = { ...next[model] as object, keys: [...keys, key] }
      await services.settings.update(NS, {
        providers: {
          ...current.providers,
          [provider]: { ...profile, models: next },
        },
      })
      return { kind: 'success' as const, text: `added key to ${provider}/${model} (pool now ${keys.length + 1} keys)` }
    },
  })

  commands.register({
    name: 'keybal-set-strategy',
    description: 'Set the load-balancing strategy for a keybal provider (round-robin, random, least-used, health)',
    input: { hint: '<provider> <strategy>' },
    handler: async (invocation) => {
      const [provider, strategy] = invocation.rawInput.trim().split(/\s+/)
      if (provider === undefined || strategy === undefined || !STRATEGIES.includes(strategy as KeyBalStrategy)) {
        return { kind: 'error' as const, text: `usage: /keybal-set-strategy <provider> <${STRATEGIES.join('|')}>` }
      }
      const services = commandServices(ctx)
      if (services.settings === undefined) {
        return { kind: 'error' as const, text: 'settings service is not available; cannot persist the strategy' }
      }
      const current = config()
      const profile = current.providers[provider]
      if (profile === undefined) {
        return { kind: 'error' as const, text: `unknown provider "${provider}"` }
      }
      // Strategy is a per-model override in the config schema (there is no
      // provider-level knob), so the command pins every model of the route.
      const next: Record<string, unknown> = {}
      for (const [name, entry] of Object.entries(profile.models)) {
        next[name] = { ...entry, strategy }
      }
      await services.settings.update(NS, {
        providers: {
          ...current.providers,
          [provider]: { ...profile, models: next },
        },
      })
      return { kind: 'success' as const, text: `set ${provider} strategy to ${strategy}` }
    },
  })
}
