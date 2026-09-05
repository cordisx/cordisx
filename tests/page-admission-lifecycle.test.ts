import { describe, expect, it } from 'vitest'
import {
  PageAdmissionBindingRegistry,
  type PageAdmissionBinding,
  type PageAdmissionDestinationRoute,
  type PageAdmissionTarget,
} from '../packages/cli/src/renderer/page-admission-lifecycle.js'

const owner = 'chatroom'
const source = 'file:///plugins/chatroom/index.ts'
const generation = 'chatroom-generation-1'
const connection = 'connection-1'

function mount(
  registry: PageAdmissionBindingRegistry,
  route: { readonly outlet: string; readonly routeId: string; readonly roomId?: string },
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
  return { outlet: 'main', routeId: 'room', param: 'roomId', roomId }
}

describe('page admission binding lifecycle', () => {
  it('keeps N=1/2/3 exact existing-Room captures only on the still-live page binding', () => {
    for (const count of [1, 2, 3]) {
      const registry = new PageAdmissionBindingRegistry()
      const current = mount(registry, { outlet: 'main', routeId: 'room', roomId: 'room-existing' })
      const command = registry.begin(current.binding, 'chatroom:room-submit')!
      const declarations = Array.from({ length: count }, (_, index) => {
        const declaration = registry.declare(command, target('room-existing', index))!
        expect(registry.reserve(declaration)).toBe(true)
        expect(registry.accept(declaration, {
          sessionId: `session-${index}`,
          messageId: `message-${index}`,
        })).toBe(true)
        return declaration
      })
      registry.complete(command)

      expect(registry.captures(current.binding)).toEqual(declarations.map((declaration, index) => ({
        declaration,
        source: { sessionId: `session-${index}`, messageId: `message-${index}` },
      })))
      expect(registry.reserve(declarations[0]!)).toBe(false)
      current.abort.abort()
      expect(registry.captures(current.binding)).toEqual([])
    }
  })

  it('moves N=1/2/3 accepted fresh-Room captures only at the matching same-owner route activation', () => {
    for (const count of [1, 2, 3]) {
      const registry = new PageAdmissionBindingRegistry()
      const fresh = mount(registry, { outlet: 'main', routeId: 'new-room' })
      const command = registry.begin(fresh.binding, 'chatroom:room-submit')!
      const declarations = Array.from({ length: count }, (_, index) => {
        const declaration = registry.declare(command, target('room-fresh', index), destination('room-fresh'))!
        expect(registry.reserve(declaration)).toBe(true)
        expect(registry.accept(declaration, {
          sessionId: `session-fresh-${index}`,
          messageId: `message-fresh-${index}`,
        })).toBe(true)
        return declaration
      })
      const wrong = mount(registry, { outlet: 'main', routeId: 'room', roomId: 'room-wrong' })
      fresh.abort.abort()
      expect(registry.claim(wrong.binding)).toEqual([])
      expect(registry.captures(wrong.binding)).toEqual([])
      wrong.abort.abort()

      const destinationBinding = mount(registry, { outlet: 'main', routeId: 'room', roomId: 'room-fresh' })
      expect(registry.claim(destinationBinding.binding)).toEqual(declarations.map((declaration, index) => ({
        declaration,
        source: { sessionId: `session-fresh-${index}`, messageId: `message-fresh-${index}` },
      })))
      expect(registry.captures(destinationBinding.binding)).toHaveLength(count)
      registry.complete(command)
      expect(registry.claim(destinationBinding.binding)).toEqual([])
      destinationBinding.abort.abort()
      expect(registry.captures(destinationBinding.binding)).toEqual([])
    }
  })

  it('rejects duplicate targets and fences fresh continuations on owner or connection replacement', () => {
    const registry = new PageAdmissionBindingRegistry()
    const fresh = mount(registry, { outlet: 'main', routeId: 'new-room' })
    const command = registry.begin(fresh.binding, 'chatroom:room-submit')!
    const declared = registry.declare(command, target('room-fresh', 0), destination('room-fresh'))!
    expect(registry.declare(command, target('room-fresh', 0), destination('room-fresh'))).toBeUndefined()
    expect(registry.reserve(declared)).toBe(true)
    expect(registry.accept(declared, { sessionId: 'session-fresh', messageId: 'message-fresh' })).toBe(true)
    registry.fenceConnection('connection-replaced')
    fresh.abort.abort()

    const destinationBinding = mount(registry, { outlet: 'main', routeId: 'room', roomId: 'room-fresh' })
    expect(registry.claim(destinationBinding.binding)).toEqual([])
    registry.fenceOwner(owner, source, generation)
    expect(registry.captures(destinationBinding.binding)).toEqual([])
  })

  it('requires the fresh claim before command completion and rejects partial fresh submissions on source release', () => {
    const registry = new PageAdmissionBindingRegistry()
    const fresh = mount(registry, { outlet: 'main', routeId: 'new-room' })
    const command = registry.begin(fresh.binding, 'chatroom:room-submit')!
    const first = registry.declare(command, target('room-fresh', 0), destination('room-fresh'))!
    const second = registry.declare(command, target('room-fresh', 1), destination('room-fresh'))!
    expect(registry.reserve(first)).toBe(true)
    expect(registry.accept(first, { sessionId: 'session-first', messageId: 'message-first' })).toBe(true)
    fresh.abort.abort()

    const destinationBinding = mount(registry, { outlet: 'main', routeId: 'room', roomId: 'room-fresh' })
    expect(registry.claim(destinationBinding.binding)).toEqual([])
    expect(registry.reserve(second)).toBe(false)

    const secondRun = mount(registry, { outlet: 'main', routeId: 'new-room' })
    const secondCommand = registry.begin(secondRun.binding, 'chatroom:room-submit')!
    const declared = registry.declare(secondCommand, target('room-second', 0), destination('room-second'))!
    expect(registry.reserve(declared)).toBe(true)
    expect(registry.accept(declared, { sessionId: 'session-second', messageId: 'message-second' })).toBe(true)
    registry.complete(secondCommand)
    secondRun.abort.abort()
    const secondDestination = mount(registry, { outlet: 'main', routeId: 'room', roomId: 'room-second' })
    expect(registry.claim(secondDestination.binding)).toEqual([])
  })
})
