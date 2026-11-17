import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  captureNativeBudgetProvenance,
  deriveNativeBudgetProvenance,
  type NativeStaticCatalogReceipt,
  type NativeThreadBudgetReceipt,
} from '../packages/cli/src/launcher/native-context-budget-provenance.js'

function startup(models: unknown[] = [{
  slug: 'actual-model',
  context_window: 200_000,
  max_context_window: 300_000,
  auto_compact_token_limit: 150_000,
  effective_context_window_percent: 95,
  model_messages: { instructions_template: 'private instructions' },
}]): NativeStaticCatalogReceipt {
  const catalogBytes = Buffer.from(JSON.stringify({ models }))
  return {
    nativeVersion: '0.167.0-alpha.3.2',
    serverId: 'server-1',
    providerKind: 'openai-compatible',
    providerId: 'openai',
    catalogBytes,
    catalogSha256: createHash('sha256').update(catalogBytes).digest('hex'),
  }
}

const thread: NativeThreadBudgetReceipt = {
  serverId: 'server-1',
  requestId: 'request-1',
  originator: 'host-client',
  responseRequestId: 'request-1',
  sessionId: 'thread-1',
  requestedModel: 'actual-model',
  responseModel: 'actual-model',
  responseProviderId: 'openai',
  modelContextWindow: 220_000,
  modelAutoCompactLimit: 120_000,
  scope: 'total',
  asyncCompaction: false,
  postTurnCompactPercent: 0,
  fallbackBufferTokens: 0,
}

describe('native budget provenance', () => {
  it('binds the submitted overrides and exact response to the startup catalog without copying prompts', () => {
    const result = captureNativeBudgetProvenance(startup(), thread)
    expect(result).toEqual({
      status: 'verified',
      binding: {
        serverId: 'server-1',
        requestId: 'request-1',
        originator: 'host-client',
        catalogSha256: startup().catalogSha256,
      },
      evidence: {
        nativeVersion: '0.167.0-alpha.3.2',
        sessionId: 'thread-1',
        model: 'actual-model',
        metadata: {
          model: 'actual-model',
          contextWindow: 200_000,
          maxContextWindow: 300_000,
          autoCompactLimit: 150_000,
          effectiveContextPercent: 95,
        },
        configuration: {
          sessionId: 'thread-1',
          modelContextWindow: 220_000,
          modelAutoCompactLimit: 120_000,
          scope: 'total',
          asyncCompaction: false,
          postTurnCompactPercent: 0,
          fallbackBufferTokens: 0,
        },
      },
    })
    expect(JSON.stringify(result)).not.toContain('private instructions')
  })

  it('uses the native catalog percent default only when absent', () => {
    const result = captureNativeBudgetProvenance(startup([{ slug: 'actual-model', context_window: 1000 }]), thread)
    expect(result.status === 'verified' && result.evidence.metadata.effectiveContextPercent).toBe(95)
    expect(
      captureNativeBudgetProvenance(
        startup([{ slug: 'actual-model', context_window: 1000, effective_context_window_percent: null }]),
        thread,
      ).status,
    ).toBe('unavailable')
  })

  it('rejects missing provenance, unknown buffer and mismatched identities or versions', () => {
    for (
      const [server, request] of [
        [null, thread],
        [startup(), null],
        [{ ...startup(), nativeVersion: '0.149.1' }, thread],
        [{ ...startup(), serverId: 'other' }, thread],
        [{ ...startup(), providerId: 'other' }, thread],
        [startup(), { ...thread, responseProviderId: 'other' }],
        [startup(), { ...thread, originator: '' }],
        [startup(), { ...thread, responseRequestId: 'other' }],
        [startup(), { ...thread, sessionId: '' }],
        [startup(), { ...thread, responseModel: 'other' }],
        [startup(), { ...thread, fallbackBufferTokens: null }],
        [{ ...startup(), catalogSha256: '0'.repeat(64) }, thread],
      ] as const
    ) expect(captureNativeBudgetProvenance(server, request)).toEqual({ status: 'unavailable', reason: 'unknown' })
  })

  it('rejects missing or ambiguous metadata and invalid numeric values', () => {
    for (
      const models of [[], [{ slug: 'other' }], [{ slug: 'actual-model' }, { slug: 'actual-model' }], [{
        slug: 'actual-model',
        context_window: -1,
      }], [{ slug: 'actual-model', effective_context_window_percent: 101 }]]
    ) {
      expect(captureNativeBudgetProvenance(startup(models), thread).status).toBe('unavailable')
    }
  })
})

