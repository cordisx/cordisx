import { expect, test, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  issueNativeSessionHostToken,
  NativeAgentSessionBridge,
} from '../packages/cli/src/launcher/native-agent-session-rpc.js'
import { OwnerDocumentStore } from '../packages/cli/src/launcher/owner-document-store.js'
import { issueOwnerDocumentPrincipalToken } from '../packages/cli/src/launcher/owner-document-rpc.js'
import { beginAgentToolRecovery, getAgentToolSetup } from '../packages/cli/src/renderer/plugin-agent-tools.js'

test('native binding and recovery-afterward ledger share authenticated locked persistence', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'native-session-persistence-'))
  const identity = { source: 'file:///owned/chatroom.js', pluginId: 'chatroom' }
  const principal = { profileId: 'work', generation: 'launch', moduleGeneration: 'module', identity }
  const token = issueOwnerDocumentPrincipalToken('secret', principal)
  let active = true
  const options = {
    secret: 'secret',
    profileId: 'work',
    generation: 'launch',
    store: new OwnerDocumentStore(home),
    principalAllowed: (value: typeof principal) =>
      active && [identity.source, 'file:///owned/other.js'].includes(value.identity.source),
  }
  const nativeToken = issueNativeSessionHostToken(options)
  const bridge = new NativeAgentSessionBridge(options)
  let request = 0
  const call = (operation: string, data: object = {}) =>
    bridge.handle({
      version: 1,
      requestId: String(++request),
      token,
      nativeToken,
      operation,
      sessionId: 'original-session',
      ...data,
    })
  try {
    await expect(
      bridge.handle({
        version: 1,
        requestId: 'plugin-only',
        token,
        operation: 'native-session-list',
        source: 'host',
        pluginId: 'host',
      }),
    ).rejects.toThrow('Host native Session authority')
    expect(await call('native-session-load')).toBeNull()
    await call('native-session-save-binding', { threadId: 'original-native-thread', completedTurns: 1 })
    const write = vi.spyOn(options.store, 'replace')
    const beforeDetail = await call('native-session-list')
    expect(await call('native-session-detail')).toEqual({ threadId: 'original-native-thread' })
    expect(await call('native-session-list')).toEqual(beforeDetail)
    expect(write).not.toHaveBeenCalled()
    write.mockRestore()
    const foreignToken = issueOwnerDocumentPrincipalToken('secret', {
      ...principal,
      identity: { source: 'file:///owned/other.js', pluginId: 'other' },
    })
    expect(
      await bridge.handle({
        version: 1,
        requestId: 'cross-owner',
        token: foreignToken,
        nativeToken,
        operation: 'native-session-detail',
        sessionId: 'original-session',
        identity,
      }),
    ).toBeNull()
    const session = {
      id: 'original-session',
      generation: 1,
      header: { id: 'original-session', formatVersion: 1, createdAt: 100, isSeeded: true },
      events: [],
    }
    await call('native-session-create', { session })
    await Promise.all([
      call('native-session-append', {
        sessionGeneration: 1,
        expectedSeq: 0,
        events: [{
          $schema:
            'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/session-event.v1.schema.json',
          contract: 'cordisx.session-event/v1',
          schemaVersion: 1,
          sessionId: 'original-session',
          seq: 0,
          time: 101,
          type: 'turn/start',
          data: { turn: 2 },
        }],
      }),
      call('native-session-save-binding', { threadId: 'original-native-thread', completedTurns: 2 }),
    ])
    expect((await options.store.load({ profileId: principal.profileId, identity }, 'native-session-index')).status)
      .toBe('missing')
    const reloaded = new NativeAgentSessionBridge({ ...options, store: new OwnerDocumentStore(home) })
    const result = await reloaded.handle({
      version: 1,
      requestId: 'reload',
      token,
      nativeToken,
      operation: 'native-session-list',
    })
    expect(result).toMatchObject([{
      sessionId: 'original-session',
      threadId: 'original-native-thread',
      completedTurns: 2,
      session: { header: { isSeeded: true }, events: [{ type: 'turn/start', seq: 0 }] },
    }])
    await expect(call('native-session-save-binding', { threadId: 'foreign-thread', completedTurns: 2 })).rejects
      .toThrow('conflict')
    await expect(call('native-session-save-binding', { threadId: 'original-native-thread', completedTurns: 1 })).rejects
      .toThrow('conflict')
    active = false
    await expect(call('native-session-load')).rejects.toThrow('stale')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('validated recovery blocks formerly unbound tool execution until a fresh binding', async () => {
  const sessionId = 'recovering-native-session'
  expect(await getAgentToolSetup(sessionId)).toEqual({ skills: [], commands: [] })
  await beginAgentToolRecovery(sessionId)
  await expect(getAgentToolSetup(sessionId)).rejects.toThrow('fresh binding')
})
