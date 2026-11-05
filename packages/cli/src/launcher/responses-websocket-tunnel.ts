import { type IncomingMessage, request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import type { Duplex } from 'node:stream'

/** Relay one Responses upgrade to the exact registered endpoint. No redirects or frame replay. */
export function tunnelResponsesWebSocket(
  request: IncomingMessage,
  downstream: Duplex,
  downstreamHead: Buffer,
  target: string,
  active: Set<() => void>,
  hopHeaders: ReadonlySet<string>,
): void {
  const send = target.startsWith('https:') ? httpsRequest : httpRequest
  let upstream: Duplex | undefined
  const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !hopHeaders.has(key)))
  const handshake = send(target, {
    method: 'GET',
    headers: { ...headers, connection: 'Upgrade', upgrade: 'websocket' },
    agent: false,
  })
  const close = () => {
    active.delete(close)
    downstream.destroy()
    upstream?.destroy()
    handshake.destroy()
  }
  const reject = () => {
    if (downstream.destroyed) return close()
    downstream.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\nContent-Length: 0\r\n\r\n', close)
  }
  active.add(close)
  downstream.once('error', close).once('close', close)
  handshake.setTimeout(30_000, () => handshake.destroy())
  handshake.once('error', reject)
  handshake.once('response', response => {
    response.destroy()
    reject()
  })
  handshake.once('upgrade', (response, socket, upstreamHead) => {
    upstream = socket
    if (
      downstream.destroyed || response.statusCode !== 101 || response.headers.upgrade?.toLowerCase() !== 'websocket'
    ) {
      close()
      return
    }
    socket.setTimeout(0)
    upstream.once('error', close).once('close', close)
    let headers = 'HTTP/1.1 101 Switching Protocols\r\n'
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      headers += `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}\r\n`
    }
    downstream.write(headers + '\r\n')
    if (upstreamHead.length > 0) downstream.write(upstreamHead)
    if (downstreamHead.length > 0) upstream.write(downstreamHead)
    downstream.pipe(upstream).pipe(downstream)
  })
  handshake.end()
}
