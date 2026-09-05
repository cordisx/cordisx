import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildRendererComposition } from '../packages/cli/src/cli/run.js'
import {
  CdpCertifiedPermissionChannel,
  type CertifiedPermissionCdpSession,
} from '../packages/cli/src/launcher/certified-permission-cdp.js'
import type {
  LauncherMarketplaceCertifiedAuthority,
  LauncherMarketplaceCertifiedSnapshot,
} from '../packages/cli/src/launcher/marketplace-certified-authority.js'
import {
  CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
  certifiedPermissionEndpointTakeKey,
} from '../packages/cli/src/renderer/certified-permission-channel.js'

const token = 'c'.repeat(64)
const profileId = 'work'
const runtimeGeneration = 'runtime-1'
const targetId = 'target-1'

interface SentCall {
  readonly method: string
  readonly params: Record<string, unknown>
}

interface EndpointPlan {
  readonly objectId?: string
  readonly documentEpoch?: string
  readonly description?: Readonly<Record<string, unknown>>
  readonly takeResponse?: Readonly<Record<string, unknown>>
  readonly descriptionResponse?: Readonly<Record<string, unknown>>
}

class FakeSession implements CertifiedPermissionCdpSession {
  readonly sent: SentCall[] = []
  readonly listeners = new Map<string, Set<(params: Record<string, unknown>) => void>>()
  readonly endpointObjectIds: string[] = []
  readonly endpointPlans: EndpointPlan[] = []
  readonly descriptions = new Map<string, EndpointPlan>()
  readonly invalidAckObjectIds = new Set<string>()
  readonly deferredDeliveryObjectIds = new Set<string>()
  readonly deferredDeliveryResolvers = new Map<string, (response: Record<string, unknown>) => void>()
  readonly deferredTopContextIds = new Set<number>()
  readonly deferredTopResolvers = new Map<number, (response: Record<string, unknown>) => void>()
  readonly topFrames = new Map<number, boolean>()
  private endpointSequence = 0

  queueEndpoint(plan: EndpointPlan): void {
    this.endpointPlans.push(plan)
  }

  deferDelivery(objectId: string): void {
    this.deferredDeliveryObjectIds.add(objectId)
  }

  deferTop(executionContextId: number): void {
    this.deferredTopContextIds.add(executionContextId)
  }

  resolveTop(executionContextId: number): void {
    const resolve = this.deferredTopResolvers.get(executionContextId)
    if (resolve === undefined) throw new Error(`deferred top check for ${executionContextId} is unavailable`)
    this.deferredTopResolvers.delete(executionContextId)
    resolve({ result: { value: this.topFrames.get(executionContextId) ?? true } })
  }

  resolveDelivery(objectId: string, input: Readonly<{ invalidAck?: boolean }> = {}): void {
    const resolve = this.deferredDeliveryResolvers.get(objectId)
    if (resolve === undefined) throw new Error(`deferred delivery for ${objectId} is unavailable`)
    this.deferredDeliveryResolvers.delete(objectId)
    const payload = this.deliveryPayloads(objectId).at(-1)
    if (payload === undefined) throw new Error(`delivery payload for ${objectId} is unavailable`)
    resolve({
      result: {
        value: {
          documentEpoch: input.invalidAck === true ? 'invalid_document_epoch' : payload.documentEpoch,
          deliverySequence: payload.deliverySequence,
          authorityRevision: payload.authorityRevision,
        },
      },
    })
  }

