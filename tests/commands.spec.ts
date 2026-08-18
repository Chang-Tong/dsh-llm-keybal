import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as LlmKeyBal from '../src/index.ts'

const NS = settingsNamespace('llm-keybal')

async function home(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'keybal-cmd-'))
}

async function boot(keys: string[]): Promise<{ ctx: Context; dir: string }> {
  const dir = await home()
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LlmKeyBal, {
    providers: { deepseek_pool: poolConfig(keys) },
  })
  return { ctx, dir }
}

/** Boot with commands but no settings provider: mutating commands must refuse. */
async function bootWithoutSettings(keys: string[]): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(CommandRuntime)
  await ctx.plugin(LlmKeyBal, {
    providers: { deepseek_pool: poolConfig(keys) },
  })
  return ctx
}

function poolConfig(keys: string[]): LlmKeyBal.KeyBalProviderConfig {
  return { baseURL: 'https://api.deepseek.com', models: { 'deepseek-v4-flash': { keys } } }
}

/** Resolve one command definition and invoke its handler directly. */
async function runCommand(ctx: Context, line: string): Promise<{ kind: string; text?: string }> {
  const parsed = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  if (parsed === null || parsed[1] === undefined) return { kind: 'undefined' }
  const definition = ctx.commands.find({ id: 'test-agent' } as never, parsed[1])
  if (definition === undefined) return { kind: 'undefined' }
  return definition.handler({
    commandId: 'test' as never,
    agent: { id: 'test-agent', session: undefined } as never,
    rawInput: line.slice(parsed[0].length),
    signal: new AbortController().signal,
  })
}

