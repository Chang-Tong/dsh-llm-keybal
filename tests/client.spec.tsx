// @vitest-environment jsdom
/**
 * Client 侧测试：KeyBal 池设置页的纯函数与组件渲染。
 *
 * 数据全部来自构造的 redacted `SettingsNamespaceView`（与真实 wire 同形）：
 * keys 字段永不出现在 value 里，只通过 `secrets` 侧表给出"已配置几个 key"。
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createRoot, type Root } from 'react-dom/client'
import { act } from 'react'
import {
  KeyBalSection,
  keyCountOf,
  keybalView,
  modelRowsOf,
  strategyOf,
  type KeyBalSectionInjected,
} from '../src/client/KeyBalSection.tsx'

// React 19: act() only flushes when this global is set in the test env.
beforeAll(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
})

/** Flush settled promises and React work inside one act scope. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

/** 一个与 wire 描述符同形的 redacted 视图（keys 只存在于 secrets 侧表）。 */
function makeView(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ns: 'llm-keybal',
    schema: {},
    applies: 'live',
    revision: 3,
    value: {
      strategy: 'round-robin',
      maxRetries: 2,
      cooldownMs: 30000,
      providers: {
        deepseek_pool: {
          displayName: 'DeepSeek Pool',
          baseURL: 'https://api.deepseek.com',
          models: {
            'deepseek-v4-flash': {
              name: 'deepseek-v4-flash',
              strategy: 'health',
              maxRetries: 2,
              cooldownMs: 30000,
            },
            'deepseek-v4': {
              name: 'deepseek-v4',
              strategy: 'round-robin',
              maxRetries: 2,
              cooldownMs: 30000,
            },
          },
        },
        empty_pool: {
          displayName: 'Empty Pool',
          baseURL: 'https://api.example.com',
          models: {},
        },
      },
    },
    secrets: [
      { path: ['providers', 'deepseek_pool', 'models', 'deepseek-v4-flash', 'keys'], set: true },
      { path: ['providers', 'deepseek_pool', 'models', 'deepseek-v4-flash', 'keys'], set: true },
      { path: ['providers', 'deepseek_pool', 'models', 'deepseek-v4-flash', 'keys'], set: true },
      { path: ['providers', 'deepseek_pool', 'models', 'deepseek-v4', 'keys'], set: true },
    ],
    ...over,
  }
}

/** describe 响应的 wire 包装。 */
function describeResponse(view: Record<string, unknown> | undefined): { result: { ok: true; value: { writable: true; hasDocument: true; namespaces: Record<string, unknown>[] } } } {
  return {
    result: {
      ok: true,
      value: {
        writable: true,
        hasDocument: true,
        namespaces: view === undefined ? [] : [view],
      },
    },
  }
}

/** 一个最小 settings wire 面。 */
function settingsFace(over: Partial<Record<'describe' | 'update', unknown>> = {}): KeyBalSectionInjected['api']['settings'] {
  return {
    describe: over.describe ?? vi.fn().mockResolvedValue(describeResponse(makeView())),
    update: over.update ?? vi.fn().mockResolvedValue({ result: { ok: true, value: makeView() } }),
  } as unknown as KeyBalSectionInjected['api']['settings']
}

describe('keyCountOf', () => {
  it('counts set secret entries under the pool keys path', () => {
    const view = makeView() as never
    expect(keyCountOf(view, 'deepseek_pool', 'deepseek-v4-flash')).toBe(3)
    expect(keyCountOf(view, 'deepseek_pool', 'deepseek-v4')).toBe(1)
  })

  it('counts 0 for pools without secrets and for undefined views', () => {
    const view = makeView() as never
    expect(keyCountOf(view, 'empty_pool', 'missing')).toBe(0)
    expect(keyCountOf(undefined, 'deepseek_pool', 'deepseek-v4-flash')).toBe(0)
  })

  it('ignores unset secret entries', () => {
    const view = makeView({ secrets: [{ path: ['providers', 'p', 'models', 'm', 'keys'], set: false }] }) as never
    expect(keyCountOf(view, 'p', 'm')).toBe(0)
  })

  it('ignores paths with a different shape', () => {
    const view = makeView({ secrets: [{ path: ['providers', 'p', 'models', 'm', 'keys', 'extra'], set: true }] }) as never
    expect(keyCountOf(view, 'p', 'm')).toBe(0)
  })
})

