import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'

import { CordisXAgentSessionRuntime } from '../packages/cli/src/renderer/agent-session-runtime.js'
import { CommandRegistry, CordisXCommandService } from '../packages/cli/src/renderer/commands.js'
import { createPageComposerAdapter } from '../packages/cli/src/renderer/page-admission-adapter.js'
import { PageAdmissionBindingRegistry } from '../packages/cli/src/renderer/page-admission-lifecycle.js'

const source = 'file:///plugins/chatroom/index.ts'
const ownerId = 'chatroom'
const generation = 'chatroom-generation-1'

function setup(route: { readonly routeDefinitionId: string; readonly roomId?: string }) {
  const lifecycle = new PageAdmissionBindingRegistry()
  const abort = new AbortController()
  const binding = lifecycle.mount({
    owner: ownerId,
    source,
    moduleGeneration: generation,
    connectionGeneration: 'connection-1',
    route: { outlet: 'main', ...route },
    signal: abort.signal,
  })
  const runtime = new CordisXAgentSessionRuntime({
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
  })
  const owner = runtime.ownerForPlugin(source, ownerId, generation)
  const registry = new CommandRegistry()
  const commands = new CordisXCommandService(new Context(), { registry })
  return { lifecycle, abort, binding, runtime, owner, registry, commands }
}

const pageRequest = (submitPayload: string) => ({
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-request.v1.schema.json' as const,
  contract: 'cordisx.agent-page-composer-command-request/v1' as const,
  schemaVersion: 1 as const,
  command: { id: 'room-submit' },
  submitPayload,
})

const pageContext = (
  value: unknown,
): value is import('@cordisx/protocol/agent-page-admission/v2').AgentPageComposerCommandContext =>
  value !== null && typeof value === 'object' && 'contract' in value
  && value.contract === 'cordisx.agent-page-composer-command-context/v2'

