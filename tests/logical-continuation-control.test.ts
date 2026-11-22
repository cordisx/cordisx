import { describe, expect, it, vi } from 'vitest'
import {
  LogicalContinuationControl,
  type LogicalContinuationEvidence,
  type LogicalContinuationRequest,
  type LogicalContinuationState,
  parseLogicalContinuationState,
  recoverLogicalContinuations,
} from '../packages/cli/src/launcher/logical-continuation-control.js'

const source = { hostId: 'local', appId: 'codex', profileId: 'personal', sessionId: 'source' }
const destination = { ...source, sessionId: 'destination' }
const actor = { principal: 'owner', scope: 'account/tenant/chat' }
const request: LogicalContinuationRequest = {
  contract: 'cordisx.conversation-continuation-request/v1',
  operationId: 'operation',
  logicalConversationId: 'logical',
  source,
  expectedRevision: 0,
  target: { providerId: 'openai', model: 'terra' },
  mode: 'linked',
  historyConsent: 'on-demand',
  handoffConsent: 'none',
  historyCategories: ['user-text', 'assistant-text'],
}
const evidence: LogicalContinuationEvidence = {
  sourceConfiguration: {
    providerId: 'openrouter',
    model: 'original',
    cwd: '/workspace',
    serviceTier: null,
    approvalsReviewer: 'user',
    sandbox: { type: 'readOnly' },
    permissionProfile: null,
    execution: { approval: 'on-request', workMode: 'default', effort: 'medium', execution: 'read-only' },
  },
  sourceHistoryVersion: 'version-1',
  handoff: 'none',
}
interface Root {
  logical: LogicalContinuationState
  binding: string
  queued: string
  policy: number
}
function fixture() {
  let root: Root = {
    logical: { revision: 0, intents: {}, relations: {} },
    binding: 'source',
    queued: 'source',
    policy: 1,
  }
  const store = {
    snapshot: () => structuredClone(root),
    mutate: async <T>(fn: (value: Root) => T) => {
      const copy = structuredClone(root)
      const result = fn(copy)
      root = copy
      return result
    },
  }
  const adapter = {
    state: (state: Root) => state.logical,
    admitted: (state: Root, who: typeof actor) =>
      state.policy === 1 && who.principal === 'owner' && who.scope === actor.scope && state.binding === 'source',
    bind: (state: Root) => {
      state.binding = 'destination'
      state.queued = 'destination'
      return true
    },
    preflight: vi.fn(async () => structuredClone(evidence)),
    create: vi.fn(async () => ({ state: 'created' as const, destination })),
    confirm: vi.fn(async () => true),
  }
  return { store, adapter, control: new LogicalContinuationControl(store, adapter) }
}

