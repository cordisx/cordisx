import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { CordisXLocalizedText, CordisXPluginPresentation } from '../../../packages/cli/src/contracts.js'

export const name = 'hello-toolbar'
export const inject = ['i18n', 'commands', 'slots']
export const Config = Schema.object({})
export const configApplies = 'plugin-restart'

interface Messages {
  action: undefined
  command: undefined
  'plugin.name': undefined
  'plugin.description': undefined
}

const text = (key: keyof Messages): CordisXLocalizedText => ({ namespace: 'hello', key })

export const presentation = {
  name: text('plugin.name'),
  description: text('plugin.description'),
} satisfies CordisXPluginPresentation

/** Minimal structured plugin: the host owns the toolbar DOM and invokes one command. */
export function apply(ctx: Context): void {
  ctx.i18n.define<Messages>({
    namespace: 'hello',
    locale: 'en',
    default: true,
    messages: {
      action: 'Hello from CordisX',
      command: 'Show hello notification',
      'plugin.name': 'Hello Toolbar',
      'plugin.description': 'Provides a simple greeting action in the workspace toolbar.',
    },
  })
  ctx.i18n.define<Messages>({
    namespace: 'hello',
    locale: 'zh-CN',
    messages: {
      action: '来自 CordisX 的问候',
      command: '显示问候通知',
      'plugin.name': '工具栏问候',
      'plugin.description': '在工作区工具栏提供一个简单的问候操作。',
    },
  })
  ctx.commands.register({ id: 'hello', title: text('command') }, () => {
    console.info('[cordisx] hello-toolbar command invoked')
  })
  ctx.slots.inject('workspace.toolbar.items', () =>
    ctx.slots.register({
      name: 'workspace.toolbar.items',
      id: 'hello',
      order: 100,
    }, {
      anchor: 'workspace.primary',
      placement: 'menu',
      label: text('action'),
      icon: 'host:info',
      command: { id: 'hello' },
    }))
}
