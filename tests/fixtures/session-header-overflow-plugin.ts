import type { Context } from '@deepseek-ai/cordis'

export const name = 'session-header-overflow-fixture'
export const inject = ['commands', 'slots']

export function apply(ctx: Context): void {
  for (const [index, icon] of (['host:open', 'host:refresh', 'host:settings'] as const).entries()) {
    const id = `action-${index + 1}`
    const label = { namespace: 'session-header-overflow-fixture', key: id, fallback: `Overflow action ${index + 1}` }
    ctx.commands.register({ id, title: label }, () => undefined)
    ctx.slots.register({ name: 'session.header.actions', id, group: 'utility', order: 20 + index }, {
      label,
      ariaLabel: label,
      icon,
      command: { id },
    })
  }
}
