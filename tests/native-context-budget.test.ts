import { describe, expect, it } from 'vitest'
import {
  type NativeContextBudgetEvidence,
  resolveNativeContextBudget,
} from '../packages/cli/src/launcher/native-context-budget.js'

const evidence: NativeContextBudgetEvidence = {
  nativeVersion: '0.167.0-alpha.3.2',
  sessionId: 'source',
  model: 'model',
  metadata: {
    model: 'model',
    contextWindow: 100_000,
    maxContextWindow: 120_000,
    autoCompactLimit: 80_000,
    effectiveContextPercent: 95,
  },
  configuration: {
    sessionId: 'source',
    modelContextWindow: null,
    modelAutoCompactLimit: null,
    scope: 'total',
    asyncCompaction: false,
    postTurnCompactPercent: 0,
    fallbackBufferTokens: 0,
  },
}

describe('actual native compact budget', () => {
  it('distinguishes raw, usable and configured automatic compaction limits', () => {
    const budget = resolveNativeContextBudget(evidence)
    expect(budget).toEqual({ status: 'resolved', rawWindow: 100_000, usableWindow: 95_000, tokens: 80_000 })
    if (budget.status === 'resolved') expect(budget.tokens * 0.5).toBe(40_000)
  })
  it('applies exact model and per-thread overrides and caps them by the raw model rule', () => {
    expect(resolveNativeContextBudget({
      ...evidence,
      configuration: { ...evidence.configuration, modelContextWindow: 150_000, modelAutoCompactLimit: 110_000 },
    })).toEqual({ status: 'resolved', rawWindow: 120_000, usableWindow: 114_000, tokens: 108_000 })
    expect(resolveNativeContextBudget({
      ...evidence,
      metadata: { ...evidence.metadata, autoCompactLimit: null },
    })).toMatchObject({ status: 'resolved', tokens: 90_000 })
  })
  it('accounts for a verified fallback buffer and the usable hard cap', () => {
    expect(resolveNativeContextBudget({
      ...evidence,
      configuration: { ...evidence.configuration, fallbackBufferTokens: 5_000 },
    })).toMatchObject({ status: 'resolved', tokens: 85_000 })
    expect(resolveNativeContextBudget({
      ...evidence,
      metadata: { ...evidence.metadata, effectiveContextPercent: 70 },
    })).toMatchObject({ status: 'resolved', usableWindow: 70_000, tokens: 70_000 })
    expect(resolveNativeContextBudget({
      ...evidence,
      configuration: { ...evidence.configuration, fallbackBufferTokens: null },
    })).toEqual({ status: 'unavailable', reason: 'unknown' })
  })
  it('keeps mismatched, incomplete, non-total and alternate compaction inputs unavailable', () => {
    expect(resolveNativeContextBudget({ ...evidence, nativeVersion: 'unsupported' })).toMatchObject({
      status: 'unavailable',
    })
    expect(resolveNativeContextBudget({ ...evidence, model: 'different' })).toMatchObject({ status: 'unavailable' })
    expect(
      resolveNativeContextBudget({ ...evidence, configuration: { ...evidence.configuration, sessionId: 'other' } }),
    ).toMatchObject({ status: 'unavailable' })
    expect(
      resolveNativeContextBudget({
        ...evidence,
        configuration: { ...evidence.configuration, scope: 'body_after_prefix' },
      }),
    ).toEqual({ status: 'unavailable', reason: 'unsupported' })
    expect(
      resolveNativeContextBudget({ ...evidence, configuration: { ...evidence.configuration, asyncCompaction: true } }),
    ).toEqual({ status: 'unavailable', reason: 'unsupported' })
    expect(
      resolveNativeContextBudget({
        ...evidence,
        configuration: { ...evidence.configuration, postTurnCompactPercent: 50 },
      }),
    ).toEqual({ status: 'unavailable', reason: 'unsupported' })
    expect(
      resolveNativeContextBudget({
        ...evidence,
        metadata: { ...evidence.metadata, contextWindow: null, maxContextWindow: null },
      }),
    ).toMatchObject({ status: 'unavailable' })
  })
  it('also accepts the separately verified 0.149.1 total-scope rules', () => {
    expect(resolveNativeContextBudget({ ...evidence, nativeVersion: '0.149.1' })).toMatchObject({
      status: 'resolved',
      tokens: 80_000,
    })
  })
})
