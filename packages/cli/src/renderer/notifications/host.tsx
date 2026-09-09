import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { NotificationCenter } from './model.js'
import { NotificationViewport } from './view.js'
import styles from './styles.css'
import { HostThemeProjection } from '../host-theme.js'

const centers = new WeakMap<Document, NotificationCenter>()
export function notificationCenterForDocument(document: Document) {
  return centers.get(document)
}

/** One renderer-owned viewport; plugin notifications never supply DOM or identity. */
export function installNotificationHost(document: Document, profileId: string): () => void {
  if (centers.has(document)) throw new Error('Notification Host already installed')
  const key = `cordisx:notifications:v1:${profileId}`
  const storage = () => {
    const value = document.defaultView?.localStorage
    if (!value) throw new Error('Notification preferences unavailable')
    return value
  }
  const center = new NotificationCenter({
    read: () => JSON.parse(storage().getItem(key) ?? '[]'),
    write: rules => storage().setItem(key, JSON.stringify(rules)),
  })
  const container = document.createElement('div')
  container.className = 'cxn-root'
  container.dataset.cordisxNotifications = 'v1'
  const style = document.createElement('style')
  style.textContent = styles
  container.append(style)
  const seat = document.createElement('div')
  container.append(seat)
  document.body.append(container)
  const theme = new HostThemeProjection(document)
  const detachTheme = theme.attach(container)
  const root = createRoot(seat)
  flushSync(() => root.render(<NotificationViewport center={center} document={document} />))
  centers.set(document, center)
  let last = Date.now()
  const timer = setInterval(() => {
    const now = Date.now()
    center.tick(now - last, document.hidden)
    last = now
  }, 100)
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    clearInterval(timer)
    center.dispose()
    root.unmount()
    detachTheme()
    theme.dispose()
    container.remove()
    if (centers.get(document) === center) centers.delete(document)
  }
}
