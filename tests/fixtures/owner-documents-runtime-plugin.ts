import type { Context } from '@deepseek-ai/cordis'
import type { AgentTasks, CordisXOwnerDocumentsV1 } from '../../packages/cli/src/contracts.js'

declare global {
  interface Window {
    __cordisxOwnerDocumentsFixture?: { readonly client: CordisXOwnerDocumentsV1; readonly agentTasks?: AgentTasks }
  }
}

export const inject = ['documents', 'agentTasks']

export function apply(ctx: Context): () => void {
  window.__cordisxOwnerDocumentsFixture = {
    client: ctx.documents,
    ...(ctx.agentTasks === undefined ? {} : { agentTasks: ctx.agentTasks }),
  }
  return ctx.effect(() => () => {
    delete window.__cordisxOwnerDocumentsFixture
  }, 'owner documents fixture')
}
