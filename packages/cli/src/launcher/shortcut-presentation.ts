import { readFile } from 'node:fs/promises'
import { CdpSession } from './cdp-session.js'
import { presentation, type ShortcutPresentation } from '../shortcuts/presentation.js'

/** Called only by the authenticated owning supervisor, never with caller-selected code or URLs. */
export async function readHostShortcutPresentation(endpoint: string): Promise<ShortcutPresentation> {
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) return { status: 'unavailable' }
  let session: CdpSession | undefined
  try {
    const response = await fetch(endpoint + '/json/list', { signal: AbortSignal.timeout(1000) })
    const targets = await response.json() as { type?: string; url?: string; webSocketDebuggerUrl?: string }[]
    const native = targets.filter(item => item.type === 'page' && item.url === 'app://-/index.html')
    const url = native.length === 1 ? native[0]?.webSocketDebuggerUrl : undefined
    if (!url || !url.startsWith(endpoint.replace('http:', 'ws:') + '/devtools/page/')) return { status: 'unavailable' }
    const source = await readFile(new URL('../../shortcut-presentation.js', import.meta.url), 'utf8')
    session = await CdpSession.connect(url)
    const result = await session.send('Runtime.evaluate', {
      expression: `(async()=>{${source}\nreturn await CordisXShortcutPresentation.readShortcutPresentation()})()`,
      awaitPromise: true,
      returnByValue: true,
    }, 3500)
    if (result.exceptionDetails) return { status: 'unavailable' }
    return presentation((result.result as { value?: unknown })?.value)
  } catch {
    return { status: 'unavailable' }
  } finally {
    session?.close()
  }
}
