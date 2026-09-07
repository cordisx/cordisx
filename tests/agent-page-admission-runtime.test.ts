import { describe, expect, it } from 'vitest'
import type { AgentOptions } from '@cordisx/protocol/agents/v1'
import type { AgentRuntimeRouteScope } from '../packages/cli/src/renderer/platform.js'

import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { PageAdmissionBindingRegistry } from '../packages/cli/src/renderer/page-admission-lifecycle.js'
import { PlaygroundScenarioSessionScopeAuthority } from '../packages/cli/src/renderer/playground-scenario-session-scope.js'

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

  it('fences a reserved page delivery before driver submit when its source page is replaced', async () => {
    const lifecycle = new PageAdmissionBindingRegistry()
    const current = pageBinding(lifecycle, { routeDefinitionId: 'new-room' })
    let submits = 0
    const agentRuntime = new CordisXAgentSessionRuntime({
      driver: {
        create: async () => ({ status: 'accepted' }),
        resume: async () => ({ status: 'accepted' }),
        submit: async () => {
          submits += 1
          return 'accepted'
        },
        discard: async () => 'accepted',
        cancel: async () => 'accepted',
        onReplacement: () => () => {},
        dispose: () => {},
      },
      authorize: async () => true,
      pageAdmissionBindings: lifecycle,
    })
    const owner = agentRuntime.ownerForPlugin(source, pluginId, generation)
    const context = agentRuntime.beginPageComposerCommand(owner, {
      binding: current.binding,
      route: { outlet: 'main', routeDefinitionId: 'new-room' },
      generation,
      commandId: 'room-submit',
      submitPayload: 'fenced before submit',
    })!
    const declaration = await agentRuntime.declarePageAdmissionRoute(owner, {
      origin: context.origin,
      target: {
        ...target('room-replaced', 0),
        route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-replaced' },
      },
    })
    if (declaration.status !== 'declared') throw new Error('fresh page declaration failed')
    const handle = await createHandle(agentRuntime, owner, 'session-replaced-before-submit')
    const reserved = await agentRuntime.reservePageAdmissionRoute(owner, {
      handle,
      continuation: declaration.continuation,
      message: { text: context.submitPayload },
    })
    if (reserved.status !== 'reserved') throw new Error('fresh page reservation failed')
    current.abort.abort()
    await expect(reserved.reservation.submit()).rejects.toThrow('page admission reservation unavailable')
    expect(submits).toBe(0)
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

  it('captures a fresh page source before submit, claims it at route activation, then activates its exact scenario Session scope', async () => {
    const lifecycle = new PageAdmissionBindingRegistry()
    const sourcePage = pageBinding(lifecycle, { routeDefinitionId: 'new-room' })
    const sourceSessionId = 'cx-session.page-fresh-lead'
    const targetSessionId = 'cx-session.page-fresh-reviewer'
    let mounted: AgentRuntimeRouteScope | undefined
    let pageOwner: ReturnType<CordisXAgentSessionRuntime['ownerForPlugin']> | undefined
    let destination: ReturnType<typeof pageBinding> | undefined
    let agentRuntime!: CordisXAgentSessionRuntime
    const order: string[] = []
    const authority = new PlaygroundScenarioSessionScopeAuthority({
      hostGeneration: 'page-admission-scenario-host',
      connectionGeneration: () => 1,
      currentRoute: () => undefined,
      ownerForSession: sessionId =>
        pageOwner !== undefined && [sourceSessionId, targetSessionId].includes(sessionId) ? pageOwner : undefined,
      routeOwner: owner =>
        pageOwner !== undefined && owner.pluginId === pageOwner.pluginId && owner.generation === pageOwner.generation
          ? { source, pluginId }
          : undefined,
      permissionRoute: () => ({
        routeId: 'room-session-detail',
        path: '/main/chatroom/:roomId/run/:runId/session/:sessionId',
      }),
      authorize: async () => true,
      mountRoute: route => {
        mounted = route
        return () => {
          mounted = undefined
        }
      },
      changed: () => {},
    })
    agentRuntime = new CordisXAgentSessionRuntime({
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
      capturePageAdmission: (
        owner,
        origin,
        target,
        sessionId,
        agentGeneration,
        messageId,
        commandActive,
        originActive,
      ) =>
        authority.capturePageAdmission(
          owner,
          origin,
          target,
          sessionId,
          agentGeneration,
          messageId,
          commandActive,
          originActive,
        ),
      claimPageAdmission: (owner, receipt, bindingActive) => {
        order.push('scope-claim')
        return authority.claimPageAdmission(owner, receipt, bindingActive)
      },
      navigatePageAdmission: async () => {
        sourcePage.abort.abort()
        destination = pageBinding(lifecycle, { routeDefinitionId: 'room', roomId: 'room-page-fresh' })
        const claims = agentRuntime.claimPageAdmissionBinding(destination.binding)
        expect(order).toEqual(['submitted', 'scope-claim'])
        expect(claims).toHaveLength(1)
        order.push('navigation-resolve')
        return 'accepted'
      },
    })
    const owner = agentRuntime.ownerForPlugin(source, pluginId, generation)
    pageOwner = owner
    const sourceHandle = await createHandle(agentRuntime, owner, sourceSessionId)
    await createHandle(agentRuntime, owner, targetSessionId)
    const context = agentRuntime.beginPageComposerCommand(owner, {
      binding: sourcePage.binding,
      route: { outlet: 'main', routeDefinitionId: 'new-room' },
      generation,
      commandId: 'room-submit',
      submitPayload: 'fresh page scenario source',
    })!
    const declared = await agentRuntime.declarePageAdmissionRoute(owner, {
      origin: context.origin,
      target: {
        ...target('room-page-fresh', 0),
        route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-page-fresh' },
      },
    })
    if (declared.status !== 'declared') throw new Error('fresh page declaration was denied')
    const reserved = await agentRuntime.reservePageAdmissionRoute(owner, {
      handle: sourceHandle,
      continuation: declared.continuation,
      message: { text: context.submitPayload },
    })
    if (reserved.status !== 'reserved') throw new Error('fresh page reservation was denied')
    const submitted = await reserved.reservation.submit()
    order.push('submitted')
    if (context.freshRoomNavigation === undefined) throw new Error('fresh page navigation is absent')
    await expect(agentRuntime.navigatePageAdmission(owner, {
      navigation: context.freshRoomNavigation,
      route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-page-fresh' },
    })).resolves.toMatchObject({ status: 'accepted', code: 'claimed' })
    expect(agentRuntime.finishPageComposerCommand(owner, context)).toMatchObject({
      status: 'accepted',
      disposition: 'fresh-room',
      roomId: 'room-page-fresh',
    })
    const activated = await authority.client.activate({
      runId: 'scenario-page-fresh',
      sourceSessionId,
      sourceMessageId: submitted.messageId,
      targetSessionId,
    })
    order.push('scenario-activate')
    expect(activated.status).toBe('available')
    expect(order).toEqual(['submitted', 'scope-claim', 'navigation-resolve', 'scenario-activate'])
    expect(mounted?.params).toEqual({ sessionId: targetSessionId })
    destination?.abort.abort()
    if (activated.status === 'available') {
      authority.reconcileVisibleRoute()
      await expect(activated.handle.closed).resolves.toEqual({ code: 'route-replaced' })
    }
    await agentRuntime.dispose()
    authority.dispose()
  })
})