describe('strategyOf', () => {
  it('reads the stored strategy when valid', () => {
    expect(strategyOf(makeView() as never, 'deepseek_pool', 'deepseek-v4-flash')).toBe('health')
  })

  it('falls back to round-robin for missing or unknown strategies', () => {
    expect(strategyOf(makeView() as never, 'deepseek_pool', 'deepseek-v4')).toBe('round-robin')
    const bogus = makeView({
      value: { providers: { p: { models: { m: { strategy: 'bogus' } } } } },
    }) as never
    expect(strategyOf(bogus, 'p', 'm')).toBe('round-robin')
    expect(strategyOf(undefined, 'p', 'm')).toBe('round-robin')
  })
})

describe('keybalView', () => {
  it('finds the keybal namespace', () => {
    const namespaces = [makeView({ ns: 'llm-deepseek' }), makeView()] as never
    expect(keybalView(namespaces)?.ns).toBe('llm-keybal')
  })

  it('returns undefined when absent', () => {
    expect(keybalView([] as never)).toBeUndefined()
    expect(keybalView(undefined)).toBeUndefined()
  })
})

describe('modelRowsOf', () => {
  it('builds one row per model with key counts and strategies', () => {
    const rows = modelRowsOf(makeView() as never)
    expect(rows).toHaveLength(2)
    const flash = rows.find((row) => row.model === 'deepseek-v4-flash')
    expect(flash).toMatchObject({ provider: 'deepseek_pool', keys: 3, strategy: 'health' })
    const v4 = rows.find((row) => row.model === 'deepseek-v4')
    expect(v4).toMatchObject({ provider: 'deepseek_pool', keys: 1, strategy: 'round-robin' })
  })

  it('returns [] for empty or undefined views', () => {
    expect(modelRowsOf(undefined)).toEqual([])
    expect(modelRowsOf(makeView({ value: { providers: {} } }) as never)).toEqual([])
  })

  it('falls back to the model id for the display name', () => {
    const rows = modelRowsOf(makeView({
      value: { providers: { p: { models: { 'm-1': { name: 'My Model' }, 'm-2': {} } } } },
    }) as never)
    expect(rows.find((row) => row.model === 'm-1')?.displayName).toBe('My Model')
    expect(rows.find((row) => row.model === 'm-2')?.displayName).toBe('m-2')
  })
})

describe('KeyBalSection', () => {
  let host: HTMLElement
  let root: Root
  afterEach(() => {
    act(() => { root.unmount() })
    host.remove()
  })

  function mount(api: KeyBalSectionInjected['api']): void {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
    act(() => { root.render(<KeyBalSection api={api} />) })
  }

  it('renders the add-key hint and an empty state without a keybal namespace', async () => {
    const api = {
      settings: settingsFace({ describe: vi.fn().mockResolvedValue(describeResponse(undefined)) }),
    } as KeyBalSectionInjected['api']
    mount(api)
    await flush()
    expect(host.textContent).toContain('/keybal-add-key')
    expect(host.textContent).toContain('No KeyBal pools configured')
  })

  it('renders provider cards with key counts and strategies', async () => {
    mount({ settings: settingsFace() } as KeyBalSectionInjected['api'])
    await flush()
    expect(host.textContent).toContain('deepseek_pool')
    expect(host.textContent).toContain('deepseek-v4-flash')
    expect(host.textContent).toContain('3 keys')
    expect(host.textContent).toContain('1 keys')
    expect(host.textContent).toContain('health')
  })

  it('shows a failure message when describe rejects', async () => {
    const api = {
      settings: settingsFace({ describe: vi.fn().mockRejectedValue(new Error('boom')) }),
    } as KeyBalSectionInjected['api']
    mount(api)
    await flush()
    expect(host.textContent).toContain('Save failed')
  })

  it('writes a strategy change through settings.update and refreshes the view', async () => {
    const update = vi.fn().mockResolvedValue({
      result: { ok: true, value: makeView({
        value: { providers: { deepseek_pool: { models: { 'deepseek-v4-flash': { name: 'deepseek-v4-flash', strategy: 'random' } } } } },
      }) },
    })
    mount({ settings: settingsFace({ update }) } as KeyBalSectionInjected['api'])
    await flush()
    const select = host.querySelector('select') as HTMLSelectElement
    expect(select).not.toBeNull()
    await act(async () => {
      select.value = 'random'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await flush()
    expect(update).toHaveBeenCalledTimes(1)
    const call = update.mock.calls[0]?.[0] as { ns: string; expectedRevision: number; patch: { providers: Record<string, { models: Record<string, { strategy: string }> }> } }
    expect(call.ns).toBe('llm-keybal')
    expect(call.expectedRevision).toBe(3)
    expect(call.patch.providers.deepseek_pool.models['deepseek-v4-flash']).toEqual({ strategy: 'random' })
    expect(host.textContent).toContain('Saved')
  })
})
