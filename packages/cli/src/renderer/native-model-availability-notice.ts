import { notificationCenterForDocument } from './notifications/host.js'

/** A usable native fallback must not look like a successful CordisX takeover. */
export function reportNativeModelSelectionUnavailable(document: Document, locale: string): () => void {
  const owner = notificationCenterForDocument(document)?.bind({
    key: 'host/native-model-selection',
    pluginId: 'cordisx',
    active: () => true,
    presentation: () => ({ name: 'CordisX' }),
  })
  const chinese = locale.startsWith('zh')
  owner?.api.show({
    kind: 'native.model-selection.unavailable',
    type: 'error',
    message: chinese ? 'CordisX 模型选择器暂不可用' : 'CordisX model selection is unavailable',
    description: chinese
      ? '当前窗口保留 Codex 原生选择器。自定义模型切换未接入，请查看启动诊断并更新 CordisX。'
      : 'This window retains the native Codex selector. Custom model switching is unavailable; check startup diagnostics and update CordisX.',
  })
  return () => owner?.dispose()
}
