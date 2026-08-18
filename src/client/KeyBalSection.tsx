/**
 * KeyBal 池设置页组件。
 *
 * 纯展示 + 策略调整：数据经 inject 的 settings wire（`api.settings.describe`）
 * 读取，策略写回经 `api.settings.update`。API keys 是 secret 角色，wire 上
 * 永不返回明文——页面从描述符的 `secrets` 侧表统计每个池的 key 数量。
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import type { IApiClient, SettingsNamespaceView, SettingsSecretView } from '@deepseek-ai/dsh-client-connection/client'

/** KeyBal 设置命名空间。 */
export const KEYBAL_NS = 'llm-keybal'

/** 负载均衡策略（与 host 端 STRATEGIES 一致）。 */
export const STRATEGIES = ['round-robin', 'random', 'least-used', 'health'] as const
export type Strategy = (typeof STRATEGIES)[number]

/** Injected dependencies of {@link KeyBalSection}（slot `inject`）。 */
export interface KeyBalSectionInjected {
  /** Settings wire face（describe/update）。 */
  api: Pick<IApiClient, 'settings'>
}

/** 一个池的 key 数量：从 secrets 侧表统计 `keys` 槽的 set=true 条目。 */
export function keyCountOf(view: SettingsNamespaceView | undefined, provider: string, model: string): number {
  if (view === undefined) return 0
  const prefix = ['providers', provider, 'models', model, 'keys']
  let count = 0
  for (const secret of view.secrets ?? []) {
    if (secret.path.length === prefix.length
      && secret.path.every((segment, index) => segment === prefix[index])) {
      if (secret.set) count += 1
    }
  }
  return count
}

/** 提取一个 model 的策略（redacted value 中非 secret 字段）。 */
export function strategyOf(view: SettingsNamespaceView | undefined, provider: string, model: string): Strategy {
  const providers = (view?.value as { providers?: Record<string, { models?: Record<string, { strategy?: string }> }> } | undefined)?.providers
  const strategy = providers?.[provider]?.models?.[model]?.strategy
  return STRATEGIES.includes(strategy as Strategy) ? strategy as Strategy : 'round-robin'
}

/** 解析 describe 返回里的 KeyBal 命名空间视图。 */
export function keybalView(namespaces: SettingsNamespaceView[] | undefined): SettingsNamespaceView | undefined {
  return namespaces?.find((entry) => entry.ns === KEYBAL_NS)
}

/** 一个 model 行。 */
interface ModelRow {
  provider: string
  model: string
  displayName: string
  strategy: Strategy
  keys: number
}

/** 从命名空间视图构建 model 行。 */
export function modelRowsOf(view: SettingsNamespaceView | undefined): ModelRow[] {
  const providers = (view?.value as { providers?: Record<string, { displayName?: string; models?: Record<string, { name?: string }> }> } | undefined)?.providers
  if (providers === undefined) return []
  const rows: ModelRow[] = []
  for (const [provider, profile] of Object.entries(providers)) {
    const models = profile?.models ?? {}
    for (const [model, entry] of Object.entries(models)) {
      rows.push({
        provider,
        model,
        displayName: entry?.name ?? model,
        strategy: strategyOf(view, provider, model),
        keys: keyCountOf(view, provider, model),
      })
    }
  }
  return rows
}

/** 内联样式：复用 dsh 全局 CSS 变量，失败回退字面值。 */
const styles = {
  wrap: {
    display: 'flex',
    flexDirection: 'column',
    gap: '10px',
    padding: '4px 0',
  } as const,
  hint: {
    fontSize: '12px',
    color: 'var(--dsw-text-secondary, #666)',
    lineHeight: '1.5',
  } as const,
  card: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    border: '1px solid var(--dsw-border-subtle, #e0e0e0)',
    borderRadius: '8px',
    padding: '10px 12px',
  } as const,
  provider: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    fontSize: '13px',
    fontWeight: 600,
  } as const,
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
    fontSize: '12px',
    color: 'var(--dsw-text-primary, #222)',
  } as const,
  modelName: {
    flex: '1',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  keys: {
    color: 'var(--dsw-text-secondary, #666)',
  } as const,
  select: {
    fontSize: '12px',
    padding: '2px 4px',
    border: '1px solid var(--dsw-border-subtle, #c8c8c8)',
    borderRadius: '4px',
    background: 'var(--dsw-surface-subtle, #fff)',
    color: 'var(--dsw-text-primary, #222)',
  } as const,
  message: {
    fontSize: '12px',
  } as const,
  ok: { color: 'var(--dsw-text-success, #2e7d32)' } as const,
  error: { color: 'var(--dsw-text-danger, #c62828)' } as const,
  code: {
    fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, monospace)',
    fontSize: '12px',
    background: 'var(--dsw-surface-subtle, #f2f2f2)',
    borderRadius: '4px',
    padding: '1px 5px',
  } as const,
}