describe('deriving fresh-thread configuration', () => {
  const receipt = {
    serverId: 'server-1',
    requestId: 'request-1',
    responseRequestId: 'request-1',
    originator: 'host-client',
    sessionId: 'thread-1',
    requestedModel: 'actual-model',
    responseModel: 'actual-model',
    responseProviderId: 'openai',
    mergedConfig: {},
    featureRequirements: null,
  }
  const modelDefaults = {
    enabled: false,
    reminder_threshold_tokens: 2000,
    reminder_message_template: 'remaining',
    guidance_message: 'guidance',
    auto_compact_fallback_prompt: 'note',
    auto_compact_fallback_buffer_tokens: 16384,
  }
  const catalog = (budget: unknown) =>
    startup([{
      slug: 'actual-model',
      context_window: 200000,
      model_messages: { token_budget: budget },
    }])

  it('derives ordinary native defaults and preserves explicit thread overrides', () => {
    const result = deriveNativeBudgetProvenance(catalog(modelDefaults), {
      ...receipt,
      mergedConfig: { model_context_window: 100000, model_auto_compact_token_limit: 75000 },
    })
    expect(result.status).toBe('verified')
    if (result.status !== 'verified') return
    expect(result.evidence.configuration).toEqual({
      sessionId: 'thread-1',
      modelContextWindow: 100000,
      modelAutoCompactLimit: 75000,
      scope: 'total',
      asyncCompaction: false,
      postTurnCompactPercent: 0,
      fallbackBufferTokens: 0,
    })
  })

  it('derives activated model fallback and explicit fallback overrides', () => {
    const activated = deriveNativeBudgetProvenance(catalog({ ...modelDefaults, enabled: true }), receipt)
    expect(activated.status === 'verified' && activated.evidence.configuration.fallbackBufferTokens).toBe(16384)
    const explicit = deriveNativeBudgetProvenance(catalog(modelDefaults), {
      ...receipt,
      mergedConfig: {
        features: {
          token_budget: {
            enabled: true,
            auto_compact_fallback_prompt: 'custom',
            auto_compact_fallback_buffer_tokens: 3000,
          },
        },
      },
    })
    expect(explicit.status === 'verified' && explicit.evidence.configuration.fallbackBufferTokens).toBe(3000)
    const enabled = deriveNativeBudgetProvenance(catalog(modelDefaults), {
      ...receipt,
      mergedConfig: { features: { token_budget: true, async_compaction: true } },
    })
    expect(enabled.status === 'verified' && enabled.evidence.configuration).toMatchObject({
      fallbackBufferTokens: 16384,
      asyncCompaction: false,
    })
  })

  it('refuses unresolved managed requirements and experimental activation', () => {
    for (
      const value of [
        { ...receipt, featureRequirements: undefined },
        { ...receipt, featureRequirements: { token_budget: true } },
        { ...receipt, mergedConfig: { model_auto_compact_token_limit_scope: 'invalid' } },
        { ...receipt, mergedConfig: { features: { context_management: true } } },
        {
          ...receipt,
          mergedConfig: { features: { token_budget: { enabled: true, auto_compact_fallback_prompt: 'custom' } } },
        },
      ]
    ) expect(deriveNativeBudgetProvenance(catalog(modelDefaults), value).status).toBe('unavailable')
  })
})
