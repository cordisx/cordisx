import { describe, expect, it, vi } from 'vitest'
import { inheritNativeFork } from '../packages/cli/assets/launcher/native-session-fork.mjs'

const source = { providerId: 'managed', model: 'source-model', reasoningEffort: 'high', serviceTier: 'priority' }
const request = { id: 4, method: 'thread/fork', params: { threadId: 'source' } }
function fixture(tuple: typeof source | undefined = source) {
  const calls: { type: string; value: Record<string, unknown> }[] = []
  const controlCall = vi.fn(async (type: string, value: Record<string, unknown>) => {
    calls.push({ type, value })
    if (type === 'source-configuration') return tuple
    if (type === 'fork-prepare') {
      return {
        kind: 'resume',
        resumeToken: 'exact-lease-token',
        configOverrides: { 'model_providers.managed': { wire_api: 'responses' } },
      }
    }
    if (type === 'fork-complete') return true
  })
  const nativeCall = vi.fn(async (_method: string, params: any) => ({
    thread: { id: 'child' },
    modelProvider: params.modelProvider,
    model: params.model,
    reasoningEffort: params.config.model_reasoning_effort,
    serviceTier: params.serviceTier,
  }))
  return { calls, controlCall, nativeCall }
}
describe('native fork source inheritance', () => {
  it('applies an exact tuple and binds only the returned child credential', async () => {
    const f = fixture()
    expect(await inheritNativeFork(request, f)).toMatchObject({ handled: true, result: { thread: { id: 'child' } } })
    expect(f.nativeCall).toHaveBeenCalledWith(
      'thread/fork',
      expect.objectContaining({
        threadId: 'source',
        modelProvider: 'managed',
        model: 'source-model',
        serviceTier: 'priority',
        config: expect.objectContaining({ model_reasoning_effort: 'high' }),
      }),
    )
    expect(f.calls.at(-1)).toEqual({
      type: 'fork-complete',
      value: {
        threadId: 'source',
        createdThreadId: 'child',
        resumeToken: 'exact-lease-token',
        succeeded: true,
      },
    })
  })
  it('preserves explicit choices and does not acquire managed credentials for openai', async () => {
    const f = fixture()
    const explicit = {
      ...request,
      params: {
        ...request.params,
        modelProvider: 'openai',
        model: 'override',
        serviceTier: null,
        config: { model_reasoning_effort: 'low' },
      },
    }
    expect(await inheritNativeFork(explicit, f)).toMatchObject({
      handled: true,
      result: { modelProvider: 'openai', model: 'override', reasoningEffort: 'low', serviceTier: null },
    })
    expect(f.calls.some(call => call.type === 'fork-prepare')).toBe(false)
  })
  it('leaves unknown or conflicting sources unmodified and releases a failed fork lease', async () => {
    const missing = fixture(undefined)
    missing.controlCall.mockResolvedValue(undefined)
    expect(await inheritNativeFork(request, missing)).toEqual({ handled: false })
    expect(missing.nativeCall).not.toHaveBeenCalled()
    const f = fixture()
    f.nativeCall.mockRejectedValue(new Error('unconfirmed'))
    expect(await inheritNativeFork(request, f)).toMatchObject({ handled: true, error: { code: -32000 } })
    expect(f.calls.at(-1)?.value).toMatchObject({ threadId: 'source', succeeded: false })
  })
})

it('rechecks the source and keeps native rejection details while retiring the lease', async () => {
  const changed = fixture()
  changed.controlCall.mockImplementation(async (type: string, value: Record<string, unknown>) => {
    changed.calls.push({ type, value })
    if (type === 'source-configuration') {
      return changed.calls.filter(call => call.type === type).length === 1 ? source : { ...source, model: 'later' }
    }
    if (type === 'fork-prepare') return { kind: 'resume', resumeToken: 'exact-lease-token', configOverrides: {} }
    if (type === 'fork-complete') return true
  })
  expect(await inheritNativeFork(request, changed)).toMatchObject({ handled: true, error: { code: -32000 } })
  expect(changed.nativeCall).not.toHaveBeenCalled()
  expect(changed.calls.at(-1)?.value).toMatchObject({ succeeded: false })
  const rejected = fixture()
  const nativeError = { code: -32600, message: 'native failure' }
  rejected.nativeCall.mockRejectedValue(Object.assign(new Error('native'), { nativeError }))
  expect(await inheritNativeFork(request, rejected)).toEqual({ handled: true, error: nativeError })
  expect(rejected.calls.at(-1)?.value).toMatchObject({ succeeded: false })
})

it('honors explicit config service tier without inventing precedence for unknown or conflicting values', async () => {
  const f = fixture()
  const configOnly = { ...request, params: { ...request.params, config: { service_tier: null } } }
  expect(await inheritNativeFork(configOnly, f)).toMatchObject({ handled: true, result: { serviceTier: null } })
  expect(f.nativeCall).toHaveBeenCalledWith(
    'thread/fork',
    expect.objectContaining({ serviceTier: null, config: expect.objectContaining({ service_tier: null }) }),
  )
  for (
    const params of [
      { ...request.params, serviceTier: 'priority', config: { service_tier: null } },
      { ...request.params, config: { service_tier: 'unrecognized-tier' } },
    ]
  ) {
    const other = fixture()
    expect(await inheritNativeFork({ ...request, params }, other)).toEqual({ handled: false })
    expect(other.nativeCall).not.toHaveBeenCalled()
  }
})
