import type { Context } from '@deepseek-ai/cordis'
export const inject = ['agentContext']
export const manifest = {
  $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v1.schema.json',
  schemaVersion: 1,
  id: 'agent-context-combination',
  name: 'Context integration',
  capabilities: [{
    name: 'agent.events.read',
    required: false,
    reason: { key: 'context', fallback: 'Context' },
    scope: { sessionIds: ['owned'] },
  }],
}
export function apply(ctx: Context) {
  void ctx.agentContext.read('owned').then(result => {
    document.documentElement.dataset.contextRead = JSON.stringify(result)
  })
}
