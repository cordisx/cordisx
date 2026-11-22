import type { Context } from '@deepseek-ai/cordis'

export const inject = ['commands', 'platform']
export function apply(ctx: Context): void {
  ctx.commands.register({ id: 'probe', title: 'Permission probe' }, async () => await ctx.platform.models.list({}))
}
