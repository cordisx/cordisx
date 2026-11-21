import { expect, it, vi } from 'vitest'
import { ServiceRendererParticipants } from '../packages/cli/src/cli/service-renderer-participant.js'

const scope = { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'work', generation: 'owner-1' }
const gateway = { pid: 42, processStartedAt: 'fixture', instanceToken: 'b'.repeat(64) }
const snapshot = { active: { recordKind: 'active', plugins: [] }, registryEpoch: 0 }

function fixture() {
  const participants = new ServiceRendererParticipants(scope)
  participants.bind({ snapshot: () => snapshot as never, attach: async () => {} })
  const create = (digit: string) =>
    participants.participant.create({
      gateway,
      browserSessionId: digit.repeat(64),
      handle: { rendererId: digit.repeat(64), grant: 'c'.repeat(64), ownerGeneration: scope.generation },
    })
  return { participants, create }
}

it('blocks new admissions until each Manager confirms cleanup and disconnects', async () => {
  const { participants, create } = fixture()
  const first = create('1')
  const second = create('2')
  try {
    participants.confirmBootstrap(first.identity.rendererId, snapshot as never)
    participants.confirmBootstrap(second.identity.rendererId, snapshot as never)
    await participants.participant.attach(first)
    await participants.participant.attach(second)
    let settled = false
    const pending = participants.quiesceManagers().then(value => {
      settled = true
      return value
    })
    expect(() => create('3')).toThrow('renderer-participants-unavailable')
    const commands = await Promise.all([first.next(), second.next()])
    for (const [peer, command] of [[first, commands[0]], [second, commands[1]]] as const) {
      expect(command?.method).toBe('quiesce')
      const fenceId = (command!.payload as { fenceId: string }).fenceId
      expect(peer.acknowledge({
        id: command!.id,
        sequence: command!.sequence,
        ok: true,
        value: { fenceId, rendererId: peer.identity.rendererId, ownerGeneration: scope.generation, quiesced: true },
      })).toBe(true)
    }
    first.close()
    await Promise.resolve()
    expect(settled).toBe(false)
    second.close()
    const lease = await pending
    expect(() => create('3')).toThrow('renderer-participants-unavailable')
    expect(lease.release()).toBe(true)
    expect(lease.release()).toBe(false)
    expect(create('3').closed).toBe(false)
  } finally {
    participants.close()
  }
})

it('keeps admissions fenced if a renderer gives the wrong cleanup receipt', async () => {
  const { participants, create } = fixture()
  const peer = create('1')
  try {
    const pending = participants.quiesceManagers()
    const rejected = expect(pending).rejects.toThrow('renderer-quiescence-unavailable')
    const command = await peer.next()
    expect(command?.method).toBe('quiesce')
    peer.acknowledge({
      id: command!.id,
      sequence: command!.sequence,
      ok: true,
      value: {
        fenceId: 'd'.repeat(64),
        rendererId: peer.identity.rendererId,
        ownerGeneration: scope.generation,
        quiesced: true,
      },
    })
    await rejected
    expect(peer.closed).toBe(true)
    await vi.waitFor(() => expect(() => create('2')).toThrow('renderer-participants-unavailable'))
  } finally {
    participants.close()
  }
})
