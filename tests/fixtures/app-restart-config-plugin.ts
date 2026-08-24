import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

export const Config = Schema.object({
  label: Schema.string().default('active').description('Application restart label'),
})

export const configApplies = 'app-restart'
export const inject = ['settings']

interface FixtureState {
  applyValues: string[]
  watchedValues: string[]
}

function state(): FixtureState {
  const target = globalThis as typeof globalThis & { __cordisxAppRestartConfigFixture?: FixtureState }
  return target.__cordisxAppRestartConfigFixture ??= { applyValues: [], watchedValues: [] }
}

export function apply(ctx: Context, config: { label: string }): void {
  const fixture = state()
  fixture.applyValues.push(config.label)
  ctx.settings.watch<{ label: string }>(value => fixture.watchedValues.push(value.label))
}
