/**
 * Config validation tests.
 */

import { describe, expect, it } from 'vitest'
import { assertServiceable, Config, resolveConfig, type KeyBalStrategy, type Config as KeyBalConfig } from '../src/config.ts'

const strategy: KeyBalStrategy = 'round-robin'

const validConfig: KeyBalConfig = {
  strategy,
  maxRetries: 2,
  cooldownMs: 30000,
  providers: {
    deepseek_pool: {
      baseURL: 'https://api.deepseek.com',
      models: {
        'deepseek-v4-flash': { keys: ['sk-a', 'sk-b'] },
      },
    },
  },
}

describe('Config schema', () => {
  it('accepts a multi-provider config with key pools', () => {
    const parsed = Config(validConfig)
    expect(parsed.providers.deepseek_pool?.models?.['deepseek-v4-flash']?.keys).toHaveLength(2)
    expect(parsed.strategy).toBe('round-robin')
  })
  it('applies defaults for omitted global fields', () => {
    const parsed = Config({ providers: {} })
    expect(parsed.strategy).toBe('round-robin')
    expect(parsed.maxRetries).toBe(2)
    expect(parsed.cooldownMs).toBe(30000)
  })

  it('rejects a missing baseURL', () => {
    const bad = {
      providers: { bad_pool: { models: {} } },
    } as unknown as KeyBalConfig
    expect(() => Config(bad)).toThrow()
  })
})

describe('assertServiceable', () => {
  it('passes a serviceable config', () => {
    expect(() => {
      assertServiceable(Config(validConfig))
    }).not.toThrow()
  })

  it('rejects an empty key pool', () => {
    const bad = {
      strategy,
      maxRetries: 2,
      cooldownMs: 30000,
      providers: {
        deepseek_pool: {
          baseURL: 'https://api.deepseek.com',
          models: { 'deepseek-v4-flash': { keys: [] } },
        },
      },
    } as unknown as KeyBalConfig
    expect(() => {
      assertServiceable(Config(bad))
    }).toThrow(/no keys/)
  })

  it('rejects an empty baseURL', () => {
    const bad = {
      strategy,
      maxRetries: 2,
      cooldownMs: 30000,
      providers: { deepseek_pool: { baseURL: '', models: { m: { keys: ['k'] } } } },
    } as unknown as KeyBalConfig
    expect(() => {
      assertServiceable(Config(bad))
    }).toThrow(/baseURL/)
  })

  it('rejects a provider with no models', () => {
    const bad = {
      strategy,
      maxRetries: 2,
      cooldownMs: 30000,
      providers: { deepseek_pool: { baseURL: 'https://api.deepseek.com', models: {} } },
    } as unknown as KeyBalConfig
    expect(() => {
      assertServiceable(Config(bad))
    }).toThrow(/has no models/)
  })
})

describe('resolveConfig', () => {
  it('fills every global default when a snapshot omits them', () => {
    const resolved = resolveConfig({ providers: {} })
    expect(resolved).toMatchObject({ strategy: 'round-robin', maxRetries: 2, cooldownMs: 30000 })
  })
})
