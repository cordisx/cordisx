/** Runs only in the opaque child frame. No Host services or credentials are captured. */
export function gameUiBootstrap(token: string): void {
  let port: MessagePort | undefined
  let snapshot: any
  let counter = 0
  let ended = false
  const listeners = new Set<(value: any) => void>()
  const roomActions = new Set(['ready', 'cancel-ready', 'start', 'funding'])
  const pending = new Map<string, { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }>()
  function request(kind: string, payload: unknown = null) {
    if (!port || !snapshot || ended) return Promise.resolve({ status: 'rejected', code: 'not-connected' })
    const requestId = `${token}-${++counter}`
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        pending.delete(requestId)
        resolve({ status: 'uncertain', code: 'response-timeout' })
      }, 15000)
      pending.set(requestId, { resolve, timer })
      port!.postMessage({
        version: 1,
        type: 'request',
        requestId,
        matchId: snapshot.matchId,
        sequence: snapshot.sequence,
        kind,
        payload,
      })
    })
  }
  Object.defineProperty(globalThis, 'GameUI', {
    value: Object.freeze({
      version: 1,
      subscribe(listener: (value: any) => void) {
        listeners.add(listener)
        if (snapshot) listener(snapshot)
        return () => listeners.delete(listener)
      },
      action: (payload: unknown) => request('action', payload),
      requestRoomAction: (operation: unknown) =>
        roomActions.has(String(operation))
          ? request('room-action', { operation })
          : Promise.resolve({ status: 'rejected', code: 'invalid-action' }),
      requestExit: () => request('exit'),
      requestNextRound: () => request('next-round'),
      reconnect: () => port?.postMessage({ version: 1, type: 'snapshot-request' }),
    }),
  })
  const connect = (event: MessageEvent) => {
    if (
      event.source !== parent || event.data?.type !== 'game-ui-connect' || event.data.token !== token || port || ended
    ) return
    const transferred = event.ports[0]
    if (!transferred) return
    port = transferred
    removeEventListener('message', connect)
    port.onmessage = ({ data }) => {
      if (data?.version !== 1 || ended) return
      if (data.type === 'snapshot') {
        snapshot = data.snapshot
        document.documentElement.dataset.theme = snapshot.theme
        for (const listener of listeners) listener(snapshot)
      } else if (data.type === 'reply') {
        const item = pending.get(data.requestId)
        if (item) {
          clearTimeout(item.timer)
          pending.delete(data.requestId)
          item.resolve(data.reply)
        }
      } else if (data.type === 'disposed') {
        ended = true
        for (const item of pending.values()) {
          clearTimeout(item.timer)
          item.resolve({ status: 'uncertain', code: 'disposed' })
        }
        pending.clear()
        port?.close()
      }
    }
    port.start()
    port.postMessage({
      version: 1,
      type: 'ready',
      capabilities: ['snapshot', 'action', 'room-action', 'room-request'],
    })
  }
  addEventListener('message', connect)
  parent.postMessage({ type: 'game-ui-hello', token, versions: [1] }, '*')
}
