import { readNativeCurrentUser } from './native.js'
import { presentation, type ShortcutPresentation } from '../../shortcuts/presentation.js'

/** Host-owned projection shared with the existing current-user source. No identity crosses this boundary. */
export async function readShortcutPresentation(): Promise<ShortcutPresentation> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 2800)
  try {
    return await Promise.race([
      readNativeCurrentUser(controller.signal).then(value => presentation(value)),
      new Promise<ShortcutPresentation>(resolve =>
        controller.signal.addEventListener('abort', () => resolve({ status: 'unavailable' }), { once: true })
      ),
    ])
  } catch {
    return { status: 'unavailable' }
  } finally {
    clearTimeout(timer)
    controller.abort()
  }
}
