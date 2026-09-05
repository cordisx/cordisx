import { describe, expect, it } from 'vitest'
import type { AgentOptions } from '@cordisx/protocol/agents/v1'

import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { PageAdmissionBindingRegistry } from '../packages/cli/src/renderer/page-admission-lifecycle.js'

const source = 'file:///plugins/chatroom/index.ts'
const pluginId = 'chatroom'
const generation = 'chatroom-generation-1'
const options: AgentOptions = {}

function pageBinding(
  lifecycle: PageAdmissionBindingRegistry,
  route: { readonly routeDefinitionId: string; readonly roomId?: string },
) {
  const abort = new AbortController()
  return {
    abort,
    binding: lifecycle.mount({
      owner: pluginId,
      source,
      moduleGeneration: generation,
      connectionGeneration: 'connection-1',
      route: { outlet: 'main', ...route },
      signal: abort.signal,
    }),
  }
}

function target(roomId: string, index: number) {
  return { roomId, participantId: `participant-${index}`, memberId: `member-${index}`, runId: `run-${index}` }
}

function runtime(
  lifecycle: PageAdmissionBindingRegistry,
  navigate?: Parameters<typeof CordisXAgentSessionRuntime>[0]['navigatePageAdmission'],
) {
  return new CordisXAgentSessionRuntime({
    driver: {
      create: async () => ({ status: 'accepted' }),
      resume: async () => ({ status: 'accepted' }),
      submit: async () => 'accepted',
      discard: async () => 'accepted',
      cancel: async () => 'accepted',
      onReplacement: () => () => {},
      dispose: () => {},
    },
    authorize: async () => true,
    pageAdmissionBindings: lifecycle,
    ...(navigate === undefined ? {} : { navigatePageAdmission: navigate }),
  })
}

async function createHandle(
  runtime: CordisXAgentSessionRuntime,
  owner: ReturnType<CordisXAgentSessionRuntime['ownerForPlugin']>,
  id: string,
) {
  const created = await runtime.create(owner, { sessionId: id, options })
  if (created.status !== 'accepted') throw new Error('fixture Agent creation failed')
  return created.handle
}

