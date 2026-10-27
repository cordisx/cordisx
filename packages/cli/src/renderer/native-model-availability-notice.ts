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
    type: 'warning',
    message: chinese ? '增强模型切换暂不可用' : 'Enhanced model switching is unavailable',
    description: chinese
      ? '当前窗口保留 Codex 原生选择器和已有模型配置。连接管理仍可使用；当前窗口的增强切换需要更新适配。'
      : 'This window retains the native Codex selector and existing model configuration. Connection management remains available; enhanced switching needs an adapter update.',
  })
  return () => owner?.dispose()
}
