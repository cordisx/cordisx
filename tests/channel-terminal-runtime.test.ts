import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { ChannelRuntime } from '../packages/channel-runtime/src/runtime.js'

const ref = { adapterId: 'feishu', accountId: 'fixture', tenantId: 'fixture' }
const target = {
  ...ref,
  conversationId: 'oc_fixture',
  threadId: 'oc_fixture',
  kind: 'direct' as const,
  semantics: 'conversation' as const,
}
const caller = { source: 'test', pluginId: 'test', generation: 'test' }
const notification = { target, kind: 'reply' as const, text: 'terminal' }
async function legacyStore() {
  const root = process.env.CORDISX_TEST_LEGACY_PACKAGE
  if (!root) return undefined
  return await import(/* @vite-ignore */ pathToFileURL(path.join(root, 'dist/channel-runtime/store.js')).href)
}
const descriptor = {
  ref,
  kind: 'feishu' as const,
  implementationStatus: 'experimental' as const,
  configurationRevision: 1,
  secretState: 'ready' as const,
}

it('delivers a never-attempted queued terminal once after restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-queued-'))
  const file = path.join(root, 'outbox.json')
  const options = { storePath: file, permissions: { authorize: async () => 'allow' as const } }
  const send = vi.fn(async () => ({ externalMessageId: 'sent' }))
  let runtime = await ChannelRuntime.open(options)
  try {
    await runtime.activate({ descriptor, start: async () => ({ send, stop: async () => {} }) }, caller)
    await runtime.notifyTerminalOnce(notification, caller, 'delivery:terminal')
    await runtime.dispose()
    runtime = await ChannelRuntime.open(options)
    const adapter = await runtime.activate({ descriptor, start: async () => ({ send, stop: async () => {} }) }, caller)
    await adapter.drainOutbound(10)
    expect(send).toHaveBeenCalledTimes(1)
    expect(runtime.deliverySnapshot('delivery:terminal', caller)).toMatchObject({ state: 'sent' })
    expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(1)
    const legacy = await legacyStore()
    if (legacy) {
      await runtime.dispose()
      expect((await legacy.JsonChannelStore.open(file)).snapshot().schemaVersion).toBe(1)
    }
  } finally {
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('never reclaims an in-flight terminal delivery after its lease', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-runtime-'))
  let now = Date.now(), release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => {
    release = resolve
  })
  const started = new Promise<void>(resolve => {
    entered = resolve
  })
  const send = vi.fn(async () => {
    entered()
    await gate
    return { externalMessageId: 'sent' }
  })
  const runtime = await ChannelRuntime.open({
    storePath: path.join(root, 'outbox.json'),
    permissions: { authorize: async () => 'allow' },
    clock: { now: () => new Date(now) },
    leaseMs: 100,
  })
  try {
    const adapter = await runtime.activate({ descriptor, start: async () => ({ send, stop: async () => {} }) }, caller)
    await runtime.notifyTerminalOnce(notification, caller, 'delivery:terminal')
    const pending = adapter.drainOutbound(1)
    await started
    now += 10_000
    await adapter.drainOutbound(1)
    expect(send).toHaveBeenCalledTimes(1)
    release()
    await pending
    expect(runtime.deliverySnapshot('delivery:terminal', caller)).toMatchObject({ state: 'sent' })
    expect(JSON.parse(await readFile(path.join(root, 'outbox.json'), 'utf8')).schemaVersion).toBe(1)
  } finally {
    release()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(
  [
    ['processing', 'deny'],
    ['sent', 'ask'],
  ] as const,
)('does not overwrite a %s terminal receipt with a delayed %s decision', async (stage, decision) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-permission-race-'))
  let releaseDecision!: () => void, permissionStarted!: () => void
  let releaseSend!: () => void, sendStarted!: () => void
  const permissionGate = new Promise<void>(resolve => {
    releaseDecision = resolve
  })
  const checking = new Promise<void>(resolve => {
    permissionStarted = resolve
  })
  const sendGate = new Promise<void>(resolve => {
    releaseSend = resolve
  })
  const sending = new Promise<void>(resolve => {
    sendStarted = resolve
  })
  const authorize = vi.fn(async (): Promise<'allow' | 'deny' | 'ask'> => 'allow')
  const send = vi.fn(async () => {
    sendStarted()
    await sendGate
    return { externalMessageId: 'sent' }
  })
  const runtime = await ChannelRuntime.open({
    storePath: path.join(root, 'outbox.json'),
    permissions: { authorize },
  })
  try {
    const adapter = await runtime.activate({ descriptor, start: async () => ({ send, stop: async () => {} }) }, caller)
    await runtime.notifyTerminalOnce(notification, caller, 'delivery:terminal')
    authorize.mockImplementationOnce(async () => {
      permissionStarted()
      await permissionGate
      return decision
    })
    const delayed = adapter.drainOutbound(1)
    await checking
    const active = adapter.drainOutbound(1)
    await sending
    if (stage === 'sent') {
      releaseSend()
      await active
    }
    releaseDecision()
    await delayed
    if (stage === 'processing') {
      releaseSend()
      await active
    }
    expect(send).toHaveBeenCalledTimes(1)
    expect(runtime.deliverySnapshot('delivery:terminal', caller)).toMatchObject({
      state: 'sent',
      externalMessageId: 'sent',
    })
    expect(JSON.parse(await readFile(path.join(root, 'outbox.json'), 'utf8')).schemaVersion).toBe(1)
  } finally {
    releaseDecision()
    releaseSend()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it('does not apply an old permission decision to a reclaimed ordinary delivery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'outbound-permission-race-'))
  let now = Date.now(), releaseDecision!: () => void, permissionStarted!: () => void
  let releaseFirst!: () => void, releaseSecond!: () => void, firstStarted!: () => void, secondStarted!: () => void
  const permissionGate = new Promise<void>(resolve => {
    releaseDecision = resolve
  })
  const checking = new Promise<void>(resolve => {
    permissionStarted = resolve
  })
  const firstGate = new Promise<void>(resolve => {
    releaseFirst = resolve
  })
  const secondGate = new Promise<void>(resolve => {
    releaseSecond = resolve
  })
  const firstSending = new Promise<void>(resolve => {
    firstStarted = resolve
  })
  const secondSending = new Promise<void>(resolve => {
    secondStarted = resolve
  })
  const authorize = vi.fn(async (): Promise<'allow' | 'deny'> => 'allow')
  const send = vi.fn()
    .mockImplementationOnce(async () => {
      firstStarted()
      await firstGate
      return { externalMessageId: 'first' }
    })
    .mockImplementationOnce(async () => {
      secondStarted()
      await secondGate
      return { externalMessageId: 'second' }
    })
  const runtime = await ChannelRuntime.open({
    storePath: path.join(root, 'outbox.json'),
    permissions: { authorize },
    clock: { now: () => new Date(now) },
    leaseMs: 100,
  })
  try {
    const adapter = await runtime.activate({ descriptor, start: async () => ({ send, stop: async () => {} }) }, caller)
    await runtime.notifyOnce(notification, caller, 'delivery:ordinary')
    const first = adapter.drainOutbound(1)
    await firstSending
    now += 1_000
    authorize.mockImplementationOnce(async () => {
      permissionStarted()
      await permissionGate
      return 'deny'
    })
    const delayed = adapter.drainOutbound(1)
    await checking
    const second = adapter.drainOutbound(1)
    await secondSending
    releaseDecision()
    await delayed
    releaseSecond()
    await second
    releaseFirst()
    await first
    expect(runtime.deliverySnapshot('delivery:ordinary', caller)).toMatchObject({
      state: 'sent',
      externalMessageId: 'second',
    })
  } finally {
    releaseDecision()
    releaseFirst()
    releaseSecond()
    await runtime.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['processing', 'retrying', 'queued'])(
  'preserves a previously attempted %s terminal effect as unknown after restart',
  async status => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'terminal-restart-'))
    const file = path.join(root, 'outbox.json')
    const options = { storePath: file, permissions: { authorize: async () => 'allow' as const } }
    const send = vi.fn(async () => ({ externalMessageId: 'sent' }))
    let runtime = await ChannelRuntime.open(options)
    try {
      await runtime.activate({ descriptor, start: async () => ({ send, stop: async () => {} }) }, caller)
      await runtime.notifyTerminalOnce(notification, caller, 'delivery:terminal')
      await runtime.dispose()
      const state = JSON.parse(await readFile(file, 'utf8'))
      expect(state.schemaVersion).toBe(2)
      expect([1]).not.toContain(state.schemaVersion) // The prior runtime's open gate rejects v2.
      const legacy = await legacyStore()
      if (legacy) await expect(legacy.JsonChannelStore.open(file)).rejects.toThrow('unsupported contract')
      Object.assign(state.outbox['delivery:terminal'], {
        status,
        attempts: 1,
        claimedAt: '2000-01-01T00:00:00Z',
        nextAttemptAt: '2000-01-01T00:00:00Z',
      })
      await writeFile(file, JSON.stringify(state))
      runtime = await ChannelRuntime.open(options)
      const adapter = await runtime.activate(
        { descriptor, start: async () => ({ send, stop: async () => {} }) },
        caller,
      )
      expect(runtime.deliverySnapshot('delivery:terminal', caller)).toMatchObject({ state: 'unknown' })
      await adapter.drainOutbound(10)
      expect(send).not.toHaveBeenCalled()
      expect(JSON.parse(await readFile(file, 'utf8')).schemaVersion).toBe(2)
    } finally {
      await runtime.dispose()
      await rm(root, { recursive: true, force: true })
    }
  },
)