  async send(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    this.sent.push({ method, params })
    if (method === 'Runtime.evaluate') {
      if (params.expression === 'globalThis === globalThis.top') {
        const contextId = params.contextId as number
        if (this.deferredTopContextIds.delete(contextId)) {
          return await new Promise(resolve => {
            this.deferredTopResolvers.set(contextId, resolve)
          })
        }
        return { result: { value: this.topFrames.get(contextId) ?? true } }
      }
      const plan = this.endpointPlans.shift()
      if (plan === undefined) return { result: {} }
      if (plan.takeResponse !== undefined) return { ...plan.takeResponse }
      const objectId = plan.objectId ?? `endpoint-${++this.endpointSequence}`
      this.endpointObjectIds.push(objectId)
      this.descriptions.set(objectId, plan)
      return { result: { objectId } }
    }
    if (method === 'Runtime.callFunctionOn') {
      const declaration = String(params.functionDeclaration)
      const objectId = String(params.objectId)
      if (declaration.includes('this.describe')) {
        const plan = this.descriptions.get(objectId)
        if (plan?.descriptionResponse !== undefined) return { ...plan.descriptionResponse }
        return {
          result: {
            value: plan?.description ?? {
              contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
              profileId,
              runtimeGeneration,
              documentEpoch: plan?.documentEpoch ?? 'document_epoch_default',
            },
          },
        }
      }
      if (declaration.includes('this.deliver')) {
        if (this.deferredDeliveryObjectIds.delete(objectId)) {
          return await new Promise(resolve => {
            this.deferredDeliveryResolvers.set(objectId, resolve)
          })
        }
        const payload = this.deliveryPayloads(objectId).at(-1)
        if (payload === undefined) throw new Error(`delivery payload for ${objectId} is unavailable`)
        return {
          result: {
            value: {
              documentEpoch: this.invalidAckObjectIds.has(objectId) ? 'invalid_document_epoch' : payload.documentEpoch,
              deliverySequence: payload.deliverySequence,
              authorityRevision: payload.authorityRevision,
            },
          },
        }
      }
      return { result: { value: true } }
    }
    return {}
  }

  onEvent(method: string, listener: (params: Record<string, unknown>) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set()
    listeners.add(listener)
    this.listeners.set(method, listeners)
    return () => {
      listeners.delete(listener)
      if (listeners.size === 0) this.listeners.delete(method)
    }
  }

  emit(method: string, params: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(method) ?? [])]) listener(params)
  }

  calls(method: string, declaration?: 'describe' | 'deliver' | 'close'): SentCall[] {
    return this.sent.filter(call =>
      call.method === method && (declaration === undefined
        || String(call.params.functionDeclaration).includes(`this.${declaration}`))
    )
  }

  deliveryPayload(index: number): Record<string, unknown> {
    const call = this.calls('Runtime.callFunctionOn', 'deliver')[index]
    const args = call?.params.arguments as readonly { readonly value?: unknown }[] | undefined
    if (args === undefined) throw new Error(`delivery ${index} is unavailable`)
    return JSON.parse(String(args[0]?.value)) as Record<string, unknown>
  }

  deliveryPayloads(objectId: string): Record<string, unknown>[] {
    return this.calls('Runtime.callFunctionOn', 'deliver')
      .filter(call => call.params.objectId === objectId)
      .map(call => {
        const args = call.params.arguments as readonly { readonly value?: unknown }[]
        return JSON.parse(String(args[0]?.value)) as Record<string, unknown>
      })
  }
}

class FakeAuthority {
  current: LauncherMarketplaceCertifiedSnapshot = Object.freeze({ revision: 1, projections: Object.freeze([]) })
  listener: ((revision: number) => void) | undefined
  readonly snapshotCalls: LauncherMarketplaceCertifiedSnapshot[] = []
  unsubscribed = false

  snapshot(): LauncherMarketplaceCertifiedSnapshot {
    this.snapshotCalls.push(this.current)
    return this.current
  }

  subscribe(listener: (revision: number) => void): () => void {
    this.listener = listener
    return () => {
      this.unsubscribed = true
      if (this.listener === listener) this.listener = undefined
    }
  }

  notify(revision: number, fresh: LauncherMarketplaceCertifiedSnapshot): void {
    this.current = fresh
    this.listener?.(revision)
  }
}

function contextCreated(
  session: FakeSession,
  executionContextId: number,
  plan?: EndpointPlan,
  isDefault = true,
): void {
  if (plan !== undefined) session.queueEndpoint(plan)
  session.emit('Runtime.executionContextCreated', {
    context: { id: executionContextId, auxData: { isDefault } },
  })
}

function channel(session: FakeSession, authority: FakeAuthority): CdpCertifiedPermissionChannel {
  return new CdpCertifiedPermissionChannel(session, {
    authority: authority as unknown as LauncherMarketplaceCertifiedAuthority,
    token,
    profileId,
    runtimeGeneration,
    targetId,
  })
}

async function eventually(assertion: () => void): Promise<void> {
  let last: unknown
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      assertion()
      return
    } catch (error) {
      last = error
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
  }
  throw last
}

afterEach(() => {
  vi.useRealTimers()
})

