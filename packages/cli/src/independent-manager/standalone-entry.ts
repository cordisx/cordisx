import { startStandaloneManager } from './standalone-client.js'
import { createStandaloneStartup } from './standalone-startup.js'
import type { StandaloneStartupFailure } from '../renderer/manager/standalone-startup-contract.js'

// Show Host chrome immediately; the owner still controls every business operation.
let startup = createStandaloneStartup(document)
let stopped = false
let retriedOpen = false
window.addEventListener('pagehide', () => stopped = true, { once: true })
const showUnavailable = (reason?: StandaloneStartupFailure) => {
  delete document.documentElement.dataset.cordisxManagerReady
  if (startup.disposed) startup = createStandaloneStartup(document)
  startup.unavailable(reason)
}

function start(): void {
  let failed = false
  let manager!: ReturnType<typeof startStandaloneManager>
  const unavailable = (reason?: StandaloneStartupFailure | 'open-refused') => {
    failed = true
    if (reason === 'open-refused' && !retriedOpen && !stopped && !startup.disposed) {
      retriedOpen = true
      // The client starts its confirmed-retirement close after this callback.
      queueMicrotask(() => {
        if (stopped) return
        void manager.close().then(() => {
          if (!stopped) start()
        })
      })
      return
    }
    showUnavailable(reason === 'open-refused' ? 'refresh' : reason)
  }
  manager = startStandaloneManager({ window, onUnavailable: unavailable })
  void manager.ready.then(ready => {
    if (!ready || failed || stopped) return
    try {
      if (startup.connected()) {
        document.documentElement.dataset.cordisxManagerReady = 'true'
        return
      }
    } catch { /* A failed handoff must not expose a partially admitted Manager. */ }
    showUnavailable()
    void manager.close()
  })
}

if (location.pathname !== '/' || (location.search !== '' && location.search !== '?host=1')) {
  showUnavailable()
} else {
  start()
}
