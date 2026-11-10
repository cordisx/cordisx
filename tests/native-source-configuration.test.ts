import { describe, expect, it } from 'vitest'
import { readNativeSourceConfiguration } from '../packages/cli/src/launcher/native-source-configuration.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

const scope = {
  targetId: 'target',
  rendererGeneration: 'generation',
  navigationGeneration: 1,
  composerId: 'composer',
  threadId: 'source',
}
const tuple = {
  providerId: 'provider',
  model: 'model',
  reasoningEffort: 'high' as const,
  serviceTier: 'priority' as const,
}

describe('source configuration authority', () => {
  it('uses only matching live scoped configuration and rejects ambiguous or changed values', async () => {
    const state = { scope, revision: 1, effective: { providerId: 'provider', model: 'model' } }
    const states = () => [state]
    const owner = {
      generation: 'generation',
      disposed: false,
      session: {
        isClosed: () => false,
        send: async () => ({ result: { value: { scope, sourceConfiguration: tuple } } }),
      } as unknown as CdpSession,
    }
    expect(await readNativeSourceConfiguration('source', states, () => owner)).toEqual(tuple)
    expect(await readNativeSourceConfiguration('other', states, () => owner)).toBeUndefined()
    expect(
      await readNativeSourceConfiguration(
        'source',
        states,
        () => owner,
        () => ({ providerId: 'provider', model: 'newer' }),
      ),
    ).toBeUndefined()
    const pending = { ...state, pending: { model: 'other' } }
    expect(await readNativeSourceConfiguration('source', () => [pending], () => owner)).toBeUndefined()
    const wrong = {
      ...owner,
      session: {
        isClosed: () => false,
        send: async () => ({ result: { value: { scope, sourceConfiguration: { ...tuple, model: 'other' } } } }),
      } as unknown as CdpSession,
    }
    expect(await readNativeSourceConfiguration('source', states, () => wrong)).toBeUndefined()
  })
})