describe('logical continuation lifecycle', () => {
  it('rejects a new fresh request while keeping an existing fresh relation readable', async () => {
    const f = fixture()
    const { historyCategories: _categories, handoffConsent: _handoff, ...base } = request
    const legacy: LogicalContinuationRequest = { ...base, mode: 'fresh', historyConsent: 'none' }
    expect(await f.control.start(actor, legacy)).toMatchObject({
      state: 'rejected',
      code: 'FRESH_CONTINUATION_REMOVED',
    })
    expect(f.adapter.preflight).not.toHaveBeenCalled()
    expect(f.adapter.create).not.toHaveBeenCalled()
    await f.store.mutate(root => {
      root.logical.revision = 1
      root.logical.intents.operation = { request: legacy, actor, evidence, state: 'applied', destination }
      root.logical.relations.operation = {
        contract: 'cordisx.conversation-continuation-relation/v1',
        operationId: 'operation',
        logicalConversationId: 'logical',
        revision: 1,
        source,
        destination,
        target: request.target,
        mode: 'fresh',
        historyAccess: 'none',
        handoff: 'none',
      }
    })
    expect(parseLogicalContinuationState(f.store.snapshot().logical).relations.operation?.mode).toBe('fresh')
    expect(await f.control.start(actor, legacy)).toEqual({ state: 'applied', operationId: 'operation', destination })
    expect(f.adapter.create).not.toHaveBeenCalled()
  })
  it('persists the exact intent before creation and commits relation and binding together', async () => {
    const f = fixture()
    f.adapter.create.mockImplementation(async () => {
      expect(f.store.snapshot().logical.intents.operation?.state).toBe('creating')
      expect(f.store.snapshot().binding).toBe('source')
      return { state: 'created', destination }
    })
    expect(await f.control.start(actor, request)).toEqual({ state: 'applied', operationId: 'operation', destination })
    const state = f.store.snapshot()
    expect(state.binding).toBe('destination')
    expect(state.queued).toBe('destination')
    expect(state.logical.relations.operation).toMatchObject({
      source,
      destination,
      mode: 'linked',
      historyAccess: 'on-demand',
      handoff: 'none',
    })
    expect(await f.control.start(actor, request)).toEqual({ state: 'applied', operationId: 'operation', destination })
    expect(f.adapter.create).toHaveBeenCalledTimes(1)
  })
  it('does not retry an unknown native effect after recreating the controller', async () => {
    const f = fixture()
    f.adapter.create.mockImplementation(async () => {
      throw new Error('connection lost')
    })
    expect(await f.control.start(actor, request)).toEqual({ state: 'unknown', operationId: 'operation' })
    expect(f.store.snapshot().binding).toBe('source')
    const reopened = new LogicalContinuationControl(f.store, f.adapter)
    expect(await reopened.start(actor, request)).toEqual({ state: 'unknown', operationId: 'operation' })
    expect(f.adapter.create).toHaveBeenCalledTimes(1)
  })
  it('reconciles a known destination with readback without repeating native creation', async () => {
    const f = fixture()
    f.adapter.confirm.mockResolvedValueOnce(false).mockResolvedValue(true)
    expect(await f.control.start(actor, request)).toEqual({ state: 'unknown', operationId: 'operation', destination })
    expect(await f.control.reconcile({ ...actor, scope: 'another-chat' }, 'operation')).toMatchObject({
      state: 'rejected',
      code: 'OPERATION_NOT_FOUND',
    })
    expect(await f.control.reconcile(actor, 'operation')).toEqual({
      state: 'applied',
      operationId: 'operation',
      destination,
    })
    expect(f.store.snapshot().binding).toBe('destination')
    expect(f.adapter.create).toHaveBeenCalledTimes(1)
  })
  it('does not reconcile a destination from a different profile', async () => {
    const f = fixture()
    f.adapter.create.mockResolvedValue({ state: 'created', destination: { ...destination, profileId: 'other' } })
    expect(await f.control.start(actor, request)).toMatchObject({ state: 'unknown' })
    expect(await f.control.reconcile(actor, 'operation')).toEqual({ state: 'unknown', operationId: 'operation' })
    expect(f.store.snapshot().binding).toBe('source')
    expect(parseLogicalContinuationState(f.store.snapshot().logical).intents.operation?.destination).toBeUndefined()
  })
  it('validates persisted security evidence and the committed revision before recovery', async () => {
    const f = fixture()
    await f.control.start(actor, request)
    const saved = f.store.snapshot().logical
    expect(parseLogicalContinuationState(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
    const missingSecurity = structuredClone(saved) as any
    delete missingSecurity.intents.operation.evidence.sourceConfiguration.execution
    expect(() => parseLogicalContinuationState(missingSecurity)).toThrow('INVALID_LOGICAL_CONTINUATION_STORE')
    const wrongProfile = structuredClone(saved) as any
    wrongProfile.intents.operation.evidence.sourceConfiguration.permissionProfile = { id: 'other' }
    expect(() => parseLogicalContinuationState(wrongProfile)).toThrow('INVALID_LOGICAL_CONTINUATION_STORE')
    const staleRevision = structuredClone(saved)
    staleRevision.revision = 0
    expect(() => parseLogicalContinuationState(staleRevision)).toThrow('INVALID_LOGICAL_CONTINUATION_STORE')
    const tamperedRelation = structuredClone(saved) as any
    tamperedRelation.relations.operation.destination.sessionId = 'other'
    expect(() => parseLogicalContinuationState(tamperedRelation)).toThrow('INVALID_LOGICAL_CONTINUATION_STORE')
  })
  it('rejects object prototype names as operation identifiers', async () => {
    const f = fixture()
    expect(await f.control.start(actor, { ...request, operationId: '__proto__' })).toMatchObject({
      state: 'rejected',
      code: 'INVALID_REQUEST',
    })
    expect(f.adapter.create).not.toHaveBeenCalled()
  })
  it('fences an interrupted reservation on store recovery before any dispatch', () => {
    const state: LogicalContinuationState = {
      revision: 0,
      relations: {},
      intents: { operation: { request, actor, evidence, state: 'creating' } },
    }
    recoverLogicalContinuations(state)
    expect(state.intents.operation).toMatchObject({ state: 'unknown', code: 'NATIVE_EFFECT_UNCERTAIN' })
  })
  it('does not duplicate an in-flight effect for repeated or competing requests', async () => {
    const f = fixture()
    let release!: () => void
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    f.adapter.create.mockImplementation(async () => {
      await gate
      return { state: 'created', destination }
    })
    const first = f.control.start(actor, request)
    await vi.waitFor(() => expect(f.adapter.create).toHaveBeenCalledTimes(1))
    expect(await f.control.start(actor, request)).toEqual({ state: 'unknown', operationId: 'operation' })
    expect(await f.control.start(actor, { ...request, operationId: 'other' })).toMatchObject({
      state: 'rejected',
      code: 'SESSION_BUSY',
    })
    release()
    expect(await first).toMatchObject({ state: 'applied' })
    expect(f.adapter.create).toHaveBeenCalledTimes(1)
  })
  it('leaves the source binding untouched when authorization changes during native creation', async () => {
    const f = fixture()
    f.adapter.create.mockImplementation(async () => {
      await f.store.mutate(state => {
        state.policy = 2
      })
      return { state: 'created', destination }
    })
    expect(await f.control.start(actor, request)).toEqual({ state: 'unknown', operationId: 'operation', destination })
    const state = f.store.snapshot()
    expect(state.binding).toBe('source')
    expect(state.logical.relations.operation).toBeUndefined()
  })
  it('rechecks permission after reservation and before creating a native session', async () => {
    const f = fixture()
    f.adapter.preflight.mockResolvedValueOnce(structuredClone(evidence)).mockImplementationOnce(async () => {
      await f.store.mutate(state => {
        state.policy = 2
      })
      return structuredClone(evidence)
    })
    expect(await f.control.start(actor, request)).toMatchObject({ state: 'rejected', code: 'PREFLIGHT_CHANGED' })
    expect(f.adapter.create).not.toHaveBeenCalled()
    expect(f.store.snapshot().binding).toBe('source')
  })
  it('rolls back a failed binding mutation and retains the uncertain destination', async () => {
    const f = fixture()
    f.adapter.bind = (state: Root) => {
      state.binding = 'changed-in-draft'
      return false
    }
    expect(await f.control.start(actor, request)).toEqual({ state: 'unknown', operationId: 'operation', destination })
    expect(f.store.snapshot().binding).toBe('source')
    expect(f.store.snapshot().logical.intents.operation?.state).toBe('unknown')
  })
  it('does not create for unconsented fields, stale policies or mismatched native readback', async () => {
    const f = fixture()
    const injected = { ...request, actor: 'forged' } as LogicalContinuationRequest
    expect(await f.control.start(actor, injected)).toMatchObject({ state: 'rejected', code: 'INVALID_REQUEST' })
    expect(await f.control.start({ ...actor, scope: 'another-chat' }, request)).toMatchObject({
      state: 'rejected',
      code: 'SOURCE_CHANGED_OR_BUSY',
    })
    expect(f.adapter.create).not.toHaveBeenCalled()
    f.adapter.confirm.mockResolvedValue(false)
    expect(await f.control.start(actor, request)).toEqual({ state: 'unknown', operationId: 'operation', destination })
    expect(f.store.snapshot().binding).toBe('source')
  })
  it('rejects checkpoint sharing without the separately approved exact checkpoint digest', async () => {
    const f = fixture()
    f.adapter.preflight.mockResolvedValue({ ...evidence, handoff: 'checkpoint' })
    expect(await f.control.start(actor, { ...request, handoffConsent: 'checkpoint' })).toMatchObject({
      state: 'rejected',
      code: 'PREFLIGHT_UNAVAILABLE',
    })
    expect(f.adapter.create).not.toHaveBeenCalled()
  })
  it('supports an explicitly selected same-provider fork', async () => {
    const f = fixture()
    const sameProvider: LogicalContinuationRequest = {
      contract: request.contract,
      operationId: request.operationId,
      logicalConversationId: request.logicalConversationId,
      source,
      expectedRevision: 0,
      target: { providerId: 'openrouter', model: 'original' },
      mode: 'fork',
      historyConsent: 'inherit',
    }
    expect(await f.control.start(actor, sameProvider)).toMatchObject({ state: 'applied' })
    expect(f.store.snapshot().logical.relations.operation).toMatchObject({ mode: 'fork', historyAccess: 'inherited' })
  })
  it('never overwrites an existing committed relation for the same operation', async () => {
    const f = fixture()
    await f.store.mutate(state => {
      state.logical.relations.operation = {
        contract: 'cordisx.conversation-continuation-relation/v1',
        operationId: request.operationId,
        logicalConversationId: request.logicalConversationId,
        revision: 1,
        source,
        destination,
        target: request.target,
        mode: 'fresh',
        historyAccess: 'none',
        handoff: 'none',
      }
    })
    expect(await f.control.start(actor, request)).toMatchObject({ state: 'rejected', code: 'SOURCE_CHANGED_OR_BUSY' })
    expect(f.adapter.create).not.toHaveBeenCalled()
    expect(f.store.snapshot().logical.relations.operation?.mode).toBe('fresh')
  })
})
