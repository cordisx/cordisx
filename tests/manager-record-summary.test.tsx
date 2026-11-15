import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ManagerContentRecordSummaryV6 } from '@cordisx/protocol/manager-content-navigation/v6'
import {
  assertManagerRecordSummary,
  ManagerRecordSummary,
} from '../packages/cli/src/renderer/manager-record-summary.js'

const summary: ManagerContentRecordSummaryV6 = {
  leadingVisual: { kind: 'identity', icon: 'host:chat' },
  title: { key: 'title', fallback: 'Messaging account' },
  statuses: [{ id: 'state', label: { key: 'ready', fallback: 'Connected' }, icon: 'host:success', tone: 'success' }],
  metrics: [{
    id: 'inbound',
    label: { key: 'inbound', fallback: 'Inbound queued' },
    icon: 'host:chat',
    tone: 'neutral',
    value: 1234,
  }],
}

describe('versioned read-only Manager summaries', () => {
  it('accepts identity/status/count only through the successor and rejects invalid display data', () => {
    expect(() => assertManagerRecordSummary(summary, 6)).not.toThrow()
    expect(() => assertManagerRecordSummary(summary, 5)).toThrow()
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => assertManagerRecordSummary({ ...summary, metrics: [{ ...summary.metrics![0]!, value }] }, 6))
        .toThrow()
    }
    expect(() => assertManagerRecordSummary({ ...summary, metrics: [...summary.metrics!, ...summary.metrics!] }, 6))
      .toThrow('duplicated')
    expect(() =>
      assertManagerRecordSummary({
        ...summary,
        statuses: [{ ...summary.statuses![0]!, icon: 'host:made-up' as never }],
      }, 6)
    ).toThrow('unavailable')
    expect(() => assertManagerRecordSummary({ ...summary, secret: 'unexpected' } as never, 6)).toThrow('unknown fields')
  })
  it('renders shared identity, semantic status and locale-formatted counts without controls', () => {
    const markup = renderToStaticMarkup(createElement(ManagerRecordSummary, {
      locale: 'en-US',
      summary: {
        ...summary,
        title: summary.title.fallback,
        statuses: summary.statuses!.map(item => ({ ...item, label: item.label.fallback })),
        metrics: summary.metrics!.map(item => ({ ...item, label: item.label.fallback })),
        source: summary,
      },
    }))
    expect(markup).toContain('data-manager-record-status="state"')
    expect(markup).toContain('data-manager-record-metric="inbound"')
    expect(markup).toContain('1,234')
    expect(markup).toContain('cxr-account-identity')
    expect(markup).not.toContain('<button')
    expect(markup).not.toContain('<input')
  })
})
