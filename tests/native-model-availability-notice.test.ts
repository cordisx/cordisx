import { describe, expect, it, vi } from 'vitest'
import { reportNativeModelSelectionUnavailable } from '../packages/cli/src/renderer/native-model-availability-notice.js'

const show = vi.fn()
const dispose = vi.fn()
const bind = vi.fn(() => ({ api: { show }, dispose }))
vi.mock('../packages/cli/src/renderer/notifications/host.js', () => ({
  notificationCenterForDocument: () => ({ bind }),
}))

describe('native model availability notice', () => {
  it.each(['en', 'zh-CN'])('reports the native fallback under Host ownership and releases it (%s)', locale => {
    const stop = reportNativeModelSelectionUnavailable({} as Document, locale)
    expect(bind).toHaveBeenLastCalledWith(expect.objectContaining({
      key: 'host/native-model-selection',
      pluginId: 'cordisx',
    }))
    expect(show).toHaveBeenLastCalledWith(expect.objectContaining({
      kind: 'native.model-selection.unavailable',
      type: 'error',
      message: locale === 'en' ? 'CordisX model selection is unavailable' : 'CordisX 模型选择器暂不可用',
    }))
    stop()
    expect(dispose).toHaveBeenCalled()
  })
})
