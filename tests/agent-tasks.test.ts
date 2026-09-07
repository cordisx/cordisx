import { describe, expect, it, vi } from 'vitest'
import type { AgentTaskCreateRequest } from '@cordisx/protocol/agent-task/v1'
import type { Agent } from '@cordisx/protocol/agents/v1'
import type { AgentTaskRecord } from '../packages/cli/src/agent-task-record.js'
import { type AgentTaskDependencies, HostAgentTasks } from '../packages/cli/src/renderer/agent-tasks.js'

const request: AgentTaskCreateRequest = {
  operationId: 'task-1',
  definition: { agentId: 'worker', revision: 'v1' },
  context: { kind: 'directory', cwd: '/task' },
  text: 'Perform the task',
  tool: { commandId: 'report', scope: { roomId: 'room', runId: 'run' } },
}
function fixture() {
  const records = new Map<string, AgentTaskRecord>()
  const phases: string[] = []
  let active = true
  const deps: AgentTaskDependencies = {
    store: {
      load: async id => structuredClone(records.get(id)),
      recover: async operationId => {
        const record = records.get(operationId)!
        if (record.phase !== 'approval-install-failed') return { claimed: false, record }
        const { result: _result, ...rest } = record
        const next: AgentTaskRecord = { ...rest, phase: 'approval-installing' }
        records.set(operationId, next)
        phases.push('approval-installing')
        return { claimed: true, record: next }
      },
      claim: async record => {
        const prior = records.get(record.operationId)
        if (prior) return { claimed: false, record: structuredClone(prior) }
        records.set(record.operationId, structuredClone(record))
        phases.push(record.phase)
        return { claimed: true, record }
      },
      save: async record => {
        records.set(record.operationId, structuredClone(record))
        phases.push(record.phase)
      },
    },
    active: () => active,
    authorize: vi.fn(async () => true),
    resolveContext: vi.fn(async () => ({ status: 'resolved', context: { cwd: '/task' } })),
    validateDefinition: vi.fn(async () => true),
    validateTool: vi.fn(async () => true),
    create: vi.fn(async (_request, record) => {
      expect(records.get(record.operationId)?.phase).toBe('creating')
      return { id: record.sessionId, detail: { kind: 'host', ref: 'opaque-detail' } } as Agent
    }),
    bind: vi.fn(async () => {
      expect(['binding', 'approval-installing']).toContain(phases.at(-1))
    }),
    submit: vi.fn(async () => {
      expect(phases.at(-1)).toBe('submitting')
      return true
    }),
    observe: vi.fn(async () => ({ status: 'available', value: 'running' })),
  }
  return {
    deps,
    records,
    phases,
    service: new HostAgentTasks(deps),
    dispose: () => {
      active = false
    },
  }
}