it('counts composer and reservation text as Unicode code points at the declared boundary', async () => {
  const lifecycle = new PageAdmissionBindingRegistry()
  const current = pageBinding(lifecycle, { routeDefinitionId: 'room', roomId: 'unicode' })
  const agentRuntime = runtime(lifecycle)
  const owner = agentRuntime.ownerForPlugin(source, pluginId, generation)
  const text = '😀'.repeat(65_536)
  const input = {
    binding: current.binding,
    route: { outlet: 'main' as const, routeDefinitionId: 'room', roomId: 'unicode' },
    generation,
    commandId: 'room-submit',
    submitPayload: text,
  }
  expect(agentRuntime.beginPageComposerCommand(owner, { ...input, submitPayload: text + 'x' })).toBeUndefined()
  const context = agentRuntime.beginPageComposerCommand(owner, input)
  expect(context !== undefined).toBe(true)
  const issued = await agentRuntime.issuePageAdmissionTarget(owner, {
    origin: context!.origin,
    target: target('unicode', 0),
  })
  if (issued.status !== 'issued') throw new Error('target not issued')
  const handle = await createHandle(agentRuntime, owner, 'unicode-session')
  const tooLong = await agentRuntime.reservePageAdmissionTarget(owner, {
    handle,
    origin: issued.origin,
    message: { text: text + 'x' },
  })
  expect(tooLong.status).not.toBe('reserved')
  const valid = await agentRuntime.reservePageAdmissionTarget(owner, {
    handle,
    origin: issued.origin,
    message: { text },
  })
  expect(valid.status).toBe('reserved')
  if (valid.status === 'reserved') expect((await valid.reservation.submit()).status).toBe('accepted')
  await agentRuntime.dispose()
})
