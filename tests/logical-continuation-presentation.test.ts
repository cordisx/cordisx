import { describe, expect, it, vi } from 'vitest'
import { ChannelNativeSourceFence } from '../packages/cli/src/launcher/channel-native-source-fence.js'
import {
  logicalPresentation,
  placeLogicalDestination,
} from '../packages/cli/src/launcher/logical-continuation-presentation.js'

function fixture() {
  const source: any = { id: 'source', name: 'Existing title', projectId: 'project', section: { id: 'section' } }
  const target: any = { id: 'destination', name: null, projectId: null, section: null }
  const native = {
    nativeRequest: vi.fn(async (method: string, params: any) => {
      if (method === 'thread/read') return { thread: structuredClone(params.threadId === 'source' ? source : target) }
      if (method === 'thread/metadata/update') target.projectId = params.projectId
      if (method === 'thread/name/set') target.name = params.name
      if (method === 'thread/section/move') target.section = { id: params.sectionId }
      if (method === 'thread/list') return { data: [{ id: 'destination' }, { id: 'source' }], nextCursor: null }
      return {}
    }),
  }
  const fence = new ChannelNativeSourceFence(() => false)
  fence.beginMigration('destination')
  return { source, target, native, fence }
}

describe('logical continuation presentation', () => {
  it('keeps the native name, project and explicitly ordered section', async () => {
    const f = fixture(), source = await logicalPresentation(f.native as never, 'source')
    expect(source).toEqual({ name: 'Existing title', projectId: 'project', sectionId: 'section' })
    expect(
      await placeLogicalDestination(f.native as never, f.fence, 'source', 'destination', source!, () => true, [
        'source',
        'target',
      ]),
    )
      .toBe(true)
    expect(f.target).toEqual({
      id: 'destination',
      name: 'Existing title',
      projectId: 'project',
      section: { id: 'section' },
    })
    expect(f.native.nativeRequest).toHaveBeenCalledWith(
      'thread/section/move',
      expect.objectContaining({
        threadId: 'destination',
        sectionId: 'section',
        beforeThreadId: 'source',
      }),
    )
  })
  it('does not infer missing project or section metadata', async () => {
    const f = fixture()
    delete f.source.projectId
    expect(await logicalPresentation(f.native as never, 'source')).toBeUndefined()
  })
  it('fails closed if the source changes while the destination is being prepared', async () => {
    const f = fixture(), source = await logicalPresentation(f.native as never, 'source')
    const original = f.native.nativeRequest.getMockImplementation()!
    f.native.nativeRequest.mockImplementation(async (method, params) => {
      const result = await original(method, params)
      if (method === 'thread/name/set') f.source.name = 'User changed the title'
      return result
    })
    expect(
      await placeLogicalDestination(f.native as never, f.fence, 'source', 'destination', source!, () => true, [
        'source',
        'target',
      ]),
    )
      .toBe(false)
    expect(f.native.nativeRequest.mock.calls.some(([method]) => method === 'thread/section/move')).toBe(false)
  })
  it('does not claim the requested position if native order readback disagrees', async () => {
    const f = fixture(), source = await logicalPresentation(f.native as never, 'source')
    const original = f.native.nativeRequest.getMockImplementation()!
    f.native.nativeRequest.mockImplementation(async (method, params) =>
      method === 'thread/list' ? { data: [{ id: 'source' }, { id: 'destination' }] } : await original(method, params)
    )
    expect(
      await placeLogicalDestination(f.native as never, f.fence, 'source', 'destination', source!, () => true, [
        'source',
        'target',
      ]),
    )
      .toBe(false)
  })
})
