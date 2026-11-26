import { describe, expect, it, vi } from 'vitest'
import { channelNativeCreationSelection } from '../packages/cli/src/launcher/channel-native-creation-selection.js'

describe('Channel native creation selection', () => {
  it('preserves the configured service default when the native owner uses OpenAI for recovery', async () => {
    const list = vi.fn(async () => ({ providers: [{ providerId: 'openai', defaultModelId: 'native' }] }))
    expect(await channelNativeCreationSelection({}, { fallbackProviderId: 'service', fallbackModel: 'model' }, list))
      .toEqual({ providerId: 'service', model: 'model' })
    expect(list).not.toHaveBeenCalled()
  })
  it('preserves an explicit profile provider and resolves its own model', async () => {
    const list = vi.fn(async () => ({ providers: [{ providerId: 'openai', defaultModelId: 'official' }] }))
    expect(
      await channelNativeCreationSelection(
        { providerId: 'openai', fast: true },
        { fallbackProviderId: 'service', fallbackModel: 'model' },
        list,
      ),
    ).toEqual({ providerId: 'openai', model: 'official', fast: true })
  })
  it('keeps an explicit provider and model together ahead of the fallback', async () => {
    const list = vi.fn(async () => ({ providers: [] }))
    expect(
      await channelNativeCreationSelection(
        { providerId: 'openai', model: 'official' },
        { providerId: 'service', model: 'model', fallbackProviderId: 'service', fallbackModel: 'other' },
        list,
      ),
    ).toEqual({ providerId: 'service', model: 'model' })
    expect(list).not.toHaveBeenCalled()
  })
})
