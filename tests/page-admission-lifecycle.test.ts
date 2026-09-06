import { describe, expect, it } from 'vitest'
import {
  type PageAdmissionBinding,
  PageAdmissionBindingRegistry,
  type PageAdmissionDestinationRoute,
  type PageAdmissionTarget,
} from '../packages/cli/src/renderer/page-admission-lifecycle.js'

const owner = 'chatroom'
const source = 'file:///plugins/chatroom/index.ts'
const generation = 'chatroom-generation-1'
const connection = 'connection-1'

function mount(
  registry: PageAdmissionBindingRegistry,
  route: { readonly outlet: string; readonly routeDefinitionId: string; readonly roomId?: string },
): { readonly binding: PageAdmissionBinding; readonly abort: AbortController } {
  const abort = new AbortController()
  return {
    binding: registry.mount({
      owner,
      source,
      moduleGeneration: generation,
      connectionGeneration: connection,
      route,
      signal: abort.signal,
    }),
    abort,
  }
}

function target(roomId: string, index: number): PageAdmissionTarget {
  return {
    roomId,
    participantId: `participant-${index}`,
    memberId: `member-${index}`,
    runId: `run-${index}`,
  }
}

function destination(roomId: string): PageAdmissionDestinationRoute {
  return { outlet: 'main', routeDefinitionId: 'room', param: 'roomId', roomId }
}

function captureAccepted(
  registry: PageAdmissionBindingRegistry,
  declaration: ReturnType<PageAdmissionBindingRegistry['declare']> extends infer Value ? Exclude<Value, undefined>
    : never,
  source: { readonly sessionId: string; readonly messageId: string },
): void {
  expect(registry.capture(declaration, source)).toBe(true)
  expect(registry.accept(declaration, source)).toBe(true)
}