describe('page admission runtime', () => {
  it('derives an existing-Room all-accepted completion from actual one-shot submits', async () => {
    const lifecycle = new PageAdmissionBindingRegistry()
    const current = pageBinding(lifecycle, { routeDefinitionId: 'room', roomId: 'room-existing' })
    const agentRuntime = runtime(lifecycle)
    const owner = agentRuntime.ownerForPlugin(source, pluginId, generation)
    const context = agentRuntime.beginPageComposerCommand(owner, {
      binding: current.binding,
      route: { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-existing' },
      generation,
      commandId: 'room-submit',
      submitPayload: 'hello',
    })!
    for (const index of [0, 1, 2]) {
      const issued = await agentRuntime.issuePageAdmissionTarget(owner, {
        origin: context.origin,
        target: target('room-existing', index),
      })
      expect(issued.status).toBe('issued')
      if (issued.status !== 'issued') continue
      const handle = await createHandle(agentRuntime, owner, `session-existing-${index}`)
      const reserved = await agentRuntime.reservePageAdmissionTarget(owner, {
        handle,
        origin: issued.origin,
        message: { text: `hello-${index}` },
      })
      expect(reserved.status).toBe('reserved')
      if (reserved.status === 'reserved') {
        await expect(reserved.reservation.submit()).resolves.toMatchObject({ status: 'accepted' })
      }
    }
    expect(agentRuntime.finishPageComposerCommand(owner, context)).toMatchObject({
      status: 'accepted',
      code: 'submitted',
      roomId: 'room-existing',
      disposition: 'existing-room',
      deliveries: expect.arrayContaining([expect.objectContaining({ status: 'accepted' })]),
    })
  })

  it('reports a partial handler outcome without fabricating success', async () => {
    const lifecycle = new PageAdmissionBindingRegistry()
    const current = pageBinding(lifecycle, { routeDefinitionId: 'room', roomId: 'room-partial' })
    const agentRuntime = runtime(lifecycle)
    const owner = agentRuntime.ownerForPlugin(source, pluginId, generation)
    const context = agentRuntime.beginPageComposerCommand(owner, {
      binding: current.binding,
      route: { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-partial' },
      generation,
      commandId: 'room-submit',
      submitPayload: 'partial',
    })!
    const first = await agentRuntime.issuePageAdmissionTarget(owner, {
      origin: context.origin,
      target: target('room-partial', 0),
    })
    const second = await agentRuntime.issuePageAdmissionTarget(owner, {
      origin: context.origin,
      target: target('room-partial', 1),
    })
    if (first.status !== 'issued' || second.status !== 'issued') throw new Error('fixture target issue failed')
    const handle = await createHandle(agentRuntime, owner, 'session-partial')
    const reserved = await agentRuntime.reservePageAdmissionTarget(owner, {
      handle,
      origin: first.origin,
      message: { text: 'partial-first' },
    })
    if (reserved.status !== 'reserved') throw new Error('fixture reservation failed')
    await reserved.reservation.submit()
    expect(agentRuntime.finishPageComposerCommand(owner, context)).toMatchObject({
      status: 'failed',
      code: 'incomplete-submission',
      roomId: 'room-partial',
      deliveries: expect.arrayContaining([
        expect.objectContaining({ status: 'accepted' }),
        expect.objectContaining({ status: 'denied' }),
      ]),
    })
  })

  it('claims a fully submitted fresh Room before returning its navigation completion', async () => {
    const lifecycle = new PageAdmissionBindingRegistry()
    const current = pageBinding(lifecycle, { routeDefinitionId: 'new-room' })
    let agentRuntime!: CordisXAgentSessionRuntime
    const navigate = async () => {
      current.abort.abort()
      const destination = pageBinding(lifecycle, { routeDefinitionId: 'room', roomId: 'room-fresh' })
      expect(agentRuntime.claimPageAdmissionBinding(destination.binding)).toHaveLength(2)
      return 'accepted' as const
    }
    agentRuntime = runtime(lifecycle, navigate)
    const owner = agentRuntime.ownerForPlugin(source, pluginId, generation)
    const context = agentRuntime.beginPageComposerCommand(owner, {
      binding: current.binding,
      route: { outlet: 'main', routeDefinitionId: 'new-room' },
      generation,
      commandId: 'room-submit',
      submitPayload: 'fresh',
    })!
    for (const index of [0, 1]) {
      const issued = await agentRuntime.declarePageAdmissionRoute(owner, {
        origin: context.origin,
        target: {
          ...target('room-fresh', index),
          route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-fresh' },
        },
      })
      if (issued.status !== 'declared') throw new Error('fixture route declaration failed')
      const handle = await createHandle(agentRuntime, owner, `session-fresh-${index}`)
      const reserved = await agentRuntime.reservePageAdmissionRoute(owner, {
        handle,
        continuation: issued.continuation,
        message: { text: `fresh-${index}` },
      })
      if (reserved.status !== 'reserved') throw new Error('fixture route reservation failed')
      await reserved.reservation.submit()
    }
    if (context.freshRoomNavigation === undefined) throw new Error('fresh navigation permit is absent')
    await expect(agentRuntime.navigatePageAdmission(owner, {
      navigation: context.freshRoomNavigation,
      route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-fresh' },
    })).resolves.toMatchObject({ status: 'accepted', code: 'claimed', roomId: 'room-fresh' })
    expect(agentRuntime.finishPageComposerCommand(owner, context)).toMatchObject({
      status: 'accepted',
      code: 'submitted',
      roomId: 'room-fresh',
      disposition: 'fresh-room',
    })
  })
})
