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
      expect(phases.at(-1)).toBe('binding')
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
})