describe('Host Agent task transaction', () => {
  it('durably associates one Session and message before binding and the first submit', async () => {
    const f = fixture()
    const result = await f.service.createAndSubmit(request)
    expect(result.status).toBe('accepted')
    expect(f.phases).toEqual(['intent', 'creating', 'created', 'binding', 'submitting', 'finished'])
    expect(f.deps.bind).toHaveBeenCalledWith('report', expect.any(String), request.tool.scope)
    expect(f.deps.submit).toHaveBeenCalledWith(expect.any(Object), f.records.get('task-1')!.messageId, request.text)
  })
  it('shares concurrent equal requests, ignores JSON property order and rejects conflicting retries', async () => {
    const f = fixture()
    const equal = { ...request, tool: { scope: { runId: 'run', roomId: 'room' }, commandId: 'report' } }
    const results = await Promise.all([f.service.createAndSubmit(request), f.service.createAndSubmit(equal)])
    expect(results[0]).toEqual(results[1])
    expect(f.deps.create).toHaveBeenCalledTimes(1)
    expect(await f.service.createAndSubmit(equal)).toMatchObject({ status: 'accepted', disposition: 'replayed' })
    expect(await f.service.createAndSubmit({ ...request, text: 'Changed' })).toMatchObject({
      code: 'operation-conflict',
    })
    expect(f.deps.submit).toHaveBeenCalledTimes(1)
  })
  it('freezes the request before async resolution', async () => {
    const f = fixture()
    const input = structuredClone(request)
    const result = f.service.createAndSubmit(input)
    ;(input as { text: string }).text = 'Mutated'
    await result
    expect(f.deps.submit).toHaveBeenCalledWith(expect.any(Object), expect.any(String), request.text)
  })
  it('fails missing/invalid context and missing definition/tools before creating intent', async () => {
    const f = fixture()
    const { context: _context, ...missing } = request
    expect(await f.service.createAndSubmit(missing as AgentTaskCreateRequest)).toMatchObject({
      code: 'context-required',
    })
    vi.mocked(f.deps.resolveContext).mockResolvedValue({ status: 'unavailable', code: 'directory-unavailable' })
    expect(await f.service.createAndSubmit(request)).toMatchObject({ code: 'directory-unavailable' })
    expect(f.records.size).toBe(0)
    expect(f.deps.create).not.toHaveBeenCalled()
  })
  it('retains a partial Session on binding failure and never submits or creates again', async () => {
    const f = fixture()
    vi.mocked(f.deps.bind).mockRejectedValue(new Error('missing deployment'))
    const result = await f.service.createAndSubmit(request)
    expect(result).toMatchObject({ code: 'tool-unavailable', sessionId: expect.any(String) })
    const restarted = new HostAgentTasks(f.deps)
    expect(await restarted.createAndSubmit(request)).toEqual(result)
    expect(await restarted.query({ operationId: request.operationId })).toMatchObject({ status: 'found', result })
    expect(f.deps.create).toHaveBeenCalledTimes(1)
    expect(f.deps.submit).not.toHaveBeenCalled()
  })
  it.each(['create', 'submit'] as const)(
    'retains unknown %s across restart without repeating side effects',
    async phase => {
      const f = fixture()
      vi.mocked(f.deps[phase]).mockRejectedValue(new Error('ack lost'))
      expect(await f.service.createAndSubmit(request)).toMatchObject({ code: 'reconciliation-required' })
      const restarted = new HostAgentTasks(f.deps)
      expect(await restarted.createAndSubmit(request)).toMatchObject({ code: 'reconciliation-required' })
      expect(f.deps.create).toHaveBeenCalledTimes(1)
      expect(f.deps.submit).toHaveBeenCalledTimes(phase === 'submit' ? 1 : 0)
    },
  )
  it('queries intent without inventing an execution state or waking a Session', async () => {
    const f = fixture()
    vi.mocked(f.deps.create).mockRejectedValue(new Error('ack lost'))
    await f.service.createAndSubmit(request)
    expect(await f.service.query({ operationId: 'task-1' })).toMatchObject({
      status: 'found',
      execution: { status: 'unavailable', code: 'host-unavailable' },
    })
    expect(f.deps.observe).not.toHaveBeenCalled()
  })
  it('revalidates permission on replay/query and fences disposal before binding', async () => {
    const f = fixture()
    await f.service.createAndSubmit(request)
    vi.mocked(f.deps.authorize).mockResolvedValue(false)
    expect(await f.service.createAndSubmit(request)).toMatchObject({ code: 'permission-denied' })
    expect(await f.service.query({ operationId: 'task-1' })).toMatchObject({ code: 'permission-denied' })
    const next = fixture()
    vi.mocked(next.deps.create).mockImplementation(async (_request, record) => {
      next.dispose()
      return { id: record.sessionId, detail: { kind: 'host', ref: 'detail' } } as Agent
    })
    expect(await next.service.createAndSubmit(request)).toMatchObject({ code: 'permission-denied' })
    expect(next.deps.bind).not.toHaveBeenCalled()
  })
  it('separates owners through distinct authenticated stores', async () => {
    const a = fixture(), b = fixture()
    await a.service.createAndSubmit(request)
    expect(await b.service.query({ operationId: 'task-1' })).toEqual({ status: 'not-found' })
  })
  it('allows an early report to query the retained partial Session before the receipt resolves', async () => {
    const f = fixture()
    vi.mocked(f.deps.submit).mockImplementation(async () => {
      expect(await f.service.query({ operationId: request.operationId })).toMatchObject({
        status: 'found',
        result: { code: 'reconciliation-required', sessionId: f.records.get('task-1')!.sessionId },
      })
      return true
    })
    expect(await f.service.createAndSubmit(request)).toMatchObject({ status: 'accepted' })
    expect(await f.service.query({ operationId: request.operationId })).toMatchObject({
      status: 'found',
      result: { status: 'accepted', disposition: 'created' },
    })
  })
  it('does not replay a submit after losing its final durable acknowledgement', async () => {
    const f = fixture()
    const save = f.deps.store.save
    f.deps.store.save = async record => {
      if (record.phase === 'finished') throw new Error('disk unavailable')
      await save(record)
    }
    expect(await f.service.createAndSubmit(request)).toMatchObject({ code: 'reconciliation-required' })
    expect(await new HostAgentTasks(f.deps).createAndSubmit(request)).toMatchObject({ code: 'reconciliation-required' })
    expect(f.deps.submit).toHaveBeenCalledTimes(1)
  })
  it('requires captured approvals before creation and retains the policy on plain replays', async () => {
    const f = fixture()
    expect(await f.service.createAndSubmit(request, 'required')).toMatchObject({ code: 'tool-unavailable' })
    expect(f.deps.create).not.toHaveBeenCalled()
    const installer = { active: () => true, install: vi.fn(async () => async () => {}) }
    const bound = new HostAgentTasks({ ...f.deps, captureApprovals: () => installer })
    expect(await bound.createAndSubmit(request, 'required')).toMatchObject({ status: 'accepted' })
    expect(installer.install).toHaveBeenCalledTimes(1)
    expect(await bound.createAndSubmit(request)).toMatchObject({ status: 'accepted', disposition: 'replayed' })
    const plain = fixture()
    await plain.service.createAndSubmit(request)
    expect(
      await new HostAgentTasks({ ...plain.deps, captureApprovals: () => installer }).createAndSubmit(
        request,
        'required',
      ),
    )
      .toMatchObject({ code: 'operation-conflict' })
  })
  it('recovers failed approval installation explicitly in one Session and shares concurrent recovery', async () => {
    const f = fixture()
    let current: import('@cordisx/protocol/agents/v1').Agent | undefined
    const create = f.deps.create
    const install = vi.fn().mockRejectedValueOnce(new Error('installation failed')).mockResolvedValue(async () => {})
    const service = new HostAgentTasks({
      ...f.deps,
      captureApprovals: () => ({ active: () => true, install }),
      create: async (input, record) => current = await create(input, record),
      existing: async () => current,
    })
    expect(await service.createAndSubmit(request, 'required')).toMatchObject({
      code: 'submit-failed',
      sessionId: expect.any(String),
    })
    expect(await service.createAndSubmit(request, 'required')).toMatchObject({ code: 'submit-failed' })
    expect(f.deps.submit).not.toHaveBeenCalled()
    const results = await Promise.all([
      service.recover({ operationId: 'task-1' }),
      service.recover({ operationId: 'task-1' }),
    ])
    expect(results[0]).toEqual(results[1])
    expect(results[0]).toMatchObject({ status: 'accepted' })
    expect(f.deps.create).toHaveBeenCalledTimes(1)
    expect(f.deps.submit).toHaveBeenCalledTimes(1)
    expect(install).toHaveBeenCalledTimes(2)
  })
  it('rechecks authority after the durable submitting checkpoint and never executes a revoked operation', async () => {
    const f = fixture()
    const save = f.deps.store.save
    f.deps.store.save = async record => {
      await save(record)
      if (record.phase === 'submitting') f.dispose()
    }
    expect(await f.service.createAndSubmit(request)).toMatchObject({ code: 'permission-denied' })
    expect(f.deps.submit).not.toHaveBeenCalled()
  })
  it.each(['context', 'creating', 'submitting'] as const)(
    'fences registration revocation during the final %s authority await',
    async stage => {
      const f = fixture()
      let live = true
      const cleanup = vi.fn(async () => {})
      const installer = { active: () => live, install: vi.fn(async () => cleanup) }
      if (stage === 'context') {
        vi.mocked(f.deps.resolveContext).mockImplementation(async () => {
          live = false
          return { status: 'resolved', context: { cwd: '/task' } }
        })
      } else {
        vi.mocked(f.deps.authorize).mockImplementation(async operation => {
          if (operation === 'approval' && f.phases.at(-1) === stage) live = false
          return true
        })
      }
      const service = new HostAgentTasks({ ...f.deps, captureApprovals: () => installer })
      expect(await service.createAndSubmit(request, 'required')).toMatchObject({ code: 'permission-denied' })
      expect(f.deps.create).toHaveBeenCalledTimes(stage === 'submitting' ? 1 : 0)
      expect(f.deps.submit).not.toHaveBeenCalled()
      expect(cleanup).toHaveBeenCalledTimes(stage === 'submitting' ? 1 : 0)
    },
  )
  it.each(['create', 'recover'] as const)(
    'rechecks exact authority for a concurrent %s caller after the shared result resolves',
    async mode => {
      const f = fixture()
      let current: Agent | undefined
      const create = f.deps.create
      const install = vi.fn().mockRejectedValueOnce(new Error('installation failed')).mockResolvedValue(async () => {})
      const service = new HostAgentTasks({
        ...f.deps,
        captureApprovals: () => ({ active: () => true, install }),
        create: async (input, record) => current = await create(input, record),
        existing: async () => current,
      })
      if (mode === 'recover') await service.createAndSubmit(request, 'required')
      let entered!: () => void, release!: () => void
      const atCheckpoint = new Promise<void>(resolve => {
        entered = resolve
      })
      const gate = new Promise<void>(resolve => {
        release = resolve
      })
      const save = f.deps.store.save
      f.deps.store.save = async record => {
        if (record.phase === 'finished' && record.result?.status === 'accepted') {
          entered()
          await gate
        }
        await save(record)
      }
      const start = () =>
        mode === 'create' ? service.createAndSubmit(request) : service.recover({ operationId: request.operationId })
      const first = start()
      await atCheckpoint
      vi.mocked(f.deps.authorize).mockImplementation(async (_operation, sessionId) => sessionId === undefined)
      const second = start()
      await Promise.resolve()
      await Promise.resolve()
      release()
      expect(await first).toMatchObject({ status: 'accepted' })
      expect(await second).toMatchObject({ status: 'unavailable', code: 'permission-denied' })
      expect(f.deps.authorize).toHaveBeenLastCalledWith('create', f.records.get(request.operationId)!.sessionId)
      expect(f.deps.create).toHaveBeenCalledTimes(1)
      expect(f.deps.submit).toHaveBeenCalledTimes(1)
    },
  )
  it('never exposes a handle before durable acceptance or grants ownership from read permission alone', async () => {
    const f = fixture()
    const handle = { agent: { id: 'real' } } as import('@cordisx/protocol/agents/v1').AgentHandle
    const ownership = vi.fn(async () => handle)
    const service = new HostAgentTasks({ ...f.deps, ownership })
    expect(await service.acquireOwnership({ operationId: 'task-1' })).toMatchObject({ code: 'not-found' })
    await service.createAndSubmit(request)
    expect(await service.acquireOwnership({ operationId: 'task-1' })).toEqual({ status: 'acquired', handle })
    vi.mocked(f.deps.authorize).mockImplementation(async operation => operation === 'read')
    expect(await service.acquireOwnership({ operationId: 'task-1' })).toMatchObject({ code: 'permission-denied' })
    expect(ownership).toHaveBeenCalledTimes(1)
  })
})
