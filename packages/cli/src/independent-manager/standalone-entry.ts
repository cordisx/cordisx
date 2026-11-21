import { startStandaloneManager } from './standalone-client.js'

// The existing Manager bundle owns all product UI. This entry only describes
// startup and failure for the opt-in independent Host document.
const status = document.createElement('p')
status.setAttribute('role', 'status')
status.textContent = '正在连接 CordisX…'
document.body.append(status)
let failed = false
const unavailable = () => {
  failed = true
  status.textContent = 'CordisX 连接不可用，请重新打开管理页面。'
  status.hidden = false
}
if (location.pathname !== '/' || new URL(location.href).searchParams.get('host') !== '1') {
  unavailable()
} else {
  const manager = startStandaloneManager({ window, onUnavailable: unavailable })
  void manager.ready.then(ready => {
    if (ready && !failed) status.hidden = true
  })
}
