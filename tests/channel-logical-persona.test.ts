import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { ChannelMemoryPersonas } from '../packages/cli/src/launcher/channel-memory-personas.js'
import { channelLogicalActor } from '../packages/cli/src/launcher/channel-logical-actor.js'
import { prepareChannelLogicalPersona } from '../packages/cli/src/launcher/channel-logical-persona.js'

const account = { adapterId: 'test', accountId: 'bot', tenantId: 'tenant' }
const channel = {
  ...account,
  conversationId: 'conversation',
  threadId: 'conversation',
  kind: 'direct' as const,
  semantics: 'conversation' as const,
}
const event = { ...channel, eventId: 'event', actor: { ...account, userId: 'user' } }
const ref = (sessionId: string) => ({ hostId: 'local', appId: 'codex', profileId: 'profile', sessionId })
const relation = (operationId: string, source: string, destination: string) => ({
  operationId,
  logicalConversationId: 'logical',
  mode: 'linked',
  source: ref(source),
  destination: ref(destination),
})
function fixture() {
  return {
    policy: { enabled: true, rules: [] },
    jobs: { job: { state: 'dispatching', sessionId: 'third', bindingId: 'binding', recordId: 'record' } },
    inputs: { record: { input: { source: { event } } } },
    bindings: { binding: { state: 'active', sessionId: 'third', hostId: 'local', profileId: 'profile', channel } },
    logicalContinuations: {
      relations: { first: relation('first', 'one', 'two'), second: relation('second', 'two', 'third') },
      intents: {
        first: { state: 'applied', actor: channelLogicalActor(event) },
        second: { state: 'applied', actor: channelLogicalActor(event) },
      },
    },
  }
}

it('preserves a pinned persona through multiple committed boundaries after a bot rebind', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'logical-persona-'))
  try {
    const personas = new ChannelMemoryPersonas(root), state = fixture()
    await personas.profile('atlas', 'Atlas', 'Original', 0)
    await personas.profile('nova', 'Nova', 'New', 0)
    await personas.bind(account, 'atlas', 0)
    await personas.resolveTask('one', account)
    await personas.bind(account, 'nova', 1)
    const read = () => structuredClone(state) as never
    expect(await prepareChannelLogicalPersona(personas, read, 'job', event, 'codex', 'profile')).toBe(true)
    expect((await personas.bootstrap('two', account)).personaId).toBe('atlas')
    expect((await personas.bootstrap('third', account)).personaId).toBe('atlas')
    const before = (await personas.bootstrap('third', account)).contextRevision
    expect(await prepareChannelLogicalPersona(personas, read, 'job', event, 'codex', 'profile')).toBe(true)
    expect((await personas.bootstrap('third', account)).contextRevision).toBe(before)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('stops if the binding changes while an alias is being prepared', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'logical-persona-race-'))
  try {
    const personas = new ChannelMemoryPersonas(root), state = fixture()
    await personas.profile('atlas', 'Atlas', 'Original', 0)
    await personas.bind(account, 'atlas', 0)
    await personas.resolveTask('one', account)
    const pin = personas.pinAlias.bind(personas)
    vi.spyOn(personas, 'pinAlias').mockImplementationOnce(async (...args) => {
      await pin(...args)
      state.bindings.binding.state = 'archived'
    })
    expect(
      await prepareChannelLogicalPersona(
        personas,
        () => structuredClone(state) as never,
        'job',
        event,
        'codex',
        'profile',
      ),
    ).toBe(false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
