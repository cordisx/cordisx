import WebSocket from 'ws'

export async function connectLiveSmokeCdp(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)

  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`)

  const targets = await response.json()

  const target = targets.find(item => item.type === 'page' && item.url === 'app://-/index.html')

  if (target?.webSocketDebuggerUrl === undefined) throw new Error('main Codex page target not found')

  const socket = new WebSocket(target.webSocketDebuggerUrl)

  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  let nextId = 1

  const pending = new Map()

  const runtimeExceptions = []

  socket.on('message', (data) => {
    const message = JSON.parse(data.toString())
    if (message.method === 'Runtime.exceptionThrown') {
      const detail = message.params?.exceptionDetails
      runtimeExceptions.push(detail?.exception?.description ?? detail?.text ?? 'unknown renderer exception')
      return
    }
    if (message.id === undefined) return
    const callback = pending.get(message.id)
    if (callback === undefined) return
    pending.delete(message.id)
    if (message.error !== undefined) callback.reject(new Error(message.error.message))
    else callback.resolve(message.result ?? {})
  })

  function send(method, params = {}) {
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }), error => {
        if (error == null) return
        pending.delete(id)
        reject(error)
      })
    })
  }

  async function pointerClick(rect) {
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, pointerType: 'mouse' })
    await send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      pointerType: 'mouse',
    })
    await send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
      pointerType: 'mouse',
    })
  }

  async function pressKey(key, code, keyCode) {
    await send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      ...(key.length === 1 ? { text: key } : {}),
    })
    await send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
    })
  }

  return { socket, runtimeExceptions, send, pointerClick, pressKey }
}
