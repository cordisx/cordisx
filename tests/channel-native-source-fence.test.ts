import { describe, expect, it } from 'vitest'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'

describe('owner native source fence', () => {
  it('waits for earlier writes, blocks later writes and permits bounded reads', () => {
    let persisted = false
    const fence = new ChannelNativeSourceFence(() => persisted)
    const releaseWrite = fence.enterNative('turn/start', { threadId: 'source' })
    expect(fence.beginMigration('source')).toBeUndefined()
    releaseWrite()
    const release = fence.beginMigration('source')!
    expect(() => fence.enterNative('thread/fork', { threadId: 'source' })).toThrow('CONTINUATION_PENDING')
    expect(() => fence.enterNative('thread/fork', fence.allowFork('source', { threadId: 'source' }))).not.toThrow()
    expect(() => fence.enterNative('turn/start', fence.allowFork('source', { threadId: 'source' }))).toThrow(
      'CONTINUATION_PENDING',
    )
    expect(() => fence.enterNative('thread/settings/update', { threadId: 'source' })).toThrow('CONTINUATION_PENDING')
    expect(() => fence.enterNative('thread/items/list', { threadId: 'source' })).not.toThrow()
    expect(() => fence.enterNative('turn/start', { threadId: 'other' })).not.toThrow()
    release()
    persisted = true
    expect(() => fence.enterNative('turn/start', { threadId: 'source' })).toThrow('CONTINUATION_PENDING')
  })
  it('does not let an old release unlock a later migration', () => {
    const fence = new ChannelNativeSourceFence(() => false)
    const first = fence.beginMigration('source')!
    first()
    const second = fence.beginMigration('source')!
    first()
    expect(() => fence.enterNative('turn/start', { threadId: 'source' })).toThrow('CONTINUATION_PENDING')
    second()
    expect(() => fence.enterNative('turn/start', { threadId: 'source' })).not.toThrow()
  })
})
