import { moveNotificationViewport } from '../notifications/host.js'
import { createRoot, type Root } from 'react-dom/client'
import { DialogCenter, type DialogEntry } from './model.js'
import { DialogShell } from './view.js'
import { HostThemeProjection } from '../host-theme.js'
import { mountDialogForm } from './form.js'
import styles from './styles.css'

const centers = new WeakMap<Document, DialogCenter>()
export const dialogCenterForDocument = (document: Document) => centers.get(document)
export function installDialogHost(document: Document): () => void {
  if (centers.has(document)) throw new Error('Dialog Host already installed')
  const chinese = (document.documentElement.lang || document.defaultView?.navigator.language || '').startsWith('zh')
  const center = new DialogCenter(
    chinese
      ? {
        cancel: '取消',
        close: '关闭',
        more: '更多',
        loading: '加载中…',
        failed: '暂时无法显示此内容。',
        retry: '重试',
      }
      : undefined,
  )
  centers.set(document, center)
  const theme = new HostThemeProjection(document)
  let lastInteraction: HTMLElement | null = null
  const rememberInteraction = (event: Event) => {
    const target = event.composedPath()[0]
    if (target instanceof document.defaultView!.HTMLElement) {
      lastInteraction = target.closest<HTMLElement>('button,input,textarea,select,a[href],[tabindex]')
    }
  }
  document.addEventListener('pointerdown', rememberInteraction, true)
  document.addEventListener('keydown', rememberInteraction, true)
  const mounts = new Map<DialogEntry, { host: HTMLElement; root: Root; dispose(): void }>()
  const render = () => {
    const visible = center.visible()
    moveNotificationViewport(document)
    for (const [entry, mount] of mounts) {
      if (visible.includes(entry)) continue
      mount.dispose()
      mounts.delete(entry)
    }
    for (const entry of visible) {
      let mounted = mounts.get(entry)
      if (!mounted) {
        const host = document.createElement('div')
        host.dataset.cordisxDialog = 'v1'
        const shadow = host.attachShadow({ mode: 'closed' })
        const style = document.createElement('style')
        style.textContent = styles
        shadow.append(style)
        const shell = document.createElement('div')
        shadow.append(shell)
        const body = document.createElement('div')
        body.slot = 'body'
        body.className = 'cxd-body-seat'
        host.append(body)
        document.body.append(host)
        const detach = theme.attach(host)
        const active = document.activeElement as HTMLElement | null
        const returnFocus = active && active !== document.body && !active.hasAttribute('data-cordisx-dialog')
          ? active
          : lastInteraction
        const root = createRoot(shell)
        let cleanup: void | (() => void)
        mounted = {
          host,
          root,
          dispose: () => {
            detach()
            host.remove()
            // Disposal can originate in another React root's effect cleanup.
            // Retire DOM synchronously, then unmount roots after that commit.
            queueMicrotask(() => {
              try {
                cleanup?.()
              } catch {
                entry.owner.report(entry.options.kind)
              } finally {
                try {
                  root.unmount()
                } finally {
                  document.defaultView?.requestAnimationFrame(() => {
                    if (returnFocus?.isConnected && !center.visible().length) returnFocus.focus()
                  })
                }
              }
            })
          },
        }
        mounts.set(entry, mounted)
        root.render(<DialogShell entry={entry} center={center} document={document} />)
        // Let React commit the modal before mounting content; teardown fences queued work.
        queueMicrotask(() => {
          if (entry.closed || !mounts.has(entry)) return
          try {
            cleanup = entry.form
              ? mountDialogForm(body, entry, center)
              : entry.mount?.({ container: body, props: entry.props, signal: entry.abort.signal, dialog: entry.handle })
          } catch {
            entry.owner.report(entry.options.kind)
            body.textContent = center.copy.failed
          }
        })
      }
      mounted.root.render(<DialogShell entry={entry} center={center} document={document} />)
    }
    moveNotificationViewport(document, mounts.get(visible.at(-1)!)?.host)
  }
  const unsubscribe = center.subscribe(render)
  return () => {
    center.dispose()
    unsubscribe()
    document.removeEventListener('pointerdown', rememberInteraction, true)
    document.removeEventListener('keydown', rememberInteraction, true)
    for (const mounted of mounts.values()) mounted.dispose()
    mounts.clear()
    theme.dispose()
    if (centers.get(document) === center) centers.delete(document)
  }
}