describe('page admission binding lifecycle', () => {
  it('requires one exact pre-submit capture before it can mark a delivery accepted', () => {
    const registry = new PageAdmissionBindingRegistry()
    const current = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-existing' })
    const command = registry.begin(current.binding, 'chatroom:room-submit')!
    const declaration = registry.declare(command, target('room-existing', 0))!
    const source = { sessionId: 'session-captured', messageId: 'message-captured' }
    expect(registry.reserve(declaration)).toBe(true)
    expect(registry.accept(declaration, source)).toBe(false)
    expect(registry.capture(declaration, source)).toBe(true)
    expect(registry.capture(declaration, source)).toBe(false)
    expect(registry.accept(declaration, { sessionId: source.sessionId, messageId: 'message-other' })).toBe(false)
    expect(registry.accept(declaration, source)).toBe(true)
    expect(registry.completion(command)).toMatchObject({ status: 'accepted', roomId: 'room-existing' })
  })

  it('keeps N=1/2/3 exact existing-Room captures only on the still-live page binding', () => {
    for (const count of [1, 2, 3]) {
      const registry = new PageAdmissionBindingRegistry()
      const current = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-existing' })
      const command = registry.begin(current.binding, 'chatroom:room-submit')!
      const declarations = Array.from({ length: count }, (_, index) => {
        const declaration = registry.declare(command, target('room-existing', index))!
        expect(registry.reserve(declaration)).toBe(true)
        captureAccepted(registry, declaration, {
          sessionId: `session-${index}`,
          messageId: `message-${index}`,
        })
        return declaration
      })
      registry.complete(command)

      expect(registry.captures(current.binding)).toEqual(declarations.map((declaration, index) => ({
        declaration,
        source: { sessionId: `session-${index}`, messageId: `message-${index}` },
      })))
      const completion = registry.completion(command)
      expect(completion).toMatchObject({
        status: 'accepted',
        roomId: 'room-existing',
        disposition: 'existing-room',
      })
      if (completion.status === 'accepted') expect(completion.deliveries).toHaveLength(count)
      expect(registry.reserve(declarations[0]!)).toBe(false)
      current.abort.abort()
      expect(registry.captures(current.binding)).toEqual([])
    }
  })

  it('moves N=1/2/3 accepted fresh-Room captures only at the matching same-owner route activation', () => {
    for (const count of [1, 2, 3]) {
      const registry = new PageAdmissionBindingRegistry()
      const fresh = mount(registry, { outlet: 'main', routeDefinitionId: 'new-room' })
      const command = registry.begin(fresh.binding, 'chatroom:room-submit')!
      const declarations = Array.from({ length: count }, (_, index) => {
        const declaration = registry.declare(command, target('room-fresh', index), destination('room-fresh'))!
        expect(registry.reserve(declaration)).toBe(true)
        captureAccepted(registry, declaration, {
          sessionId: `session-fresh-${index}`,
          messageId: `message-fresh-${index}`,
        })
        return declaration
      })
      const wrong = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-wrong' })
      fresh.abort.abort()
      expect(registry.claim(wrong.binding)).toEqual([])
      expect(registry.captures(wrong.binding)).toEqual([])
      wrong.abort.abort()

      const destinationBinding = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-fresh' })
      expect(registry.claim(destinationBinding.binding)).toEqual(declarations.map((declaration, index) => ({
        declaration,
        source: { sessionId: `session-fresh-${index}`, messageId: `message-fresh-${index}` },
      })))
      expect(registry.captures(destinationBinding.binding)).toHaveLength(count)
      registry.complete(command)
      const completion = registry.completion(command)
      expect(completion).toMatchObject({
        status: 'accepted',
        roomId: 'room-fresh',
        disposition: 'fresh-room',
      })
      if (completion.status === 'accepted') expect(completion.deliveries).toHaveLength(count)
      expect(registry.claim(destinationBinding.binding)).toEqual([])
      destinationBinding.abort.abort()
      expect(registry.captures(destinationBinding.binding)).toEqual([])
    }
  })

  it('rejects duplicate targets and fences fresh continuations on owner or connection replacement', () => {
    const registry = new PageAdmissionBindingRegistry()
    const fresh = mount(registry, { outlet: 'main', routeDefinitionId: 'new-room' })
    const command = registry.begin(fresh.binding, 'chatroom:room-submit')!
    const declared = registry.declare(command, target('room-fresh', 0), destination('room-fresh'))!
    expect(registry.declare(command, target('room-fresh', 0), destination('room-fresh'))).toBeUndefined()
    expect(registry.reserve(declared)).toBe(true)
    captureAccepted(registry, declared, { sessionId: 'session-fresh', messageId: 'message-fresh' })
    registry.fenceConnection('connection-replaced')
    fresh.abort.abort()

    const destinationBinding = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-fresh' })
    expect(registry.claim(destinationBinding.binding)).toEqual([])
    registry.fenceOwner(owner, source, generation)
    expect(registry.captures(destinationBinding.binding)).toEqual([])
  })

  it('requires the fresh claim before command completion and rejects partial fresh submissions on source release', () => {
    const registry = new PageAdmissionBindingRegistry()
    const fresh = mount(registry, { outlet: 'main', routeDefinitionId: 'new-room' })
    const command = registry.begin(fresh.binding, 'chatroom:room-submit')!
    const first = registry.declare(command, target('room-fresh', 0), destination('room-fresh'))!
    const second = registry.declare(command, target('room-fresh', 1), destination('room-fresh'))!
    expect(registry.reserve(first)).toBe(true)
    captureAccepted(registry, first, { sessionId: 'session-first', messageId: 'message-first' })
    fresh.abort.abort()

    const destinationBinding = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-fresh' })
    expect(registry.claim(destinationBinding.binding)).toEqual([])
    expect(registry.reserve(second)).toBe(false)
    expect(registry.completion(command)).toMatchObject({ status: 'failed', code: 'incomplete-submission' })

    const secondRun = mount(registry, { outlet: 'main', routeDefinitionId: 'new-room' })
    const secondCommand = registry.begin(secondRun.binding, 'chatroom:room-submit')!
    const declared = registry.declare(secondCommand, target('room-second', 0), destination('room-second'))!
    expect(registry.reserve(declared)).toBe(true)
    captureAccepted(registry, declared, { sessionId: 'session-second', messageId: 'message-second' })
    registry.complete(secondCommand)
    secondRun.abort.abort()
    const secondDestination = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-second' })
    expect(registry.claim(secondDestination.binding)).toEqual([])
    expect(registry.completion(secondCommand)).toMatchObject({ status: 'failed', code: 'claim-failed' })
  })

  it('activates a destination binding before a caller may complete its fresh command', async () => {
    const registry = new PageAdmissionBindingRegistry()
    const fresh = mount(registry, { outlet: 'main', routeDefinitionId: 'new-room' })
    const command = registry.begin(fresh.binding, 'chatroom:room-submit')!
    const declared = registry.declare(command, target('room-fresh', 0), destination('room-fresh'))!
    expect(registry.reserve(declared)).toBe(true)
    captureAccepted(registry, declared, { sessionId: 'session-fresh', messageId: 'message-fresh' })
    const phases: string[] = []
    registry.subscribeActivation(binding => {
      phases.push('claim')
      expect(registry.claim(binding)).toHaveLength(1)
    })
    fresh.abort.abort()
    const destinationBinding = mount(registry, { outlet: 'main', routeDefinitionId: 'room', roomId: 'room-fresh' })
    await registry.activate(destinationBinding.binding)
    phases.push('complete')
    registry.complete(command)

    expect(phases).toEqual(['claim', 'complete'])
    expect(registry.captures(destinationBinding.binding)).toHaveLength(1)
  })
})
