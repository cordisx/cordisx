import { expect, it, vi } from 'vitest'
import { ManagerRendererCommandPeer } from '../packages/cli/src/cli/manager-renderer-peer.js'

function peer(timeoutMs = 1_000) {
  return new ManagerRendererCommandPeer({
    scope: { homeDigest: 'a'.repeat(64), ownerAppId: 'codex', profileId: 'test', generation: 'generation' },
    identity: { appId: 'codex', adapterId: 'manager', rendererId: 'renderer', pid: 42, processStartedAt: 'start' },
    sessionId: 'b'.repeat(64),
    timeoutMs,
  })
}

it('delivers lifecycle commands once and accepts only their exact sequence and receipt', async () => {
  const channel = peer()
  try {
    const source = { active: { revision: 1 } }
    const firstResult = channel.request('synchronize', source)
    source.active.revision = 999
    const command = (await channel.next())!
    expect(command).toMatchObject({ sequence: 1, method: 'synchronize', payload: { active: { revision: 1 } } })
    await expect(channel.next()).rejects.toThrow('renderer-command-awaiting-receipt')
    expect(channel.acknowledge({ id: command.id, sequence: 2, ok: true, value: {} })).toBe(false)
    expect(channel.acknowledge({ id: 'wrong', sequence: 1, ok: true, value: {} })).toBe(false)
    expect(channel.acknowledge({ id: command.id, sequence: 1, ok: true, value: { revision: 1 } })).toBe(true)
    expect(await firstResult).toEqual({ revision: 1 })
    expect(channel.acknowledge({ id: command.id, sequence: 1, ok: true, value: {} })).toBe(false)
    const nextPoll = channel.next()
    const secondResult = channel.request('prepare', { transactionId: 'tx' })
    const nextCommand = (await nextPoll)!
    expect(nextCommand.sequence).toBe(2)
    expect(channel.acknowledge({ id: nextCommand.id, sequence: 2, ok: true, value: { transactionId: 'tx' } }))
      .toBe(true)
    expect(await secondResult).toEqual({ transactionId: 'tx' })
  } finally {
    channel.close()
  }
})

it('fences the peer and rejects a pending command after a lost or negative receipt', async () => {
  const channel = peer()
  const disconnected = vi.fn()
  channel.onDisconnect(disconnected)
  const result = channel.request('publish', { transactionId: 'tx' })
  const rejected = expect(result).rejects.toThrow('renderer-command-result-unknown')
  const command = (await channel.next())!
  expect(channel.acknowledge({ id: command.id, sequence: command.sequence, ok: false })).toBe(true)
  await rejected
  expect(disconnected).toHaveBeenCalledOnce()
  expect(channel.closed).toBe(true)
  expect(await channel.next()).toBeUndefined()
  await expect(channel.request('publish', {})).rejects.toThrow('renderer-command-unavailable')
  channel.close()
  expect(disconnected).toHaveBeenCalledOnce()
})

it('fences a timed-out command without redelivery', async () => {
  vi.useFakeTimers()
  const channel = peer(100)
  try {
    const result = channel.request('stage', { transactionId: 'tx' })
    const rejected = expect(result).rejects.toThrow('renderer-command-result-unknown')
    const command = (await channel.next())!
    await vi.advanceTimersByTimeAsync(100)
    await rejected
    expect(channel.closed).toBe(true)
    expect(channel.acknowledge({ id: command.id, sequence: command.sequence, ok: true, value: {} })).toBe(false)
  } finally {
    channel.close()
    vi.useRealTimers()
  }
})

it('cancels an unused poll without dropping a later command', async () => {
  const channel = peer()
  try {
    const controller = new AbortController()
    const polling = channel.next({ signal: controller.signal })
    await expect(channel.next()).rejects.toThrow('renderer-command-poll-in-progress')
    controller.abort()
    expect(await polling).toBeUndefined()
    const result = channel.request('prepare', { transactionId: 'tx' })
    const command = (await channel.next())!
    expect(channel.acknowledge({ id: command.id, sequence: command.sequence, ok: true, value: {} })).toBe(true)
    expect(await result).toEqual({})
  } finally {
    channel.close()
  }
})

it('rejects unbounded commands and concurrent owner operations before dispatch', async () => {
  const channel = peer()
  try {
    await expect(channel.request('stage', { large: 'a'.repeat(256 * 1024) }))
      .rejects.toThrow('renderer-command-invalid')
    const first = channel.request('prepare', {})
    const rejected = expect(first).rejects.toThrow('renderer-command-result-unknown')
    await expect(channel.request('stage', {})).rejects.toThrow('renderer-command-unavailable')
    channel.close()
    await rejected
  } finally {
    channel.close()
  }
})

it('allows a bounded multi-account Channel view without raising other command limits', async () => {
  const channel = peer()
  try {
    const result = channel.request('channel-configuration', { accounts: 'a'.repeat(300 * 1024) })
    const command = (await channel.next())!
    expect(command.method).toBe('channel-configuration')
    expect(channel.acknowledge({ id: command.id, sequence: command.sequence, ok: true, value: {} })).toBe(true)
    expect(await result).toEqual({})
    await expect(channel.request('channel-configuration', { accounts: 'a'.repeat(900 * 1024) }))
      .rejects.toThrow('renderer-command-invalid')
    await expect(channel.request('stage', { accounts: 'a'.repeat(300 * 1024) }))
      .rejects.toThrow('renderer-command-invalid')
  } finally {
    channel.close()
  }
})
