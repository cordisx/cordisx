import type { Context } from '@deepseek-ai/cordis'
import type { CordisXOwnerDocumentsV1 } from '../../packages/cli/src/contracts.js'

declare global {
  interface Window { __cordisxOwnerDocumentsFixture?: { readonly client: CordisXOwnerDocumentsV1 } }
}

export const inject = ['documents']

export function apply(ctx: Context): () => void {
  window.__cordisxOwnerDocumentsFixture = { client: ctx.documents }
  return ctx.effect(() => () => { delete window.__cordisxOwnerDocumentsFixture }, 'owner documents fixture')
}