describe('keybal native commands', () => {
  it('registers the four pool-admin commands when the commands service is present', async () => {
    const { ctx, dir } = await boot(['sk-a'])
    try {
      expect(ctx.commands.find({ id: 'test' } as never, 'keybal-status')).toBeDefined()
      expect(ctx.commands.find({ id: 'test' } as never, 'keybal-providers')).toBeDefined()
      expect(ctx.commands.find({ id: 'test' } as never, 'keybal-add-key')).toBeDefined()
      expect(ctx.commands.find({ id: 'test' } as never, 'keybal-set-strategy')).toBeDefined()
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders live pool status per provider/model', async () => {
    const { ctx, dir } = await boot(['sk-a', 'sk-b'])
    try {
      const result = await runCommand(ctx, '/keybal-status')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('deepseek_pool')
      expect(result.text).toContain('deepseek-v4-flash')
      expect(result.text).toContain('healthy=2/2')
      expect(result.text).toContain('failures=0')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reports an empty route map as no routes registered', async () => {
    expect(LlmKeyBal.renderStatus(new Map())).toBe('no keybal routes registered')
  })

  it('lists configured providers and their models', async () => {
    const { ctx, dir } = await boot(['sk-a'])
    try {
      const result = await runCommand(ctx, '/keybal-providers')
      expect(result.kind).toBe('success')
      expect(result.text).toContain('deepseek_pool')
      expect(result.text).toContain('deepseek-v4-flash')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders the provider directory without configured providers', async () => {
    expect(LlmKeyBal.renderProviders({ providers: {} })).toBe('no keybal providers configured')
  })

  it('renders a display name distinct from the route key', async () => {
    const text = LlmKeyBal.renderProviders({
      providers: { deepseek_pool: { displayName: 'DeepSeek 池', models: { 'deepseek-v4-flash': {} } } },
    })
    expect(text).toContain('deepseek_pool (DeepSeek 池)')
    expect(text).toContain('deepseek-v4-flash')
  })

  it('renders a provider whose display name equals its route key without a suffix', async () => {
    const text = LlmKeyBal.renderProviders({
      providers: { deepseek_pool: { displayName: 'deepseek_pool', models: { m: {} } } },
    })
    expect(text).toContain('deepseek_pool')
    expect(text).not.toContain('(deepseek_pool)')
  })

  it('renders a provider with no models and a missing profile defensively', async () => {
    const text = LlmKeyBal.renderProviders({
      providers: { empty_pool: { displayName: 'Empty', models: {} }, ghost_pool: undefined as never },
    })
    expect(text).toContain('empty_pool (Empty)')
    expect(text).toContain('models: (none)')
    expect(text).toContain('ghost_pool')
    expect(text).toContain('models: (none)')
  })

  it('appends a key through the settings section, persisting it', async () => {
    const { ctx, dir } = await boot(['sk-a'])
    try {
      const result = await runCommand(ctx, '/keybal-add-key deepseek_pool deepseek-v4-flash sk-b')
      expect(result.kind).toBe('success')
      expect(result.text).toBe('added key to deepseek_pool/deepseek-v4-flash (pool now 2 keys)')
      const stored = ctx.settings.get(NS) as { providers: Record<string, { models: Record<string, { keys: string[] }> }> }
      expect(stored.providers['deepseek_pool']?.models['deepseek-v4-flash']?.keys).toEqual(['sk-a', 'sk-b'])
      // The route rebuilt with the new key serves it immediately.
      const status = await runCommand(ctx, '/keybal-status')
      expect(status.text).toContain('healthy=2/2')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an add-key command without provider, model, or key', async () => {
    const { ctx, dir } = await boot(['sk-a'])
    try {
      const missing = await runCommand(ctx, '/keybal-add-key deepseek_pool')
      expect(missing.kind).toBe('error')
      expect(missing.text).toContain('usage:')
      const unknown = await runCommand(ctx, '/keybal-add-key nope_pool model sk-x')
      expect(unknown.kind).toBe('error')
      expect(unknown.text).toContain('unknown provider')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('creates a brand-new model pool when add-key targets an unconfigured model', async () => {
    const { ctx, dir } = await boot(['sk-a'])
    try {
      const result = await runCommand(ctx, '/keybal-add-key deepseek_pool deepseek-reasoner sk-new')
      expect(result.kind).toBe('success')
      expect(result.text).toBe('added key to deepseek_pool/deepseek-reasoner (pool now 1 keys)')
      const stored = ctx.settings.get(NS) as { providers: Record<string, { models: Record<string, { keys: string[] }> }> }
      expect(stored.providers['deepseek_pool']?.models['deepseek-reasoner']?.keys).toEqual(['sk-new'])
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('sets a pool-local strategy through the settings section', async () => {
    const { ctx, dir } = await boot(['sk-a'])
    try {
      const result = await runCommand(ctx, '/keybal-set-strategy deepseek_pool health')
      expect(result.kind).toBe('success')
      expect(result.text).toBe('set deepseek_pool strategy to health')
      const status = await runCommand(ctx, '/keybal-status')
      expect(status.text).toContain('[health]')
      // Persisted: the settings section now pins the strategy per model.
      const stored = ctx.settings.get(NS) as { providers: Record<string, { models: Record<string, { strategy: string }> }> }
      expect(stored.providers['deepseek_pool']?.models['deepseek-v4-flash']?.strategy).toBe('health')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('rejects an unknown strategy and an unknown provider', async () => {
    const { ctx, dir } = await boot(['sk-a'])
    try {
      const bad = await runCommand(ctx, '/keybal-set-strategy deepseek_pool bogus')
      expect(bad.kind).toBe('error')
      expect(bad.text).toContain('usage:')
      const unknown = await runCommand(ctx, '/keybal-set-strategy nope_pool health')
      expect(unknown.kind).toBe('error')
      expect(unknown.text).toContain('unknown provider')
    } finally {
      await ctx.fiber.dispose()
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('renders a pool line from a live balancer view', () => {
    const profile = poolConfig(['sk-a', 'sk-b', 'sk-c'])
    const pools = new LlmKeyBal.KeyBalancer(profile, {
      strategy: 'round-robin',
      maxRetries: 2,
      cooldownMs: 30000,
      providers: { deepseek_pool: profile },
    })
    const status = LlmKeyBal.renderStatus(new Map([['deepseek_pool', { baseURL: profile.baseURL, pools }]]))
    expect(status).toContain('deepseek_pool/deepseek-v4-flash')
    expect(status).toContain('healthy=3/3')
  })

  it('refuses add-key and set-strategy when no settings service is present', async () => {
    const ctx = await bootWithoutSettings(['sk-a'])
    try {
      const add = await runCommand(ctx, '/keybal-add-key deepseek_pool deepseek-v4-flash sk-b')
      expect(add.kind).toBe('error')
      expect(add.text).toContain('settings service is not available')
      const strategy = await runCommand(ctx, '/keybal-set-strategy deepseek_pool health')
      expect(strategy.kind).toBe('error')
      expect(strategy.text).toContain('settings service is not available')
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