/** 文案（跟随浏览器语言）。 */
function copy() {
  const zh = typeof navigator !== 'undefined' && /^zh\b/u.test(navigator.language ?? '')
  return zh
    ? {
        title: 'KeyBal 池',
        empty: '尚未配置任何 KeyBal 池。在插件配置（cordis.yml 的 providers）里声明，或用 /keybal-add-key 追加。',
        addHint: '追加 key：/keybal-add-key <provider> <model> <key>',
        strategyLabel: '策略',
        keysLabel: 'keys',
        saved: '已保存',
        failed: '保存失败',
        loaded: '已加载',
      }
    : {
        title: 'KeyBal pools',
        empty: 'No KeyBal pools configured. Declare providers in the plugin config (cordis.yml) or append with /keybal-add-key.',
        addHint: 'Append a key: /keybal-add-key <provider> <model> <key>',
        strategyLabel: 'Strategy',
        keysLabel: 'keys',
        saved: 'Saved',
        failed: 'Save failed',
        loaded: 'Loaded',
      }
}

/**
 * KeyBal 池设置页。
 * @param props - inject 的 settings wire 面。
 */
export function KeyBalSection({ api }: Partial<KeyBalSectionInjected>): ReactElement {
  const [view, setView] = useState<SettingsNamespaceView | undefined>(undefined)
  const [unavailable, setUnavailable] = useState(false)
  const [revision, setRevision] = useState<number | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState<{ ok: boolean; text: string } | undefined>(undefined)
  const copyText = useMemo(() => copy(), [])
  const rows = useMemo(() => modelRowsOf(view), [view])

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await api?.settings.describe({})
      if (response === undefined || !response.result.ok) {
        setUnavailable(true)
        return
      }
      const found = keybalView(response.result.value.namespaces)
      setView(found)
      setRevision(found?.revision)
      setUnavailable(false)
      setMessage((current) => current === undefined ? { ok: true, text: copyText.loaded } : current)
    } catch {
      setUnavailable(true)
    }
  }, [api, copyText.loaded])

  useEffect(() => {
    void load()
  }, [load])

  const changeStrategy = async (provider: string, model: string, strategy: Strategy): Promise<void> => {
    if (api === undefined || revision === undefined) return
    setSaving(true)
    setMessage(undefined)
    try {
      const response = await api.settings.update({
        ns: KEYBAL_NS,
        expectedRevision: revision,
        patch: {
          providers: {
            [provider]: {
              models: {
                [model]: { strategy },
              },
            },
          },
        },
      })
      if (!response.result.ok) {
        setMessage({ ok: false, text: `${copyText.failed}: ${response.result.error.message}` })
        return
      }
      setView(response.result.value)
      setRevision(response.result.value.revision)
      setMessage({ ok: true, text: copyText.saved })
    } catch (error) {
      setMessage({ ok: false, text: `${copyText.failed}: ${error instanceof Error ? error.message : String(error)}` })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={styles.wrap}>
      <div style={styles.hint}>{copyText.addHint}</div>
      {unavailable && <div style={{ ...styles.message, ...styles.error }}>{copyText.failed}: describe</div>}
      {!unavailable && rows.length === 0 && <div style={styles.hint}>{copyText.empty}</div>}
      {rows.map((row) => (
        <div key={`${row.provider}/${row.model}`} style={styles.card}>
          <div style={styles.provider}>{row.provider}</div>
          <div style={styles.row}>
            <span style={styles.modelName} title={row.displayName}>{row.displayName}</span>
            <span style={styles.keys}>{row.keys} {copyText.keysLabel}</span>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: '4px' }}>
              {copyText.strategyLabel}
              <select
                style={styles.select}
                value={row.strategy}
                disabled={saving}
                onChange={(event) => void changeStrategy(row.provider, row.model, event.target.value as Strategy)}
              >
                {STRATEGIES.map((strategy) => <option key={strategy} value={strategy}>{strategy}</option>)}
              </select>
            </label>
          </div>
        </div>
      ))}
      {message !== undefined && (
        <div style={{ ...styles.message, ...(message.ok ? styles.ok : styles.error) }}>{message.text}</div>
      )}
    </div>
  )
}
