import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../../packages/cli/src/contracts.js'

export const name = 'Permission V2 Smoke'
export const inject = ['commands', 'agentEvents', 'platform']

/** Real-renderer probe: all authorization remains owned by the Host PermissionBroker. */
export function apply(ctx: Context): void {
  const title = { key: 'permission-v2-smoke.events', fallback: 'Probe Agent event access' }
  ctx.commands.register({ id: 'probe-agent-events', title }, async () => (
    await ctx.agentEvents.query({ sessionId: 'permission-smoke-session' })
  ))
  ctx.commands.register({
    id: 'probe-tasks',
    title: { key: 'permission-v2-smoke.tasks', fallback: 'Probe task catalog access' },
  }, async () => (
    await ctx.platform.tasks.list({ providerIds: ['codex'], limit: 1 })
  ))
}
