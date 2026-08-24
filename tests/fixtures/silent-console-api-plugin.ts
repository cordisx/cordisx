import type { Context } from '@deepseek-ai/cordis'
import type {} from '../../packages/cli/src/contracts.js'

export const name = 'Silent API Fixture'
export const inject = ['settings']

export function apply(ctx: Context): void {
  // Deliberately no console/logger call: the Host aspect must still emit the invocation.
  ctx.settings.get()
}
