import Schema from '@deepseek-ai/schemastery'
import type { Context } from '@deepseek-ai/cordis'

export const Config = Schema.object({
  timeout: Schema.number().default(30).min(1).max(120).role('duration').description('Live timeout'),
  apiKey: Schema.string().role('secret').description('Host credential'),
})

export const configApplies = 'live'
export const inject = ['settings', 'configRenderers']

interface FixtureState {
  liveApply: number
  liveDispose: number
  liveValues: number[]
  rendererMount: number
  rendererDispose: number
  rendererAbort: number
}

function state(): FixtureState {
  const target = globalThis as typeof globalThis & { __cordisxConfigFixture?: FixtureState }
  return target.__cordisxConfigFixture ??= {
    liveApply: 0,
    liveDispose: 0,
    liveValues: [],
    rendererMount: 0,
    rendererDispose: 0,
    rendererAbort: 0,
  }
}

export function apply(ctx: Context, config: { timeout: number }): void {
  const fixture = state()
  fixture.liveApply += 1
  fixture.liveValues.push(config.timeout)
  ctx.settings.watch<{ timeout: number }>(value => fixture.liveValues.push(value.timeout))
  ctx.configRenderers.register({ id: 'duration', selector: { role: 'duration' } }, (container, field) => {
    fixture.rendererMount += 1
    const input = container.ownerDocument.createElement('input')
    input.type = 'range'
    input.value = String(field.value)
    input.addEventListener('input', () => field.setDraft(Number(input.value)))
    container.append(input)
    field.signal.addEventListener('abort', () => { fixture.rendererAbort += 1 }, { once: true })
    return () => {
      fixture.rendererDispose += 1
      input.remove()
    }
  })
  ctx.effect(() => () => { fixture.liveDispose += 1 }, 'live config fixture cleanup')
}