describe('page admission command adapter', () => {
  it('injects one typed page hostContext and returns Host-derived all-target completion', async () => {
    for (const count of [1, 2, 3]) {
      const value = setup({ routeDefinitionId: 'room', roomId: 'room-existing' })
      const agents = await Promise.all(Array.from({ length: count }, async (_, index) => {
        const agent = await value.runtime.create(value.owner, { sessionId: `session-existing-${index}`, options: {} })
        if (agent.status !== 'accepted') throw new Error('fixture Agent creation failed')
        return agent.handle
      }))
      const contexts: unknown[] = []
      value.registry.register(ownerId, {
        id: 'room-submit',
        title: { key: 'room.submit', fallback: 'Submit Room' },
      }, async context => {
        contexts.push(context.hostContext)
        if (!pageContext(context.hostContext)) throw new Error('typed page context missing')
        for (const [index, agent] of agents.entries()) {
          const issued = await value.runtime.issuePageAdmissionTarget(value.owner, {
            origin: context.hostContext.origin,
            target: {
              roomId: 'room-existing',
              participantId: `participant-${index}`,
              memberId: `member-${index}`,
              runId: `run-${index}`,
            },
          })
          if (issued.status !== 'issued') throw new Error('target issue failed')
          const reserved = await value.runtime.reservePageAdmissionTarget(value.owner, {
            handle: agent,
            origin: issued.origin,
            message: { text: context.hostContext.submitPayload },
          })
          if (reserved.status !== 'reserved') throw new Error('reservation failed')
          await reserved.reservation.submit()
        }
      })
      const adapter = createPageComposerAdapter({
        ownerId,
        owner: value.owner,
        binding: value.binding,
        route: { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-existing' },
        generation,
        signal: value.abort.signal,
        runtime: value.runtime,
        commands: value.commands,
      })

      const result = await adapter.execute(pageRequest('typed payload'))
      expect(result).toMatchObject({
        status: 'accepted',
        code: 'submitted',
        roomId: 'room-existing',
        disposition: 'existing-room',
      })
      if (result.status === 'accepted') expect(result.deliveries).toHaveLength(count)
      expect(contexts).toHaveLength(1)
      expect(pageContext(contexts[0])).toBe(true)
    }
  })

  it('does not turn a handler error into dispatched success and retains page availability for a retry decision', async () => {
    const value = setup({ routeDefinitionId: 'room', roomId: 'room-failed' })
    value.registry.register(ownerId, {
      id: 'room-submit',
      title: { key: 'room.submit', fallback: 'Submit Room' },
    }, async () => {
      throw new Error('target reservation failed')
    })
    const adapter = createPageComposerAdapter({
      ownerId,
      owner: value.owner,
      binding: value.binding,
      route: { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-failed' },
      generation,
      signal: value.abort.signal,
      runtime: value.runtime,
      commands: value.commands,
    })

    await expect(adapter.execute(pageRequest('failed payload'))).resolves.toMatchObject({
      status: 'failed',
      code: 'handler-failed',
    })
    expect(value.abort.signal.aborted).toBe(false)
  })

  it('waits for fresh navigation claim before resolving the adapter completion', async () => {
    for (const count of [1, 2, 3]) {
      const lifecycle = new PageAdmissionBindingRegistry()
      const sourceAbort = new AbortController()
      const sourceBinding = lifecycle.mount({
        owner: ownerId,
        source,
        moduleGeneration: generation,
        connectionGeneration: 'connection-1',
        route: { outlet: 'main', routeDefinitionId: 'new-room' },
        signal: sourceAbort.signal,
      })
      let runtime!: CordisXAgentSessionRuntime
      runtime = new CordisXAgentSessionRuntime({
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
        navigatePageAdmission: async () => {
          sourceAbort.abort()
          const destinationAbort = new AbortController()
          const destination = lifecycle.mount({
            owner: ownerId,
            source,
            moduleGeneration: generation,
            connectionGeneration: 'connection-1',
            route: { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-fresh' },
            signal: destinationAbort.signal,
          })
          expect(runtime.claimPageAdmissionBinding(destination)).toHaveLength(count)
          return 'accepted'
        },
      })
      const owner = runtime.ownerForPlugin(source, ownerId, generation)
      const agents = await Promise.all(Array.from({ length: count }, async (_, index) => {
        const created = await runtime.create(owner, { sessionId: `session-fresh-${index}`, options: {} })
        if (created.status !== 'accepted') throw new Error('fixture Agent creation failed')
        return created.handle
      }))
      const registry = new CommandRegistry()
      const commands = new CordisXCommandService(new Context(), { registry })
      registry.register(ownerId, {
        id: 'room-submit',
        title: { key: 'room.submit', fallback: 'Submit Room' },
      }, async context => {
        if (!pageContext(context.hostContext) || context.hostContext.freshRoomNavigation === undefined) {
          throw new Error('fresh page context missing')
        }
        for (const [index, agent] of agents.entries()) {
          const declared = await runtime.declarePageAdmissionRoute(owner, {
            origin: context.hostContext.origin,
            target: {
              roomId: 'room-fresh',
              participantId: `participant-${index}`,
              memberId: `member-${index}`,
              runId: `run-fresh-${index}`,
              route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-fresh' },
            },
          })
          if (declared.status !== 'declared') throw new Error('fresh declaration failed')
          const reserved = await runtime.reservePageAdmissionRoute(owner, {
            handle: agent,
            continuation: declared.continuation,
            message: { text: context.hostContext.submitPayload },
          })
          if (reserved.status !== 'reserved') throw new Error('fresh reservation failed')
          await reserved.reservation.submit()
        }
        const navigated = await runtime.navigatePageAdmission(owner, {
          navigation: context.hostContext.freshRoomNavigation,
          route: { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId: 'room-fresh' },
        })
        if (navigated.status !== 'accepted') throw new Error('fresh navigation claim failed')
      })
      const adapter = createPageComposerAdapter({
        ownerId,
        owner,
        binding: sourceBinding,
        route: { outlet: 'main', routeDefinitionId: 'new-room' },
        generation,
        signal: sourceAbort.signal,
        runtime,
        commands,
      })

      const result = await adapter.execute(pageRequest('fresh payload'))
      expect(result).toMatchObject({
        status: 'accepted',
        code: 'submitted',
        roomId: 'room-fresh',
        disposition: 'fresh-room',
      })
      if (result.status === 'accepted') expect(result.deliveries).toHaveLength(count)
    }
  })
})
