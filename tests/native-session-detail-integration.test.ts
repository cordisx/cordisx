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
import { NativeAgentSessionPersistence } from '../packages/cli/src/renderer/native-agent-session-recovery.js'
import { getAgentToolSetup } from '../packages/cli/src/renderer/plugin-agent-tools.js'
import { BrowserOwnerDocumentBridge } from '../packages/cli/src/renderer/owner-documents.js'

test('a restarted authenticated native mapping opens through an ephemeral target with zero writes or recovery', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'native-detail-v2-'))
  const identity = { source: 'file:///plugins/chatroom-a.js', pluginId: 'chatroom' }
  const principal = { profileId: 'work', generation: 'launch', moduleGeneration: 'module', identity }
  const token = issueOwnerDocumentPrincipalToken('secret', principal)
  const store = new OwnerDocumentStore(home)
  let active = true
  const input = { secret: 'secret', profileId: 'work', generation: 'launch', store, principalAllowed: () => active }
  const nativeToken = issueNativeSessionHostToken(input)
  const bridge = new NativeAgentSessionBridge(input)
  let requestId = 0
  const call = (operation: string, value: object = {}) =>
    bridge.handle({
      version: 1,
      requestId: String(++requestId),
      operation,
      token,
      nativeToken,
      sessionId: 'history',
      ...value,
    })
  let persistence: NativeAgentSessionPersistence | undefined
  let browser: BrowserOwnerDocumentBridge | undefined
  try {
    await call('native-session-save-binding', { threadId: 'existing-thread', completedTurns: 3 })
    const foreignIdentity = { source: 'file:///plugins/chatroom-b.js', pluginId: 'chatroom' }
    const foreignToken = issueOwnerDocumentPrincipalToken('secret', { ...principal, identity: foreignIdentity })
    await bridge.handle({
      version: 1,
      requestId: 'foreign-binding',
      operation: 'native-session-save-binding',
      token: foreignToken,
      nativeToken,
      sessionId: 'history',
      threadId: 'foreign-thread',
      completedTurns: 2,
    })
    // Use a fresh Host persistence instance, without loading Session events or resuming.
    const writes = vi.spyOn(store, 'replace')
    const requests: string[] = []
    browser = new BrowserOwnerDocumentBridge()
    vi.spyOn(browser, 'request').mockImplementation(async (_token, input) => {
      requests.push(String((input as { operation: string }).operation))
      return await bridge.handle({ version: 1, requestId: String(++requestId), token: _token, ...input }) as never
    })
    const binding = { ...identity, moduleGeneration: 'module', token }
    persistence = new NativeAgentSessionPersistence(browser, [binding], nativeToken)
    const owner = { pluginId: `${identity.source}:${identity.pluginId}`, generation: 1 }
    persistence.register(owner, { principal: binding, active: () => active })
    const foreignOwner = { pluginId: `${foreignIdentity.source}:${foreignIdentity.pluginId}`, generation: 1 }
    const foreignBinding = { ...foreignIdentity, moduleGeneration: 'module', token: foreignToken }
    persistence.register(foreignOwner, { principal: foreignBinding, active: () => active })
    const result = await persistence.details.get(owner, 'history', () => true)
    if (result.status !== 'accepted') throw new Error('historical target unavailable')
    expect(result.target.ref).not.toContain('existing-thread')
    const navigate = vi.fn()
    expect((await persistence.details.open(foreignOwner, result.target, () => true, async () => true, navigate)).status)
      .toBe('unavailable')
    expect(navigate).not.toHaveBeenCalled()
    expect(await persistence.details.open(owner, result.target, () => true, async () => true, navigate))
      .toEqual({ status: 'accepted', code: 'opened' })
    expect(navigate).toHaveBeenCalledExactlyOnceWith({ kind: 'host', ref: 'codex-thread:existing-thread' }, 'history')
    expect(requests.every(operation => operation === 'native-session-detail')).toBe(true)
    expect(writes).not.toHaveBeenCalled()
    expect(await getAgentToolSetup('history')).toEqual({ skills: [], commands: [] })
    active = false
    expect((await persistence.details.open(owner, result.target, () => true, async () => true, navigate)).status)
      .toBe('unavailable')
    expect(navigate).toHaveBeenCalledTimes(1)
  } finally {
    persistence?.dispose()
    browser?.dispose()
    await rm(home, { recursive: true, force: true })
  }
})