describe('Launcher Certified permission CDP channel', () => {
  it('adopts one top default context, polls the take key, describes the endpoint, and validates delivery', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      session.queueEndpoint({ takeResponse: { result: {} } })
      contextCreated(session, 7, { documentEpoch: 'document_epoch_A1' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))

      expect(session.calls('Runtime.evaluate')).toHaveLength(3)
      expect(session.calls('Runtime.evaluate')[0]?.params).toMatchObject({
        expression: 'globalThis === globalThis.top',
        contextId: 7,
        returnByValue: true,
      })
      expect(session.calls('Runtime.evaluate')[1]?.params).toMatchObject({
        expression: `globalThis[${JSON.stringify(certifiedPermissionEndpointTakeKey(token))}]?.()`,
        contextId: 7,
        returnByValue: false,
        objectGroup: `cordisx-certified-permission-${targetId}`,
      })
      expect(session.calls('Runtime.evaluate')[2]?.params).toMatchObject({
        expression: `globalThis[${JSON.stringify(certifiedPermissionEndpointTakeKey(token))}]?.()`,
        contextId: 7,
        returnByValue: false,
        objectGroup: `cordisx-certified-permission-${targetId}`,
      })
      expect(session.calls('Runtime.callFunctionOn', 'describe')).toEqual([expect.objectContaining({
        params: expect.objectContaining({ objectId: 'endpoint-1' }),
      })])
      expect(session.deliveryPayload(0)).toMatchObject({
        profileId,
        runtimeGeneration,
        documentEpoch: 'document_epoch_A1',
        deliverySequence: 1,
        authorityRevision: 1,
        snapshot: { revision: 1, projections: [] },
      })
      expect(authority.snapshotCalls).toHaveLength(1)
    } finally {
      await value.dispose()
    }
  })

  it('freshly rereads the authority after a revision-only subscription notification', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 8, { documentEpoch: 'document_epoch_B1' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))

      authority.notify(2, Object.freeze({ revision: 3, projections: Object.freeze([]) }))
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(2))
      expect(session.deliveryPayload(1)).toMatchObject({
        deliverySequence: 2,
        authorityRevision: 3,
        snapshot: { revision: 3, projections: [] },
      })
      expect(authority.snapshotCalls.map(snapshot => snapshot.revision)).toEqual([1, 3])
    } finally {
      await value.dispose()
    }
  })

  it('ignores non-default and subframe execution contexts before taking an endpoint', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 9, undefined, false)
      expect(session.sent).toEqual([])

      session.topFrames.set(10, false)
      contextCreated(session, 10, { documentEpoch: 'document_epoch_C1' })
      await eventually(() => expect(session.calls('Runtime.evaluate')).toHaveLength(1))
      expect(session.endpointObjectIds).toEqual([])
      expect(session.calls('Runtime.callFunctionOn', 'deliver')).toEqual([])
      expect(authority.snapshotCalls).toEqual([])
    } finally {
      await value.dispose()
    }
  })

  it('replaces a same-context document epoch and closes and releases the old endpoint', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 11, { documentEpoch: 'document_epoch_D1' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))
      contextCreated(session, 11, { documentEpoch: 'document_epoch_D2' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(2))
      await eventually(() => expect(session.calls('Runtime.releaseObject')).toHaveLength(1))

      expect(session.calls('Runtime.callFunctionOn', 'close')[0]?.params).toMatchObject({ objectId: 'endpoint-1' })
      expect(session.calls('Runtime.releaseObject')[0]?.params).toEqual({ objectId: 'endpoint-1' })
      expect(session.calls('Runtime.callFunctionOn', 'deliver')[1]?.params.objectId).toBe('endpoint-2')
      expect(session.deliveryPayload(1)).toMatchObject({ documentEpoch: 'document_epoch_D2', deliverySequence: 1 })
    } finally {
      await value.dispose()
    }
  })

  it('does not replace a live endpoint with exceptionDetails or an Error-shaped RemoteObject', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 12, { documentEpoch: 'document_epoch_E1' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))

      contextCreated(session, 12, {
        objectId: 'exception-endpoint',
        descriptionResponse: { exceptionDetails: { text: 'hostile describe' }, result: { objectId: 'error-1' } },
      })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'describe')).toHaveLength(2))
      await eventually(() =>
        expect(session.calls('Runtime.releaseObject').some(call => call.params.objectId === 'exception-endpoint')).toBe(
          true,
        )
      )

      contextCreated(session, 12, {
        objectId: 'error-endpoint',
        descriptionResponse: { result: { type: 'object', subtype: 'error', objectId: 'error-2' } },
      })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'describe')).toHaveLength(3))
      await eventually(() =>
        expect(session.calls('Runtime.releaseObject').some(call => call.params.objectId === 'error-endpoint')).toBe(
          true,
        )
      )

      authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
      await eventually(() => expect(session.deliveryPayloads('endpoint-1')).toHaveLength(2))
      expect(session.deliveryPayloads('exception-endpoint')).toEqual([])
      expect(session.deliveryPayloads('error-endpoint')).toEqual([])
    } finally {
      await value.dispose()
    }
  })

  it.each(
    [
      ['profile', { profileId: 'other', runtimeGeneration }],
      ['runtime', { profileId, runtimeGeneration: 'runtime-2' }],
    ] as const,
  )('keeps the live endpoint when a replacement describes the wrong %s', async (_case, binding) => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 13, { documentEpoch: 'document_epoch_F1' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))
      contextCreated(session, 13, {
        objectId: `wrong-${_case}`,
        description: {
          contract: CERTIFIED_PERMISSION_CHANNEL_CONTRACT,
          ...binding,
          documentEpoch: 'document_epoch_F2',
        },
      })
      await eventually(() =>
        expect(session.calls('Runtime.releaseObject').some(call => call.params.objectId === `wrong-${_case}`)).toBe(
          true,
        )
      )

      authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
      await eventually(() => expect(session.deliveryPayloads('endpoint-1')).toHaveLength(2))
      expect(session.deliveryPayloads(`wrong-${_case}`)).toEqual([])
    } finally {
      await value.dispose()
    }
  })

  it('fences destroyed and cleared contexts and never redelivers to released endpoints', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 14, { documentEpoch: 'document_epoch_G1' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))
      session.emit('Runtime.executionContextDestroyed', { executionContextId: 14 })
      await eventually(() => expect(session.calls('Runtime.releaseObject')).toHaveLength(1))
      authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1)

      contextCreated(session, 15, { documentEpoch: 'document_epoch_G2' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(2))
      session.emit('Runtime.executionContextsCleared')
      await eventually(() => expect(session.calls('Runtime.releaseObject')).toHaveLength(2))
      authority.notify(3, Object.freeze({ revision: 3, projections: Object.freeze([]) }))
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(2)
      expect(session.calls('Runtime.releaseObject').map(call => call.params.objectId)).toEqual([
        'endpoint-1',
        'endpoint-2',
      ])
    } finally {
      await value.dispose()
    }
  })

  it.each(['destroyed', 'cleared'] as const)(
    'does not adopt an endpoint whose initial delivery completes after its context is %s',
    async event => {
      const session = new FakeSession()
      session.deferDelivery('endpoint-1')
      const authority = new FakeAuthority()
      const value = channel(session, authority)
      try {
        contextCreated(session, 16, { documentEpoch: 'document_epoch_race' })
        await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))
        if (event === 'destroyed') {
          session.emit('Runtime.executionContextDestroyed', { executionContextId: 16 })
        } else {
          session.emit('Runtime.executionContextsCleared')
        }
        session.resolveDelivery('endpoint-1')
        await new Promise<void>(resolve => setTimeout(resolve, 0))

        authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1)
        expect(session.calls('Runtime.releaseObject')).toContainEqual(expect.objectContaining({
          params: { objectId: 'endpoint-1' },
        }))
      } finally {
        await value.dispose()
      }
    },
  )

  it('rejects an old local context epoch when a destroyed numeric id is reused during initial delivery', async () => {
    const session = new FakeSession()
    session.deferDelivery('endpoint-1')
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    let replacementTopResolved = false
    try {
      contextCreated(session, 20, { documentEpoch: 'document_epoch_reused_old' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))

      session.emit('Runtime.executionContextDestroyed', { executionContextId: 20 })
      session.deferTop(20)
      contextCreated(session, 20, { documentEpoch: 'document_epoch_reused_new' })
      session.resolveDelivery('endpoint-1')

      await eventually(() =>
        expect(
          session.calls('Runtime.evaluate').filter(call => call.params.expression === 'globalThis === globalThis.top'),
        ).toHaveLength(2)
      )
      await eventually(() =>
        expect(session.calls('Runtime.releaseObject').some(call => call.params.objectId === 'endpoint-1')).toBe(true)
      )
      expect(session.calls('Runtime.callFunctionOn', 'close')).toContainEqual(expect.objectContaining({
        params: expect.objectContaining({ objectId: 'endpoint-1' }),
      }))

      session.resolveTop(20)
      replacementTopResolved = true
      await eventually(() =>
        expect(session.deliveryPayloads('endpoint-2')).toEqual([
          expect.objectContaining({ documentEpoch: 'document_epoch_reused_new', deliverySequence: 1 }),
        ])
      )

      authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
      await eventually(() => expect(session.deliveryPayloads('endpoint-2')).toHaveLength(2))
      expect(session.deliveryPayloads('endpoint-1')).toHaveLength(1)
    } finally {
      if (!replacementTopResolved && session.deferredTopResolvers.has(20)) session.resolveTop(20)
      await value.dispose()
    }
  })

  it('fails closed by closing and releasing a candidate with an invalid acknowledgement', async () => {
    const session = new FakeSession()
    session.invalidAckObjectIds.add('endpoint-1')
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 16, { documentEpoch: 'document_epoch_H1' })
      await eventually(() => expect(session.calls('Runtime.releaseObject')).toHaveLength(1))
      expect(session.calls('Runtime.callFunctionOn', 'close')).toEqual([expect.objectContaining({
        params: expect.objectContaining({ objectId: 'endpoint-1' }),
      })])

      authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1)
    } finally {
      await value.dispose()
    }
  })

  it('ignores an in-flight stale response after destruction and adopts only the replacement epoch', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    try {
      contextCreated(session, 17, { documentEpoch: 'document_epoch_I1' })
      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))
      session.deferDelivery('endpoint-1')
      authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
      await eventually(() => expect(session.deliveryPayloads('endpoint-1')).toHaveLength(2))

      session.emit('Runtime.executionContextDestroyed', { executionContextId: 17 })
      contextCreated(session, 17, { documentEpoch: 'document_epoch_I2' })
      session.resolveDelivery('endpoint-1', { invalidAck: true })

      await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(3))
      expect(session.calls('Runtime.releaseObject').some(call => call.params.objectId === 'endpoint-1')).toBe(true)
      expect(session.deliveryPayloads('endpoint-2')).toEqual([expect.objectContaining({
        documentEpoch: 'document_epoch_I2',
        deliverySequence: 1,
        authorityRevision: 2,
      })])

      authority.notify(3, Object.freeze({ revision: 3, projections: Object.freeze([]) }))
      await eventually(() => expect(session.deliveryPayloads('endpoint-2')).toHaveLength(2))
      expect(session.deliveryPayloads('endpoint-1')).toHaveLength(2)
    } finally {
      await value.dispose()
    }
  })

  it('disposes the active endpoint, subscription, listeners, object, and object group exactly once', async () => {
    const session = new FakeSession()
    const authority = new FakeAuthority()
    const value = channel(session, authority)
    contextCreated(session, 18, { documentEpoch: 'document_epoch_J1' })
    await eventually(() => expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1))

    await value.dispose()
    await value.dispose()
    expect(authority.unsubscribed).toBe(true)
    expect(session.listeners.size).toBe(0)
    expect(session.calls('Runtime.callFunctionOn', 'close')).toHaveLength(1)
    expect(session.calls('Runtime.releaseObject')).toContainEqual(expect.objectContaining({
      params: { objectId: 'endpoint-1' },
    }))
    expect(session.calls('Runtime.releaseObjectGroup')).toEqual([expect.objectContaining({
      params: { objectGroup: `cordisx-certified-permission-${targetId}` },
    })])

    authority.notify(2, Object.freeze({ revision: 2, projections: Object.freeze([]) }))
    contextCreated(session, 19, { documentEpoch: 'document_epoch_J2' })
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    expect(session.calls('Runtime.callFunctionOn', 'deliver')).toHaveLength(1)
  })

  it('keeps the unguessable take capability out of the current-live source and only in future documents', async () => {
    const splitToken = 'e'.repeat(64)
    const composition = await buildRendererComposition(
      {
        version: 1,
        rootDir: process.cwd(),
        codex: { debugPort: 9229 },
        providers: [],
        plugins: [],
      },
      () => undefined,
      {
        profileId,
        certifiedPermissionChannelToken: splitToken,
      },
    )

    expect(composition.source).not.toContain(splitToken)
    expect(composition.source).not.toContain(certifiedPermissionEndpointTakeKey(splitToken))
    expect(composition.newDocumentSource).toContain(splitToken)
  })
})
