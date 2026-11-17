import { describe, expect, it, vi } from 'vitest'
import {
  CHANNEL_PREPARATION_TOOLS,
  handlePreparationToolCall,
} from '../packages/cli/src/launcher/channel-live-dynamic-tools.js'

describe('native preparation tools', () => {
  it('accepts only the owned target and carries native exact-turn identity to Channel', async () => {
    const call = vi.fn(async () => ({ status: 'accepted' }))
    const native = { isPreparing: (id: string) => id === 'target' }
    const tools = { call }
    const params = {
      tool: 'cordisx_continuation_takeover_ready',
      threadId: 'target',
      turnId: 'turn',
      namespace: null,
      arguments: { token: 'a'.repeat(64) },
    }
    expect(CHANNEL_PREPARATION_TOOLS.map(item => item.name)).toEqual([
      'cordisx_continuation_history',
      'cordisx_continuation_takeover_ready',
    ])
    expect(await handlePreparationToolCall(params, native as never, tools as never)).toMatchObject({ success: true })
    expect(call).toHaveBeenCalledExactlyOnceWith('continuation-takeover-ready', params.arguments, {
      'x-codex-turn-metadata': JSON.stringify({ thread_id: 'target', turn_id: 'turn' }),
    })
    expect(await handlePreparationToolCall({ ...params, threadId: 'other' }, native as never, tools as never))
      .toMatchObject({ success: false })
    expect(call).toHaveBeenCalledTimes(1)
  })
})
