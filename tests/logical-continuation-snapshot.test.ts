import { describe, expect, it } from 'vitest'
import { logicalSourceSnapshotVersion } from '../packages/cli/src/launcher/logical-continuation-snapshot.js'

const source = { hostId: 'local', appId: 'codex', profileId: 'test', sessionId: 'source' }

describe('logical source snapshot', () => {
  it('covers every page and detects content changes between complete scans', async () => {
    let scans = 0
    const native = {
      nativeRequest: async (_method: string, params: Readonly<Record<string, unknown>>) => {
        if (!params.cursor) {
          scans++
          return { data: [{ item: { type: 'userMessage', content: 'first' } }], nextCursor: 'next' }
        }
        return { data: [{ item: { type: 'agentMessage', text: scans === 1 ? 'old' : 'changed' } }] }
      },
    }
    await expect(logicalSourceSnapshotVersion(native, source)).rejects.toThrow('SOURCE_SNAPSHOT_CHANGED')
    scans = 0
    const stable = {
      nativeRequest: async (_method: string, params: Readonly<Record<string, unknown>>) =>
        params.cursor
          ? { data: [{ item: { type: 'agentMessage', text: 'same' } }] }
          : { data: [{ item: { type: 'userMessage', content: 'first' } }], nextCursor: 'next' },
    }
    expect(await logicalSourceSnapshotVersion(stable, source)).toMatch(/^sha256:[a-f0-9]{64}$/u)
  })
  it('fails closed when native pagination cycles', async () => {
    const native = {
      nativeRequest: async (_method: string, params: Readonly<Record<string, unknown>>) => ({
        data: [{ item: { type: 'userMessage', content: 'x' } }],
        nextCursor: params.cursor === 'a' ? 'b' : 'a',
      }),
    }
    await expect(logicalSourceSnapshotVersion(native, source)).rejects.toThrow('SOURCE_SNAPSHOT_CURSOR_CYCLE')
  })
})
