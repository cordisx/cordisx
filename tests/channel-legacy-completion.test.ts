import { describe, expect, it, vi } from 'vitest'
import { JsonLineRpcError } from '../packages/cli/src/providers/json-line-rpc.js'
import {
  legacyChannelCompletion,
  readChannelCompletion,
} from '../packages/cli/src/launcher/channel-legacy-completion.js'

const agent = (text: string, phase: string | null = null) => ({ type: 'agentMessage', phase, text })
const readTurn = (items: unknown[], status = 'completed') =>
  vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) => ({
    data: params.threadId === 'chat'
      ? [{ id: 'turn', status, ...(params.itemsView === 'full' ? { items, itemsView: 'full' } : {}) }]
      : [],
  }))

describe('Channel completion for unphased native messages', () => {
  it('uses the sole trailing unphased assistant message of an exact completed legacy turn', async () => {
    const request = readTurn([{ type: 'userMessage' }, { type: 'reasoning' }, agent('reply')])
    await expect(legacyChannelCompletion(request, 'chat', 'turn')).resolves.toEqual({
      state: 'completed',
      text: 'reply',
      unverifiedFinal: true,
    })
    expect(request).toHaveBeenCalledWith('thread/turns/list', {
      threadId: 'chat',
      limit: 1,
      sortDirection: 'desc',
      itemsView: 'full',
    })
    expect(request.mock.calls.some(([method]) => method === 'thread/read')).toBe(false)
  })

  it.each([
    ['explicit commentary', [agent('progress', 'commentary')]],
    ['message followed by a tool call', [agent('progress'), { type: 'commandExecution' }]],
    ['empty message', [agent('  ')]],
    ['unknown phase', [agent('progress', 'other')]],
  ])('does not forward ambiguous legacy output: %s', async (_label, items) => {
    await expect(legacyChannelCompletion(readTurn(items), 'chat', 'turn')).resolves.toEqual({
      state: 'failed',
      code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE',
    })
  })

  it('marks the trailing message of a completed unphased turn as unverified', async () => {
    const request = readTurn([agent('progress'), { type: 'commandExecution' }, agent('reply')])
    await expect(legacyChannelCompletion(request, 'chat', 'turn')).resolves.toEqual({
      state: 'completed',
      text: 'reply',
      unverifiedFinal: true,
    })
    await expect(legacyChannelCompletion(readTurn([agent('progress'), agent('still working')]), 'chat', 'turn'))
      .resolves.toEqual({ state: 'completed', text: 'still working', unverifiedFinal: true })
    await expect(legacyChannelCompletion(readTurn([agent('progress'), agent('reply')], 'interrupted'), 'chat', 'turn'))
      .resolves.toEqual({ state: 'failed', code: 'NATIVE_ITEMS_UNAVAILABLE' })
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

  it.each([agent('later output'), { type: 'commandExecution' }, { type: 'userMessage' }])(
    'does not forward an explicit final followed by a later turn item',
    async later => {
      await expect(legacyChannelCompletion(readTurn([agent('earlier', 'final_answer'), later]), 'chat', 'turn'))
        .resolves.toEqual({ state: 'failed', code: 'NATIVE_FINAL_MESSAGE_UNAVAILABLE' })
    },
  )

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
      unverifiedFinal: true,
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

  it('does not forward even an explicit final from an incomplete paginated turn', async () => {
    const request = vi.fn(async () => ({
      data: [{ turnId: 'turn', item: agent('partial', 'final_answer') }],
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
  it('locates an older target using metadata and never loads unrelated turns', async () => {
    const request = vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) => {
      if (params.cursor === undefined) return { data: [{ id: 'newer', status: 'completed' }], nextCursor: 'older' }
      expect(params.cursor).toBe('older')
      return {
        data: [{
          id: 'turn',
          status: 'completed',
          ...(params.itemsView === 'full' ? { items: [agent('correct', 'final_answer')], itemsView: 'full' } : {}),
        }],
      }
    })
    expect(await legacyChannelCompletion(request, 'chat', 'turn')).toEqual({ state: 'completed', text: 'correct' })
    expect(request.mock.calls.filter(([, params]) => params.itemsView === 'full')).toHaveLength(1)
    expect(request.mock.calls).toHaveLength(3)
  })
  it.each(['wrong-id', 'in-progress', 'duplicate', 'missing-items', 'summary', 'missing-view'])(
    'rejects changed or malformed full target: %s',
    async shape => {
      const request = vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) => {
        if (params.itemsView === 'notLoaded') return { data: [{ id: 'turn', status: 'completed' }] }
        const turn = {
          id: shape === 'wrong-id' ? 'other' : 'turn',
          status: shape === 'in-progress' ? 'inProgress' : 'completed',
          ...(shape === 'missing-view' ? {} : { itemsView: shape === 'summary' ? 'summary' : 'full' }),
          ...(shape === 'missing-items' ? {} : { items: [agent('unsafe', 'final_answer')] }),
        }
        return { data: shape === 'duplicate' ? [turn, turn] : [turn] }
      })
      expect(await legacyChannelCompletion(request, 'chat', 'turn')).toMatchObject({
        state: 'failed',
        code: 'NATIVE_ITEMS_UNAVAILABLE',
      })
    },
  )
  it('bounds metadata scanning and detects cursor cycles', async () => {
    let count = 0
    const request = vi.fn(async () => ({ data: [{ id: 'other', status: 'completed' }], nextCursor: String(++count) }))
    expect(await legacyChannelCompletion(request, 'chat', 'turn')).toMatchObject({
      code: 'NATIVE_COMPLETION_PAGE_LIMIT',
    })
    expect(request).toHaveBeenCalledTimes(64)
    request.mockImplementation(async () => ({ data: [{ id: 'other', status: 'completed' }], nextCursor: 'cycle' }))
    expect(await legacyChannelCompletion(request, 'chat', 'turn')).toMatchObject({ code: 'NATIVE_ITEMS_UNAVAILABLE' })
  })
  it('reports an oversized single target and never falls back after a non-method error or later page', async () => {
    const request = vi.fn(async (_method: string, params: Readonly<Record<string, unknown>>) => {
      if (params.itemsView === 'notLoaded') return { data: [{ id: 'turn', status: 'completed' }] }
      throw new JsonLineRpcError('RPC line exceeds maximum size')
    })
    expect(await legacyChannelCompletion(request, 'chat', 'turn')).toMatchObject({
      code: 'NATIVE_COMPLETION_PAGE_TOO_LARGE',
    })
    request.mockImplementation(async () => {
      throw Object.assign(new Error('denied'), { rpcCode: -32000 })
    })
    await expect(readChannelCompletion(request, 'chat', 'turn')).rejects.toThrow('denied')
    expect(request.mock.calls.at(-1)?.[0]).toBe('thread/items/list')
    request.mockImplementationOnce(async () => ({ data: [], nextCursor: 'next' }))
    request.mockImplementationOnce(async () => {
      throw Object.assign(new Error('unsupported later'), { rpcCode: -32601 })
    })
    await expect(readChannelCompletion(request, 'chat', 'turn')).rejects.toThrow('unsupported later')
    expect(request.mock.calls.at(-1)?.[0]).toBe('thread/items/list')
  })
})
