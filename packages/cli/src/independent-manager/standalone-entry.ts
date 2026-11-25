import { startStandaloneManager } from './standalone-client.js'
import { createStandaloneStartup } from './standalone-startup.js'
import type { StandaloneStartupFailure } from '../renderer/manager/standalone-startup-contract.js'

// Show Host chrome immediately; the owner still controls every business operation.
let startup = createStandaloneStartup(document)
let failed = false
const unavailable = (reason?: StandaloneStartupFailure) => {
  failed = true
  delete document.documentElement.dataset.cordisxManagerReady
  if (startup.disposed) startup = createStandaloneStartup(document)
  startup.unavailable(reason)
}
if (location.pathname !== '/' || (location.search !== '' && location.search !== '?host=1')) {
  unavailable()
} else {
  const manager = startStandaloneManager({ window, onUnavailable: unavailable })
  void manager.ready.then(ready => {
    if (!ready || failed) return
    try {
      if (startup.connected()) {
        document.documentElement.dataset.cordisxManagerReady = 'true'
        return
      }
    } catch { /* A failed handoff must not expose a partially admitted Manager. */ }
    unavailable()
    void manager.close()
  })
}
