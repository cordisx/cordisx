import type { Context } from '@deepseek-ai/cordis'

interface State { apply: number; dispose: number }
function state(): State {
  const value = globalThis as typeof globalThis & { __cordisxGenerationUnrelated?: State }
  return value.__cordisxGenerationUnrelated ??= { apply: 0, dispose: 0 }
}

export function apply(ctx: Context): void {
  const value = state()
  value.apply += 1
  ctx.effect(() => () => { value.dispose += 1 }, 'generation unrelated fixture cleanup')
}
