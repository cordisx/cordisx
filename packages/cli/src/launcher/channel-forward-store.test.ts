import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ChannelForwardStore } from './channel-forward-store.js'
import type { ChannelForwardReceiptV1, ChannelForwardRequestV1 } from '@cordisx/protocol/channel-forward/v1'

const request: ChannelForwardRequestV1 = {
  contract: 'cordisx.channel-forward/v1',
  schemaVersion: 1,
  operation: 'forward',
  operationId: 'one',
  source: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', conversationId: 'oc_source', kind: 'group' },
  target: { adapterId: 'feishu', accountId: 'bot', tenantId: 'tenant', conversationId: 'oc_target', kind: 'group' },
  messageIds: ['om_one'],
}
const sent: ChannelForwardReceiptV1 = {
  contract: 'cordisx.channel-forward-receipt/v1',
  schemaVersion: 1,
  operation: 'forward',
  operationId: 'one',
  state: 'sent',
  externalMessageId: 'om_result',
  invalidMessageIds: [],
}
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'channel-forward-'))
  const filename = path.join(directory, 'ledger.json')
  return { filename, store: new ChannelForwardStore(filename) }
}
describe('independent forward ledger', () => {
  it('excludes a second process while the first owns the file lock', async () => {
    const { filename, store } = await fixture()
    const source = `import { mkdir } from 'node:fs/promises'; await mkdir(${
      JSON.stringify(`${filename}.lock`)
    }); console.log('locked'); process.stdin.resume();`
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['pipe', 'pipe', 'pipe'] })
    try {
      await once(child.stdout, 'data')
      const perform = vi.fn(async () => sent)
      await expect(store.run('caller', request, perform)).rejects.toThrow('LEDGER_LOCKED')
      expect(perform).not.toHaveBeenCalled()
    } finally {
      child.stdin.end()
      await once(child, 'exit')
    }
  })
  it('fails closed on malformed persisted success without any effect', async () => {
    const { filename, store } = await fixture()
    const perform = vi.fn(async () => sent)
    await store.run('caller', request, perform)
    const entries = JSON.parse(await readFile(filename, 'utf8'))
    Object.values(entries).forEach(entry => {
      delete (entry as { receipt: Record<string, unknown> }).receipt.externalMessageId
    })
    await writeFile(filename, JSON.stringify(entries))
    await expect(store.run('caller', request, perform, true)).rejects.toThrow('STORE_INVALID')
    expect(perform).toHaveBeenCalledTimes(1)
  })
  it('excludes another store instance and never steals an abandoned lock', async () => {
    const { filename, store } = await fixture()
    let release!: () => void
    const blocked = new Promise<void>(resolve => {
      release = resolve
    })
    let entered!: () => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    const perform = vi.fn(async () => {
      entered()
      await blocked
      return sent
    })
    const first = store.run('caller', request, perform)
    await ready
    await expect(new ChannelForwardStore(filename).run('caller', request, perform)).rejects.toThrow('LEDGER_LOCKED')
    release()
    await first
    expect(perform).toHaveBeenCalledTimes(1)
    await mkdir(`${filename}.lock`)
    await expect(new ChannelForwardStore(filename).run('caller', request, perform)).rejects.toThrow('LEDGER_LOCKED')
    expect(perform).toHaveBeenCalledTimes(1)
  })
  it('coalesces duplicates and survives restart without another effect', async () => {
    const { filename, store } = await fixture()
    const perform = vi.fn(async () => sent)
    const results = await Promise.all([store.run('caller', request, perform), store.run('caller', request, perform)])
    expect(results).toEqual([sent, sent])
    expect(perform).toHaveBeenCalledTimes(1)
    expect(await new ChannelForwardStore(filename).run('caller', request, perform)).toEqual(sent)
    expect(perform).toHaveBeenCalledTimes(1)
    await expect(store.run('caller', { ...request, messageIds: ['om_changed'] }, perform)).rejects.toThrow('CONFLICT')
  })
  it('persists sending before effect and never replays uncertainty', async () => {
    const { filename, store } = await fixture()
    const perform = vi.fn(async () => {
      expect(Object.values(JSON.parse(await readFile(filename, 'utf8')))[0]).toMatchObject({
        receipt: { state: 'sending' },
      })
      throw new Error('lost response')
    })
    expect(await store.run('caller', request, perform)).toMatchObject({ state: 'unknown' })
    expect(await new ChannelForwardStore(filename).run('caller', request, perform)).toMatchObject({ state: 'unknown' })
    expect(perform).toHaveBeenCalledTimes(1)
  })
  it('marks interrupted sending unknown and scopes receipt reads', async () => {
    const { filename, store } = await fixture()
    const perform = vi.fn(async () => sent)
    await store.run('caller', request, perform)
    const entries = JSON.parse(await readFile(filename, 'utf8'))
    Object.values(entries).forEach(entry => {
      ;(entry as { receipt: unknown }).receipt = {
        contract: 'cordisx.channel-forward-receipt/v1',
        schemaVersion: 1,
        operationId: 'one',
        operation: 'forward',
        state: 'sending',
      }
    })
    await writeFile(filename, JSON.stringify(entries))
    expect(await new ChannelForwardStore(filename).run('caller', request, perform, true)).toMatchObject({
      state: 'unknown',
    })
    expect(await store.run('another', request, perform, true)).toBeUndefined()
    expect(perform).toHaveBeenCalledTimes(1)
  })
})
