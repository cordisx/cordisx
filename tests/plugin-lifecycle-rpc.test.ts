import { describe, expect, it } from 'vitest'
import { parsePluginLifecycleBindingRequest } from '../packages/cli/src/launcher/plugin-lifecycle-rpc.js'
import type { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'

const handler = {
  token: 'secret-token',
  profileId: 'work',
  generation: 'runtime-1',
  coordinator: {} as PluginLifecycleCoordinator,
}

function privatePlan(overrides: Record<string, unknown> = {}) {
  return {
    token: handler.token,
    privateRequest: {
      kind: 'permission-review-plan-v2',
      requestId: 'request-1',
      profileId: handler.profileId,
      runtimeGeneration: handler.generation,
      expectedRevision: 3,
      target: { kind: 'candidate', candidateId: 'plugin-candidate-1' },
      ...overrides,
    },
  }
}

describe('Host-private permission lifecycle binding', () => {
  it('projects only an authenticated exact candidate review request', () => {
    expect(parsePluginLifecycleBindingRequest(privatePlan(), handler)).toEqual({
      kind: 'permission-review-plan-v2',
      requestId: 'request-1',
      request: {
        requestId: 'request-1',
        profileId: 'work',
        runtimeGeneration: 'runtime-1',
        expectedRevision: 3,
        target: { kind: 'candidate', candidateId: 'plugin-candidate-1' },
      },
    })
  })

  it('rejects token/profile/generation confusion and extra private fields', () => {
    expect(() => parsePluginLifecycleBindingRequest({ ...privatePlan(), token: 'impostor' }, handler)).toThrow(/token mismatch/)
    expect(() => parsePluginLifecycleBindingRequest(privatePlan({ profileId: 'other' }), handler)).toThrow(/scope is stale/)
    expect(() => parsePluginLifecycleBindingRequest(privatePlan({ runtimeGeneration: 'runtime-old' }), handler)).toThrow(/scope is stale/)
    expect(() => parsePluginLifecycleBindingRequest(privatePlan({ pluginDecision: {} }), handler)).toThrow(/unsupported/)
  })

  it('rejects mixed public/private envelopes and forged target shapes', () => {
    expect(() => parsePluginLifecycleBindingRequest({ ...privatePlan(), request: {} }, handler)).toThrow(/exactly one/)
    expect(() => parsePluginLifecycleBindingRequest(privatePlan({
      target: { kind: 'candidate', candidateId: 'plugin-candidate-1', pluginId: 'other' },
    }), handler)).toThrow(/unsupported/)
  })
})
