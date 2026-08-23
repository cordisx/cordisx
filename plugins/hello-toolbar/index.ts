import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../src/contracts.js'

export const name = 'hello-toolbar'
export const inject = ['i18n', 'commands', 'slots']

interface Messages {
  action: undefined
  command: undefined
}

/** Minimal structured plugin: the host owns the toolbar DOM and invokes one command. */
export function apply(ctx: Context): void {
  ctx.i18n.define<Messages>({
    namespace: 'hello',
    locale: 'en',
    default: true,
    messages: { action: 'Hello from CordisX', command: 'Show hello notification' },
  })
  const text = (key: keyof Messages) => ({ namespace: 'hello', key })
  ctx.commands.register({ id: 'hello', title: text('command') }, () => {
    console.info('[cordisx] hello-toolbar command invoked')
  })
  ctx.slots.inject('workspace.toolbar.items', () => ctx.slots.register({
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
