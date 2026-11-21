import { describe, expect, it, vi } from 'vitest'
import {
  legacyChannelCompletion,
  readChannelCompletion,
} from '../packages/cli/src/launcher/channel-legacy-completion.js'

const agent = (text: string, phase: string | null = null) => ({ type: 'agentMessage', phase, text })
const readTurn = (items: unknown[], status = 'completed') =>
  vi.fn(async () => ({
    thread: { id: 'chat', turns: [{ id: 'turn', status, items }] },
  }))

describe('Channel completion for unphased native messages', () => {
  it('uses the sole trailing unphased assistant message of an exact completed legacy turn', async () => {
    const request = readTurn([{ type: 'userMessage' }, { type: 'reasoning' }, agent('reply')])
    await expect(legacyChannelCompletion(request, 'chat', 'turn')).resolves.toEqual({
      state: 'completed',
      text: 'reply',
    })
  })

  it.each([
    ['explicit commentary', [agent('progress', 'commentary')]],
    ['more than one assistant message', [agent('progress'), agent('reply')]],
    ['message followed by a tool call', [agent('progress'), { type: 'commandExecution' }]],
    ['empty message', [agent('  ')]],
    ['unknown phase', [agent('progress', 'other')]],
  ])('does not forward ambiguous legacy output: %s', async (_label, items) => {
    await expect(legacyChannelCompletion(readTurn(items), 'chat', 'turn')).resolves.toEqual({
      state: 'failed',
      code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE',
    })
  })

  it('prefers explicit final answers and rejects incomplete or wrong turns', async () => {
    await expect(legacyChannelCompletion(readTurn([agent('untagged'), agent('final', 'final_answer')]), 'chat', 'turn'))
      .resolves.toEqual({ state: 'completed', text: 'final' })
    await expect(legacyChannelCompletion(readTurn([agent('reply')], 'interrupted'), 'chat', 'turn')).resolves.toEqual({
      state: 'failed',
      code: 'NATIVE_ITEMS_UNAVAILABLE',
    })
    await expect(legacyChannelCompletion(readTurn([agent('reply')]), 'other-chat', 'turn')).resolves.toEqual({
      state: 'failed',
      code: 'NATIVE_ITEMS_UNAVAILABLE',
    })
  })

  it('reassembles only the exact paginated turn before considering an unphased answer', async () => {
    const request = vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) =>
      params.cursor === undefined
        ? { data: [{ turnId: 'turn', item: agent('reply') }], nextCursor: 'second' }
        : {
          data: [
            { turnId: 'turn', item: { type: 'userMessage' } },
            { turnId: 'older', item: agent('other session response') },
          ],
        }
    )
    await expect(readChannelCompletion(request, 'chat', 'turn')).resolves.toEqual({
      state: 'completed',
      text: 'reply',
    })
  })

  it('fails closed when a cursor repeats or the target turn is not fully read', async () => {
    const request = vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) => ({
      data: params.cursor === undefined ? [{ turnId: 'turn', item: agent('reply') }] : [],
      nextCursor: 'same',
    }))
    await expect(readChannelCompletion(request, 'chat', 'turn')).resolves.toEqual({
      state: 'failed',
      code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE',
    })
  })

  it('does not select an unphased message when a later item in the turn exists', async () => {
    const request = vi.fn(async () => ({
      data: [
        { turnId: 'turn', item: { type: 'commandExecution' } },
        { turnId: 'turn', item: agent('progress') },
      ],
    }))
    await expect(readChannelCompletion(request, 'chat', 'turn')).resolves.toEqual({
      state: 'failed',
      code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE',
    })
  })
})
