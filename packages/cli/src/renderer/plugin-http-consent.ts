import { createElement } from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { type PluginHttpConsentCopy, PluginHttpConsentView } from './host-ui/PluginHttpConsentView.js'
import { HostThemeProjection } from './host-theme.js'

type PluginHttpConsentResult =
  | { readonly approved: false }
  | { readonly approved: true; readonly secret?: string }

const COPY: Readonly<Record<'en' | 'zh-CN', PluginHttpConsentCopy>> = Object.freeze({
  en: Object.freeze({
    heading: 'Allow server connection',
    description: 'The Host will make restricted same-origin requests to this server for the plugin.',
    pluginLabel: 'Plugin',
    serverLabel: 'Server',
    tokenLabel: 'Access token',
    tokenHint: 'The Host stores this token in the system keychain. Plugin code cannot read it.',
    cancel: 'Cancel',
    allow: 'Allow',
  }),
  'zh-CN': Object.freeze({
    heading: '允许服务器连接',
    description: '宿主将代表此插件向该服务器发送受限的同源请求。',
    pluginLabel: '插件',
    serverLabel: '服务器',
    tokenLabel: '访问令牌',
    tokenHint: '宿主会将此令牌保存在系统钥匙串中，插件代码无法读取。',
    cancel: '取消',
    allow: '允许',
  }),
})

let sequence = 0

function focusable(root: HTMLElement): readonly HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex]')]
    .filter(node => node.tabIndex >= 0 && !node.hidden && node.closest('[hidden]') === null)
}

/** Host-owned consent. The callback and secret value are never supplied to plugin code. */
export async function captureHttpConsent(input: {
  readonly pluginId: string
  readonly origin: string
  readonly credential: 'none' | 'bearer'
  readonly signal: AbortSignal
}): Promise<PluginHttpConsentResult> {
  if (input.signal.aborted || typeof document === 'undefined') return { approved: false }
  const hostDocument = document
  const HTMLElementConstructor = hostDocument.defaultView?.HTMLElement
  const previousFocus = HTMLElementConstructor !== undefined
      && hostDocument.activeElement instanceof HTMLElementConstructor
    ? hostDocument.activeElement as HTMLElement
    : undefined
  const overlay = hostDocument.createElement('div')
  overlay.className = 'cxp-overlay cxh-tdesign-root'
  overlay.dataset.pluginHttpConsent = input.pluginId
  overlay.style.setProperty('-webkit-app-region', 'no-drag')
  const theme = new HostThemeProjection(hostDocument)
  const detachTheme = theme.attach(overlay)
  hostDocument.body.append(overlay)
  const root = createRoot(overlay)
  const id = ++sequence
  const headingId = `cxp-http-heading-${id}`
  const descriptionId = `cxp-http-description-${id}`
  const copy = COPY[hostDocument.documentElement.lang.startsWith('zh') ? 'zh-CN' : 'en']

  return await new Promise(resolve => {
    let finished = false
    const cleanup = (): boolean => {
      if (finished) return false
      finished = true
      input.signal.removeEventListener('abort', abort)
      overlay.removeEventListener('keydown', keyboard)
      overlay.removeEventListener('click', backdrop)
      const secret = overlay.querySelector<HTMLInputElement>('input[type="password"]')
      if (secret !== null) secret.value = ''
      root.unmount()
      detachTheme()
      theme.dispose()
      overlay.remove()
      if (previousFocus?.isConnected) previousFocus.focus()
      return true
    }
    const finish = (result: PluginHttpConsentResult): void => {
      if (cleanup()) resolve(result)
    }
    const abort = (): void => finish({ approved: false })
    const keyboard = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        finish({ approved: false })
        return
      }
      if (event.key !== 'Tab') return
      const candidates = focusable(overlay)
      const first = candidates[0]
      const last = candidates.at(-1)
      if (first === undefined || last === undefined) return
      if (event.shiftKey && hostDocument.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && hostDocument.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const backdrop = (event: MouseEvent): void => {
      if (event.target === overlay) finish({ approved: false })
    }
    input.signal.addEventListener('abort', abort, { once: true })
    overlay.addEventListener('keydown', keyboard)
    overlay.addEventListener('click', backdrop)
    try {
      flushSync(() =>
        root.render(createElement(PluginHttpConsentView, {
          overlay,
          headingId,
          descriptionId,
          pluginId: input.pluginId,
          origin: input.origin,
          credential: input.credential,
          copy,
          finish,
        }))
      )
      ;(overlay.querySelector<HTMLElement>('input[type="password"]')
        ?? overlay.querySelector<HTMLElement>('[data-plugin-http-action="allow"]'))?.focus()
    } catch {
      finish({ approved: false })
    }
  })
}
