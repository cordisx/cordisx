import { describe, expect, it, vi } from 'vitest'
import { NativeModelSource, parseNativeModelListPage } from '../packages/cli/src/renderer/adapter/native-model-list.js'

describe('native model list source', () => {
  it('parses visible model/list rows without inferring provider ownership', () => {
    expect(parseNativeModelListPage({
      data: [
        {
          id: 'protocol-a',
          model: 'model-a',
          displayName: 'Model A[Miniapp]',
          hidden: false,
          additionalSpeedTiers: ['fast'],
        },
        { id: 'protocol-hidden', model: 'hidden', displayName: 'Hidden', hidden: true },
      ],
      nextCursor: '100',
    })).toEqual({
      models: [{ id: 'model-a', label: 'Model A', disabled: false, supportsFastMode: true }],
      nextCursor: '100',
    })
    expect(parseNativeModelListPage({
      data: [{ id: 'protocol-a', model: 'model-a', displayName: 'Model A' }],
      nextCursor: null,
    })).toBeUndefined()
  })

  it('reads bounded pages, deduplicates models and retains last known good on failure', async () => {
    const source = new NativeModelSource()
    const request = vi.fn(async ({ cursor }: { cursor?: string }) =>
      cursor === undefined
        ? {
          data: [{ id: 'protocol-a', model: 'model-a', displayName: 'Model A', hidden: false }],
          nextCursor: 'next',
        }
        : {
          data: [
            { id: 'protocol-a-copy', model: 'model-a', displayName: 'Duplicate', hidden: false },
            { id: 'protocol-b', model: 'model-b', displayName: 'Model B', hidden: false },
          ],
          nextCursor: null,
        }
    )
    await source.refresh('openai', request)
    expect(source.snapshot()).toEqual({
      providerId: 'openai',
      models: [
        { id: 'model-a', label: 'Model A', disabled: false, supportsFastMode: false },
        { id: 'model-b', label: 'Model B', disabled: false, supportsFastMode: false },
      ],
    })
    expect(request).toHaveBeenCalledTimes(2)

    await source.refresh(
      'openai',
      vi.fn(async () => {
        throw new Error('unused')
      }),
    )
    expect(source.snapshot()?.models.map(model => model.id)).toEqual(['model-a', 'model-b'])
  })

  it('fails closed when a different base provider cannot produce a valid list', async () => {
    const source = new NativeModelSource()
    await source.refresh('openai', async () => ({
      data: [{ id: 'protocol-a', model: 'model-a', displayName: 'Model A', hidden: false }],
      nextCursor: null,
    }))
    await source.refresh('other', async () => ({ data: 'invalid' }))
    expect(source.snapshot()).toBeUndefined()
  })

  it('ignores an older provider response after a newer provider refresh completes', async () => {
    const source = new NativeModelSource()
    let resolveOpenAI!: (value: unknown) => void
    const openAI = source.refresh('openai', () =>
      new Promise(resolve => {
        resolveOpenAI = resolve
      }))
    await source.refresh('deepseek', async () => ({
      data: [{ id: 'deepseek-protocol', model: 'deepseek-model', displayName: 'DeepSeek', hidden: false }],
      nextCursor: null,
    }))
    resolveOpenAI({
      data: [{ id: 'openai-protocol', model: 'openai-model', displayName: 'OpenAI', hidden: false }],
      nextCursor: null,
    })
    await openAI
    expect(source.snapshot()).toEqual({
      providerId: 'deepseek',
      models: [{ id: 'deepseek-model', label: 'DeepSeek', disabled: false, supportsFastMode: false }],
    })
  })

  it('ignores a response that completes after the source is cleared', async () => {
    const source = new NativeModelSource()
    let resolve!: (value: unknown) => void
    const refresh = source.refresh('openai', () =>
      new Promise(done => {
        resolve = done
      }))
    source.clear()
    resolve({
      data: [{ id: 'openai-protocol', model: 'openai-model', displayName: 'OpenAI', hidden: false }],
      nextCursor: null,
    })
    await refresh
    expect(source.snapshot()).toBeUndefined()
  })
})
