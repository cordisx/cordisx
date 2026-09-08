import { mkdtemp, readdir, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AgentLoopAuthority } from '../packages/cli/src/launcher/agent-loop-authority.js'
import { ProviderFleet } from '../packages/cli/src/providers/fleet.js'
import type { AgentLoopTaskBinding } from '@cordisx/protocol/agent-loop/v4'
import type { AgentLoopControlledTurnV1 } from '@cordisx/protocol/agent-loop-control/v1'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close()
})
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-controlled-loop-'))
  const authority = await AgentLoopAuthority.open(root, 'work')
  const calls: { method: string; params: Record<string, unknown> }[] = []
  let notify: ((method: string, params: unknown) => void) | undefined
  let session = 0, turn = 0
  const fleet = await ProviderFleet.create([{
    id: 'codex-local',
    kind: 'local-codex',
    sourceProviderId: 'openai',
    displayName: 'Local',
    codexExecutable: 'codex',
    codexHome: path.join(root, 'codex'),
    enabled: true,
    timeoutMs: 1000,
  }], {
    agentLoopAuthority: authority,
    startServer: async () => ({
      generation: 'provider-1',
      async request<Result>(method: string, params: unknown): Promise<Result> {
        calls.push({ method, params: params as Record<string, unknown> })
        if (method === 'thread/start') {
          return {
            thread: {
              id: `session-${++session}`,
              preview: '',
              modelProvider: 'openai',
              createdAt: 1,
              updatedAt: 1,
              cwd: (params as { cwd: string }).cwd,
              turns: [],
            },
          } as Result
        }
        if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } } as Result
        if (method === 'turn/interrupt') return {} as Result
        throw new Error(`unexpected ${method}`)
      },
      subscribeNotifications(listener) {
        notify = listener
        return () => {
          notify = undefined
        }
      },
      async close() {},
    }),
  })
  cleanup.push(async () => {
    await fleet.close()
    await rm(root, { recursive: true, force: true })
  })
  const scope = { profileId: 'work', compositionGeneration: 'renderer-1', ownerKey: 'owner-1' }
  const create = async (id: string, game = true) => {
    const value = await fleet.createAgentLoopV4({
      scope,
      operationId: id,
      command: { type: 'create-or-bind', commandId: id },
      definition: { agentId: 'agent', revision: '1' },
      model: { providerId: 'codex-local', modelId: 'model' },
      cwd: '/user-project',
      ...(game ? { workspaceCategory: 'game' as const } : {}),
    }) as {
      status: string
      locator: {
        task: string
        binding: AgentLoopTaskBinding['binding']
        definition: AgentLoopTaskBinding['definition']
      }
    }
    expect(value.status).toBe('accepted')
    return {
      contract: 'cordisx.agent-loop-task-binding/v4',
      schemaVersion: 4,
      task: value.locator.task,
      binding: value.locator.binding,
      definition: value.locator.definition,
      state: 'active',
    } as AgentLoopTaskBinding
  }
  const submit = async (binding: AgentLoopTaskBinding, commandId: string, ms = 3000) => {
    const request = {
      commandId,
      binding,
      content: [{ kind: 'text', text: 'Choose an action' }],
      deadline: Date.now() + ms,
    }
    const value = await fleet.controlAgentLoop({ scope, action: 'submit', value: request }) as {
      status: string
      value: AgentLoopControlledTurnV1
    }
    expect(value.status).toBe('accepted')
    return { target: value.value, request }
  }
  return { fleet, scope, calls, create, submit, notify: (method: string, params: unknown) => notify?.(method, params) }
}
describe('controlled AgentLoop through Fleet and local provider adapter', () => {
  it('allocates independent empty game directories while retaining general v4 cwd behavior', async () => {
    const f = await fixture()
    await f.create('game-one')
    await f.create('game-two')
    await f.create('ordinary', false)
    const creates = f.calls.filter(call => call.method === 'thread/start')
    const first = creates[0]!.params.cwd as string, second = creates[1]!.params.cwd as string
    expect(first).not.toBe(second)
    expect(first).toContain('/game-workspaces/')
    expect(await readdir(first)).toEqual([])
    expect(creates[2]!.params.cwd).toBe('/user-project')
    expect(creates[0]!.params.approvalPolicy).toBe('on-request')
  })
  it('replays the same submit and cancels the exact turn, refusing another owner or forged target', async () => {
    const f = await fixture(), binding = await f.create('game')
    const { target, request } = await f.submit(binding, 'submit')
    expect(await f.fleet.controlAgentLoop({ scope: f.scope, action: 'submit', value: request })).toMatchObject({
      status: 'accepted',
      value: target,
    })
    expect(f.calls.filter(call => call.method === 'turn/start')).toHaveLength(1)
    const cancel = { commandId: 'cancel', target }
    expect(
      await f.fleet.controlAgentLoop({ scope: { ...f.scope, ownerKey: 'other' }, action: 'cancel', value: cancel }),
    ).toMatchObject({ status: 'unavailable' })
    expect(
      await f.fleet.controlAgentLoop({
        scope: f.scope,
        action: 'cancel',
        value: { ...cancel, target: { ...target, turn: 'other-turn' } },
      }),
    ).toMatchObject({ status: 'unavailable' })
    expect(
      await f.fleet.controlAgentLoop({
        scope: f.scope,
        action: 'cancel',
        value: { ...cancel, commandId: 'valid-cancel' },
      }),
    ).toMatchObject({ status: 'accepted', value: { outcome: 'cancelled' } })
    expect(f.calls.filter(call => call.method === 'turn/interrupt')).toEqual([{
      method: 'turn/interrupt',
      params: { threadId: 'session-1', turnId: target.turn },
    }])
    expect(await f.fleet.controlAgentLoop({ scope: f.scope, action: 'read', value: target })).toMatchObject({
      value: { state: 'cancelled' },
    })
  })
  it('interrupts at its Host deadline without renderer polling', async () => {
    const f = await fixture(), binding = await f.create('game')
    const { target } = await f.submit(binding, 'deadline', 100)
    await new Promise(resolve => setTimeout(resolve, 160))
    expect(f.calls.some(call => call.method === 'turn/interrupt' && call.params.turnId === target.turn)).toBe(true)
    expect(await f.fleet.controlAgentLoop({ scope: f.scope, action: 'read', value: target })).toMatchObject({
      value: { state: 'deadline-exceeded' },
    })
  })
  it('recognizes provider completion and never interrupts an unrelated later turn', async () => {
    const f = await fixture(), binding = await f.create('game')
    const { target } = await f.submit(binding, 'complete')
    f.notify('turn/completed', { threadId: 'session-1', turn: { id: target.turn, status: 'completed' } })
    expect(await f.fleet.controlAgentLoop({ scope: f.scope, action: 'read', value: target })).toMatchObject({
      value: { state: 'completed' },
    })
    expect(
      await f.fleet.controlAgentLoop({ scope: f.scope, action: 'cancel', value: { commandId: 'late-cancel', target } }),
    ).toMatchObject({ value: { outcome: 'already-terminal' } })
    expect(f.calls.some(call => call.method === 'turn/interrupt')).toBe(false)
  })
})
