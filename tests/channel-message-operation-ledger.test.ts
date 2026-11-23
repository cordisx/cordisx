import { describe, expect, it, vi } from 'vitest'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { ChannelMessageOperationLedger } from '../packages/cli/src/launcher/channel-message-operation-ledger.js'

const fixture = async () => {
  const filename = path.join(await mkdtemp(path.join(os.tmpdir(), 'message-operations-')), 'ledger.json')
  const first = await ChannelMessageOperationLedger.open(filename)
  return { filename, first, key: first.key('caller', 'stable') }
}

describe('durable message operations', () => {
  it('serializes separate objects and re-reads the committed record without repeating effects', async () => {
    const { filename, first, key } = await fixture()
    const second = await ChannelMessageOperationLedger.open(filename)
    const effect = vi.fn(async () => {
      await new Promise(resolve => setTimeout(resolve, 100))
      return {
        status: 'ok' as const,
        operation: 'message-recall' as const,
        operationId: 'stable',
        messageId: 'om_owned',
      }
    })
    const results = await Promise.all([
      first.execute(key, { value: 1 }, 'stable', effect),
      second.execute(key, { value: 1 }, 'stable', effect),
    ])
    expect(effect).toHaveBeenCalledTimes(1)
    expect(results[0]).toEqual(results[1])
    expect(await second.receipt(key)).toEqual(results[0])
    await expect(second.execute(key, { value: 2 }, 'stable', effect)).rejects.toThrow('CHANNEL_IDEMPOTENCY_CONFLICT')
  })

  it('persists unknown before submission and never repeats an uncertain effect after reopen', async () => {
    const { filename, first, key } = await fixture()
    const effect = vi.fn(async () => {
      const disk = JSON.parse(await readFile(filename, 'utf8'))
      expect(disk.entries[key].result.status).toBe('unknown')
      throw new Error('connection lost after submission')
    })
    expect(await first.execute(key, {}, 'stable', effect)).toMatchObject({ status: 'unknown' })
    const reopened = await ChannelMessageOperationLedger.open(filename)
    expect(await reopened.execute(key, {}, 'stable', effect)).toMatchObject({ status: 'unknown' })
    expect(effect).toHaveBeenCalledTimes(1)
  })

  it.each([
    { status: 'ok', operation: 'message-recall', operationId: 'stable' },
    { status: 'unknown', code: 'secret text', operationId: 'stable' },
    { status: 'failed', code: 'CHANNEL_FAILED', operationId: 'stable', token: 'secret' },
    { status: 'ok', operation: 'read-users', operationId: 'stable', messageId: 'om_owned' },
  ])('rejects malformed disk results %j', async result => {
    const { filename, key } = await fixture()
    await writeFile(
      filename,
      JSON.stringify({
        contract: 'cordisx.channel-message-operation-store/v1',
        entries: {
          [key]: { descriptor: 'a'.repeat(64), createdAt: 1, result },
        },
      }),
    )
    await expect(ChannelMessageOperationLedger.open(filename)).rejects.toThrow('CHANNEL_OPERATION_STORE_INVALID')
  })

  it('does not erase an unknown reservation when effect returns malformed success', async () => {
    const { filename, first, key } = await fixture()
    await expect(first.execute(key, {}, 'stable', async () => ({ status: 'ok', operation: 'message-recall' })))
      .rejects.toThrow('CHANNEL_OPERATION_STORE_INVALID')
    expect(await (await ChannelMessageOperationLedger.open(filename)).receipt(key)).toMatchObject({ status: 'unknown' })
  })
  it('refuses corrupt entry metadata and symlink stores before effects', async () => {
    const { filename, key } = await fixture()
    for (
      const entry of [
        {
          descriptor: 'a'.repeat(64),
          createdAt: -1,
          result: { status: 'unknown', code: 'CHANNEL_PENDING', operationId: 'stable' },
        },
        {
          descriptor: 123,
          createdAt: 1,
          result: { status: 'unknown', code: 'CHANNEL_PENDING', operationId: 'stable' },
        },
        {
          descriptor: 'a'.repeat(64),
          createdAt: 1,
          token: 'extra',
          result: { status: 'unknown', code: 'CHANNEL_PENDING', operationId: 'stable' },
        },
      ]
    ) {
      await writeFile(
        filename,
        JSON.stringify({ contract: 'cordisx.channel-message-operation-store/v1', entries: { [key]: entry } }),
      )
      await expect(ChannelMessageOperationLedger.open(filename)).rejects.toThrow('CHANNEL_OPERATION_STORE_INVALID')
    }
    const linked = `${filename}.linked`
    await symlink(filename, linked)
    await expect(ChannelMessageOperationLedger.open(linked)).rejects.toThrow()
  })

  it('does not call the effect when reservation persistence fails', async () => {
    const { filename, first, key } = await fixture()
    await mkdir(filename)
    const effect = vi.fn(async () => ({ status: 'unknown' as const, code: 'CHANNEL_UNKNOWN', operationId: 'stable' }))
    await expect(first.execute(key, {}, 'stable', effect)).rejects.toThrow()
    expect(effect).not.toHaveBeenCalled()
  })
})
