import { readFile } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import {
  CodexAgentEventNormalizer,
  CodexCurrentConnectionAgentAdapter,
  projectCodexAdditionalContext,
  type CodexAppServerNotification,
} from '../packages/cli/src/adapters/codex-agent.js'
import type { CordisXUserMessage } from '../packages/cli/src/contracts.js'
import { CordisXAgentEventLedger } from '../packages/cli/src/renderer/agent-events.js'

interface Fixture {
  readonly nativeAdditionalContext: Readonly<Record<string, { readonly value: string; readonly kind: 'application' | 'untrusted' }>>
  readonly notifications: readonly CodexAppServerNotification[]
}

const message: CordisXUserMessage = Object.freeze({
  id: 'message-1', role: 'user', content: Object.freeze([{ type: 'text', text: 'CordisX context' }]),
  source: Object.freeze({ kind: 'plugin', source: 'file:///plugins/audit.ts', id: 'audit', version: null, generation: 'generation-1' }),
})

async function fixture(): Promise<Fixture> {
  return JSON.parse(await readFile(new URL('./fixtures/codex-app-server-v0.145.0.json', import.meta.url), 'utf8')) as Fixture
}

describe('private Codex Agent adapter', () => {
  it('preserves native context, creates a collision-free key, and cannot elevate plugin trust', async () => {
    const input = await fixture()
    const colliding = projectCodexAdditionalContext(input.nativeAdditionalContext, message, 'generation-1')
    const cordisxKey = Object.keys(colliding).find(key => key.startsWith('cordisx.agent.'))!
    const second = projectCodexAdditionalContext({ ...colliding, [`${cordisxKey}.1`]: { value: 'native collision', kind: 'application' } }, message, 'generation-1')
    expect(second['native.application']).toEqual(input.nativeAdditionalContext['native.application'])
    expect(second['native.untrusted']).toEqual(input.nativeAdditionalContext['native.untrusted'])
    const added = Object.entries(second).filter(([key]) => key.startsWith(cordisxKey))
    expect(added.at(-1)?.[1]).toEqual({ value: 'CordisX context', kind: 'untrusted' })
    expect(input.nativeAdditionalContext).not.toHaveProperty(cordisxKey)
  })

  it('projects only inside the adapter and preserves native entries on forward', async () => {
    const input = await fixture()
    const forward = vi.fn(async () => ({ accepted: true as const, turnId: 'turn-1', stepId: 'step-1', contextId: 'context-1' }))
    const adapter = new CodexCurrentConnectionAgentAdapter({ forward }, 'generation-1')
    adapter.setNativeContext('session-1', input.nativeAdditionalContext)
    const outcome = await adapter.deliver({ sessionId: 'session-1', target: 'next-step', wakeup: false, message })
    expect(outcome).toMatchObject({ terminal: 'forwarded', claimed: true, projected: true })
    const wire = forward.mock.calls[0]?.[0]
    expect(wire?.additionalContext['native.application']).toEqual(input.nativeAdditionalContext['native.application'])
    expect(Object.values(wire?.additionalContext ?? {}).at(-1)).toMatchObject({ kind: 'untrusted' })
    expect(wire).not.toHaveProperty('rawBridge')
  })

  it('normalizes thread/turn/item/message/chunk lifecycle with stable identities', async () => {
    const input = await fixture()
    const ledger = new CordisXAgentEventLedger(() => 1000)
    const normalizer = new CodexAgentEventNormalizer(ledger)
    for (const notification of input.notifications) normalizer.observe(notification)
    const events = ledger.query({ sessionId: 'session-fixture', limit: 100 }).events
    expect(events.map(event => event.type)).toEqual([
      'session.lifecycle', 'turn.lifecycle', 'item.lifecycle', 'message.observed', 'item.lifecycle',
      'item.lifecycle', 'content.chunk', 'content.chunk', 'item.lifecycle', 'turn.lifecycle',
    ])
    expect(events.filter(event => event.type === 'content.chunk').map(event => (event.data as { index: number }).index)).toEqual([0, 1])
    expect(events.find(event => event.type === 'message.observed')).toMatchObject({
      sessionId: 'session-fixture', turnId: 'turn-fixture', itemId: 'user-fixture', messageId: 'user-fixture',
      provenance: 'observed', source: { kind: 'adapter', adapterId: 'codex' },
    })
  })

  it('marks missing parents and duplicates as inferred diagnostics instead of observed facts', () => {
    const ledger = new CordisXAgentEventLedger()
    const normalizer = new CodexAgentEventNormalizer(ledger)
    normalizer.observe({ method: 'turn/started', params: { threadId: 'session-1', turn: { id: 'turn-1' } } })
    normalizer.observe({ method: 'turn/started', params: { threadId: 'session-1', turn: { id: 'turn-1' } } })
    const events = ledger.query({ sessionId: 'session-1' }).events
    expect(events.filter(event => event.type === 'diagnostic')).toEqual(expect.arrayContaining([
      expect.objectContaining({ provenance: 'inferred', data: expect.objectContaining({ code: 'missing-thread-start' }) }),
      expect.objectContaining({ provenance: 'inferred', data: expect.objectContaining({ code: 'duplicate-turn-start' }) }),
    ]))
    expect(events.find(event => event.type === 'session.lifecycle')).toMatchObject({ provenance: 'inferred', data: { phase: 'resumed' } })
  })
})
