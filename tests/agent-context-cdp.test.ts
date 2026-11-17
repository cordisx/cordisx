import { describe, expect, it } from 'vitest'
import { AGENT_CONTEXT_BINDING, installAgentContextCdpBinding } from '../packages/cli/src/launcher/agent-context-cdp.js'
import { HostAgentContextBridge } from '../packages/cli/src/launcher/agent-context-bridge.js'
import { ContextObservations } from '../packages/cli/src/launcher/context-observations.js'
import type { CdpSession } from '../packages/cli/src/launcher/cdp-session.js'

describe('agent context CDP binding', () => {
  it('isolates documents, rechecks authorization and retires their subscriptions', async () => {
    const listeners = new Map<string, (params: Record<string, unknown>) => void>()
    const replies: { contextId: number; value: any }[] = []
    const fake = {
      send: async (method: string, params: Record<string, any> = {}) => {
        if (method === 'Runtime.evaluate') {
          const encoded = params.expression.match(/\?\.\((.*)\)$/u)[1]
          replies.push({ contextId: params.contextId, value: JSON.parse(JSON.parse(encoded)) })
        }
        return {}
      },
      onEvent: (method: string, listener: (params: Record<string, unknown>) => void) => {
        listeners.set(method, listener)
        return () => {
          listeners.delete(method)
        }
      },
      onClose: () => () => {},
    } as unknown as Pick<CdpSession, 'send' | 'onEvent' | 'onClose'>
    const observations = new ContextObservations(() => 100)
    const epoch = observations.open('owned', 1)
    observations.observe({
      sessionId: 'owned',
      sessionGeneration: 1,
      usedTokens: 20,
      budget: { status: 'resolved', tokens: 100 },
      observedAt: 100,
      expiresAt: 200,
      sequence: 1,
      ...epoch,
    })
    let authorized = true
    const dispose = await installAgentContextCdpBinding(fake, {
      token: 'secret',
      createBridge: () => new HostAgentContextBridge(observations, 10, () => 100),
      authorize: id => authorized && id === 'owned',
    })
    const request = async (contextId: number, value: Record<string, unknown>) => {
      listeners.get('Runtime.bindingCalled')!({
        name: AGENT_CONTEXT_BINDING,
        executionContextId: contextId,
        payload: JSON.stringify({ version: 1, token: 'secret', requestId: 'r', ...value }),
      })
      await new Promise(resolve => setTimeout(resolve, 0))
      return replies.pop()!
    }
    expect(await request(1, { method: 'read', sessionId: 'other' })).toMatchObject({
      contextId: 1,
      value: { ok: false },
    })
    const opened = await request(1, { method: 'open', sessionId: 'owned', thresholdRatio: 0.5 })
    expect(opened.value.value.status).toBe('open')
    const handle = opened.value.value.handle
    expect(await request(2, { method: 'next', handle, cursor: 0 })).toMatchObject({
      contextId: 2,
      value: { ok: false },
    })
    authorized = false
    expect(await request(1, { method: 'next', handle, cursor: 0 })).toMatchObject({ value: { ok: false } })
    authorized = true
    const again = await request(1, { method: 'open', sessionId: 'owned', thresholdRatio: 0.5 })
    listeners.get('Runtime.executionContextDestroyed')!({ executionContextId: 1 })
    expect(await request(1, { method: 'next', handle: again.value.value.handle, cursor: 0 })).toMatchObject({
      value: { ok: false },
    })
    dispose()
    observations.dispose()
  })
})
