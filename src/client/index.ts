/**
 * KeyBal 池设置页（浏览器侧）。
 *
 * 注册到设置面板的 `settings.section` 槽位：一个 KeyBal 池状态页。页面只
 * 展示 host 配置的 provider/model 池状态与每个池的负载均衡策略，策略调整
 * 经 settings wire 写回 `llm-keybal` 命名空间。API keys 声明为 secret 角色，
 * 永不跨 wire 传输：页面只从描述符的 `secrets` 侧表得知某个池已配置多少个
 * key，追加 key 请用 host 命令 `/keybal-add-key <provider> <model> <key>`。
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: pulls the slot registry's Context merge (ctx.slots) into this program.
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { KeyBalSection } from './KeyBalSection.tsx'

/** 本插件的 client 条目名（也用作 slot 注册条目名）。 */
export const name = 'dsh-llm-keybal'

/** 需要槽位注册表与 settings wire（ctx.get('connection')）。 */
export const inject = ['slots', 'connection']

/**
 * Client plugin body：在设置面板挂载 KeyBal 池页。
 * `slots.inject` 等待 ui-settings 声明 `settings.section` 后再注册，声明消失时
 * 自动卸载。
 */
export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.slots.inject('settings.section', () => ctx.slots.register(
    {
      name: 'settings.section',
      id: 'llm-keybal',
      order: 12,
      label: () => 'KeyBal 池',
      inject: () => ({ api: connection.api }),
    },
    KeyBalSection,
  ))
}
