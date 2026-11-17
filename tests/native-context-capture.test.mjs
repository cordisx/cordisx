import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  finishNativeContextCapture,
  prepareNativeContextCapture,
} from '../packages/cli/assets/launcher/native-context-capture.mjs'
import { deriveNativeBudgetProvenance } from '../packages/cli/src/launcher/native-context-budget-provenance.ts'

function fixture() {
  const catalogBytes = Buffer.from(JSON.stringify({
    models: [{
      slug: 'chosen-model',
      context_window: 200000,
      max_context_window: 300000,
      auto_compact_token_limit: 150000,
      effective_context_window_percent: 95,
      model_messages: { token_budget: { enabled: false }, instructions_template: 'catalog private text' },
    }],
  }))
  const startup = {
    nativeVersion: '0.167.0-alpha.3.2',
    serverId: 'server',
    providerId: 'openai',
    providerKind: 'openai-compatible',
    catalogSha256: createHash('sha256').update(catalogBytes).digest('hex'),
    catalogBytes,
  }
  const preflight = {
    serverId: 'server',
    cwd: '/workspace',
    originator: 'client',
    featureRequirements: null,
    config: {
      model_provider: 'openai',
      model_context_window: null,
      model_auto_compact_token_limit: null,
      unrelated_credential: 'never return this',
      features: {},
    },
  }
  const request = {
    method: 'thread/start',
    id: 7,
    params: { model: 'chosen-model', cwd: '/workspace', config: { approval_policy: 'original selection' } },
  }
  return { startup, preflight, request }
}

function finish(input, prepared, changes = {}) {
  const submittedParams = {
    ...input.request.params,
    config: { ...input.request.params.config, ...prepared.configPatch },
  }
  const receipt = {
    serverId: 'server',
    requestId: 7,
    submittedParams,
    response: { id: 7, result: { thread: { id: 'session' }, model: 'chosen-model', modelProvider: 'openai' } },
    ...changes,
  }
  return finishNativeContextCapture(prepared.handle, receipt, deriveNativeBudgetProvenance)
}

describe('same-server native context capture', () => {
  it('freezes the equivalent original budget and returns only safe evidence', () => {
    const input = fixture()
    const prepared = prepareNativeContextCapture(input)
    expect(prepared.status).toBe('ready')
    expect(prepared.configPatch).toMatchObject({
      model_context_window: 200000,
      model_auto_compact_token_limit: 150000,
      model_auto_compact_token_limit_scope: 'total',
      'features.token_budget': false,
    })
    const result = finish(input, prepared)
    expect(result.status).toBe('verified')
    expect(result.evidence.configuration).toMatchObject({
      sessionId: 'session',
      modelContextWindow: 200000,
      modelAutoCompactLimit: 150000,
      scope: 'total',
      asyncCompaction: false,
      fallbackBufferTokens: 0,
    })
    expect(JSON.stringify({ prepared, result })).not.toMatch(
      /never return this|catalog private text|original selection/,
    )
    expect(finish(input, prepared).status).toBe('unavailable')
  })

  it('honors numeric thread overrides and native model max / compact caps', () => {
    const input = fixture()
    input.request.params.config.model_context_window = 400000
    input.request.params.config.model_auto_compact_token_limit = 290000
    const prepared = prepareNativeContextCapture(input)
    expect(prepared.configPatch).toMatchObject({ model_context_window: 300000, model_auto_compact_token_limit: 270000 })
    expect(finish(input, prepared).status).toBe('verified')
  })

  it('rejects incomplete, mismatched, conflicting and non-equivalent evidence', () => {
    const cases = [
      (x) => {
        x.preflight.serverId = 'other'
      },
      (x) => {
        x.preflight.cwd = '/other'
      },
      (x) => {
        x.preflight.featureRequirements = undefined
      },
      (x) => {
        x.preflight.featureRequirements = { token_budget: true }
      },
      (x) => {
        x.preflight.config.features.token_budget = true
      },
      (x) => {
        x.preflight.config.features.context_management = true
      },
      (x) => {
        x.preflight.config.model_auto_compact_token_limit_scope = 'body_after_prefix'
      },
      (x) => {
        x.request.params.config.model_context_window = null
      },
      (x) => {
        x.request.params.config['features.async_compaction'] = true
      },
      (x) => {
        x.request.params.config['model_context_window.unknown'] = 1
      },
      (x) => {
        x.request.params.config.model_provider = 'other'
      },
      (x) => {
        x.startup.catalogSha256 = '0'.repeat(64)
      },
      (x) => {
        x.startup.nativeVersion = '0.149.1'
      },
    ]
    for (const [index, mutate] of cases.entries()) {
      const input = fixture()
      mutate(input)
      expect(prepareNativeContextCapture(input).status, `case ${index}`).toBe('unavailable')
    }
  })

  it('rejects a changed submission, error response, changed model or server', () => {
    const variants = [
      { serverId: 'other' },
      { submittedParams: { model: 'chosen-model', cwd: '/workspace' } },
      { response: { id: 7, error: { code: -1 } } },
      { response: { id: 7, result: { thread: { id: 'session' }, model: 'other', modelProvider: 'openai' } } },
    ]
    for (const receipt of variants) {
      const input = fixture()
      expect(finish(input, prepareNativeContextCapture(input), receipt).status).toBe('unavailable')
    }
  })
})
