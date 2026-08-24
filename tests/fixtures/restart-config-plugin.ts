import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

export const Config = Schema.object({
  label: Schema.string().default('good')
    .extra('extra', { label: { 'zh-CN': '显示名称', en: 'Display name' } })
    .description('Restart label'),
})

export const configApplies = 'plugin-restart'

interface FixtureState {
  restartApply: string[]
  restartDispose: number
  rollbackShouldFail: boolean
}

function state(): FixtureState {
  const target = globalThis as typeof globalThis & { __cordisxRestartConfigFixture?: FixtureState }
  return target.__cordisxRestartConfigFixture ??= { restartApply: [], restartDispose: 0, rollbackShouldFail: false }
}

export function apply(ctx: Context, config: { label: string }): void {
  const fixture = state()
  fixture.restartApply.push(config.label)
  if (config.label === 'fail-rollback') {
    fixture.rollbackShouldFail = true
    throw new Error('candidate and rollback rejected by plugin')
  }
  if (fixture.rollbackShouldFail) throw new Error('last-good rollback rejected by plugin')
  if (config.label === 'fail') throw new Error('candidate rejected by plugin')
  ctx.effect(() => () => { fixture.restartDispose += 1 }, 'restart config fixture cleanup')
}
