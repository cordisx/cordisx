import type { CdpSharedAdmission } from './cdp-shared-admission.js'
import type {
  DesktopManagerConfigProof,
  RendererConfigOperation,
  RendererConfigResult,
} from './renderer-config-management.js'

export interface DesktopConfigurationReservation {
  isCurrent(): boolean
  release(): boolean
  fence(): void
  readonly desktopConfiguration: {
    readonly seat: object
    proof(pluginId: string): Promise<DesktopManagerConfigProof | undefined>
    update(operation: RendererConfigOperation): Promise<RendererConfigResult>
    confirm(): boolean
  }
}

/** Hold the native seat until its write and the owner's readback are settled. */
export function createDesktopConfigurationReservation(input: {
  readonly admission: CdpSharedAdmission
  readonly ownerCurrent: () => boolean
  readonly onEnd: () => void
  readonly onUncertain: () => void
}): DesktopConfigurationReservation {
  const seat = input.admission.configurationSeat()
  let ended = false
  let busy = false
  let dispatched = false
  let confirmed = false
  let cleaned = false
  let cleanupSucceeded = true
  let unsubscribe = () => {}
  const current = () => {
    try {
      return !ended && !input.admission.closed && input.ownerCurrent()
        && input.admission.configurationSeat() === seat
    } catch {
      return false
    }
  }
  const uncertain = () => {
    try {
      input.onUncertain()
    } catch { /* Keep the reservation closed even if owner cleanup fails. */ }
  }
  const cleanup = (): boolean => {
    if (cleaned) return cleanupSucceeded
    if (busy) return false
    cleaned = true
    unsubscribe()
    try {
      input.admission.release()
    } catch {
      cleanupSucceeded = false
      uncertain()
    } finally {
      try {
        input.onEnd()
      } catch {
        cleanupSucceeded = false
        uncertain()
      }
    }
    return cleanupSucceeded
  }
  const fence = () => {
    if (ended) return
    ended = true
    if (dispatched && !confirmed) uncertain()
    cleanup()
  }
  const perform = async <T>(action: () => Promise<T>, mutation: boolean): Promise<T> => {
    if (busy || !current() || mutation && dispatched) {
      throw new Error('Desktop configuration reservation is unavailable')
    }
    busy = true
    if (mutation) dispatched = true
    try {
      const result = await action()
      if (!current()) throw new Error('Desktop configuration reservation is stale')
      return result
    } finally {
      busy = false
      if (ended) cleanup()
    }
  }
  unsubscribe = input.admission.onInvalidated(fence)
  return {
    isCurrent: current,
    release() {
      if (ended) return false
      if (busy) {
        fence()
        return false
      }
      if (!current() || dispatched && !confirmed) {
        fence()
        return false
      }
      ended = true
      return cleanup()
    },
    fence,
    desktopConfiguration: {
      seat,
      proof: async pluginId => await perform(async () => await input.admission.configurationProof(pluginId), false),
      update: async operation => {
        if (operation.action !== 'update') throw new Error('Desktop configuration reservation is unavailable')
        return await perform(async () => await input.admission.configuration(operation), true)
      },
      confirm: () => {
        if (busy || !dispatched || !current()) return false
        confirmed = true
        return true
      },
    },
  }
}
