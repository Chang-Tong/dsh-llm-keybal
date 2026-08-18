/**
 * Dynamic-configuration tests: the keybal adapter registers and re-registers
 * routes from the `llm-keybal` user-settings section without a restart, and
 * refuses a section the adapter could not serve.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { settingsNamespace } from '@deepseek-ai/dsh-settings'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import * as LlmKeyBal from '../src/index.ts'

const NS = settingsNamespace('llm-keybal')

/** Minimal foreign adapter: only needs to own a route the keybal plugin then wants. */
class StubAdapter extends LlmAdapter {
  override async *stream(): AsyncIterable<never> {
    throw new Error('stub adapter must never stream')
  }
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!()
})

async function home(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-keybal-dynamic-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return dir
}

/** Real dynamic composition: llm registry + settings file + the keybal plugin. */
async function boot(dir: string, config: LlmKeyBal.Config): Promise<Context> {
  const ctx = new Context()
  cleanups.push(async () => {
    await ctx.fiber.dispose()
  })
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(FileSettingsProvider, { path: join(dir, 'settings.yaml'), watch: false })
  await ctx.plugin(LlmKeyBal, config)
  return ctx
}

const poolConfig = (keys: string[]): LlmKeyBal.KeyBalProviderConfig => ({
  baseURL: 'https://api.deepseek.com',
  models: { 'deepseek-v4-flash': { keys } },
})

describe('dynamic provider routes', () => {
  it('mounts bare and dormant, then registers routes the moment settings supply providers', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: {} })

    expect(ctx.llm.listProviders()).toEqual([])
    // Dormant ≠ invisible: every declared provider is configurable before any
    // route exists, each addressed inside the providers dict.
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory).toEqual([])

    await ctx.settings.update(NS, { providers: { deepseek_pool: poolConfig(['sk-a', 'sk-b']) } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek_pool'])
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'deepseek_pool',
      displayName: 'deepseek_pool',
      settingsNs: 'llm-keybal',
      settingsPath: ['providers', 'deepseek_pool'],
      declared: true,
    })
    await expect(ctx.llm.listModels('deepseek_pool')).resolves.not.toHaveLength(0)

    // Emptying the user layer returns the adapter to its dormant state.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders()).toEqual([])
    expect(ctx.llm.listConfigurableProviders()).toEqual([])
  })

  it('adds a provider route from settings and drops it when the user layer resets', async () => {
    const dir = await home()
    const ctx = await boot(dir, {
      providers: { openai_pool: poolConfig(['sk-openai']) },
    })

    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai_pool'])
    await ctx.settings.update(NS, {
      providers: {
        openai_pool: poolConfig(['sk-openai']),
        qwen_pool: poolConfig(['sk-qwen']),
      },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai_pool', 'qwen_pool'])

    // Reset the user layer: the settings-born route unregisters, the
    // composition route stays.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['openai_pool'])
  })

  it('rotates per-request keys when a settings edit replaces the pool', async () => {
    const dir = await home()
    const ctx = await boot(dir, {
      providers: { deepseek_pool: poolConfig(['sk-one']) },
    })

    // The route set is unchanged, so no re-registration happens; the pool
    // itself is re-read per request, so the new key reaches the next call.
    await ctx.settings.update(NS, { providers: { deepseek_pool: poolConfig(['sk-two']) } })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek_pool'])
    const route = ctx.llm.listProviders()[0]
    expect(route?.id).toBe('deepseek_pool')
  })

  it('re-registers routes in place when a display name changes', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { deepseek_pool: poolConfig(['sk-a']) } })

    await ctx.settings.update(NS, {
      providers: {
        deepseek_pool: { ...poolConfig(['sk-a']), displayName: 'DeepSeek 池' },
      },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek_pool'])
    expect(ctx.llm.listProviders()[0]?.name).toBe('DeepSeek 池')
  })

  it('refuses a settings write this adapter could not serve, leaving its routes alone', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { deepseek_pool: poolConfig(['sk-a']) } })

    // Shape-valid but unserviceable: the user layer empties the key pool.
    // `models: {}` would not do this — the settings merge keeps the base
    // layer's models — so the pool itself is emptied.
    await expect(ctx.settings.update(NS, {
      providers: {
        deepseek_pool: {
          baseURL: 'https://api.deepseek.com',
          models: { 'deepseek-v4-flash': { keys: [] } },
        },
      },
    })).rejects.toThrow(/has no keys configured/)
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(['deepseek_pool'])
  })

  it('keeps serving its routes when a settings-born route collides with another adapter', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { deepseek_pool: poolConfig(['sk-a']) } })
    // Another adapter owns `claude_pool`; the registry must refuse to hand it over.
    ctx.llm.registerAdapter(['claude_pool'], new StubAdapter())

    await ctx.settings.update(NS, {
      providers: {
        deepseek_pool: poolConfig(['sk-a']),
        claude_pool: poolConfig(['sk-claude']),
      },
    })

    // The conflicting swap was refused whole: the previous route set still
    // owns deepseek_pool, and claude_pool still belongs to its original
    // adapter.
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['claude_pool', 'deepseek_pool'])
    // Reverting to the working configuration re-applies.
    await ctx.settings.replace(NS, {})
    expect(ctx.llm.listProviders().map(provider => provider.id).sort()).toEqual(['claude_pool', 'deepseek_pool'])
  })

  it('ignores a settings document that merely reorders its provider keys', async () => {
    const dir = await home()
    const ctx = await boot(dir, {
      providers: { deepseek_pool: poolConfig(['sk-a']), qwen_pool: poolConfig(['sk-q']) },
    })
    const before = ctx.llm.listProviders().map(provider => provider.id)

    // Same routes, different YAML key order: nothing about the registration
    // changed, so no swap should happen at all.
    await ctx.settings.update(NS, {
      providers: { qwen_pool: poolConfig(['sk-q']), deepseek_pool: poolConfig(['sk-a']) },
    })
    expect(ctx.llm.listProviders().map(provider => provider.id)).toEqual(before)
  })

  it('keeps serving the previous routes when a displayName edit is refused', async () => {
    const dir = await home()
    const ctx = await boot(dir, { providers: { deepseek_pool: poolConfig(['sk-a']) } })
    const before = ctx.llm.listProviders()

    // An empty displayName passes the section validator (keys/baseURL are
    // intact) but violates the adapter-name and directory invariants, so
    // both registry swaps are refused and the prior registration survives.
    await ctx.settings.update(NS, {
      providers: {
        deepseek_pool: { displayName: '', baseURL: 'https://api.deepseek.com', models: { 'deepseek-v4-flash': { keys: ['sk-a'] } } },
      },
    })
    expect(ctx.llm.listProviders()).toEqual(before)
    const directory = ctx.llm.listConfigurableProviders()
    expect(directory).toHaveLength(1)
    expect(directory[0]).toMatchObject({ provider: 'deepseek_pool' })
    expect(directory[0]?.displayName).toBe('deepseek_pool')
  })
})
