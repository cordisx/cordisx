import type { IncomingHttpHeaders, IncomingMessage, ServerResponse } from 'node:http'

/** Compress only when this resource worker and the browser both support Brotli. */
export function useBrotliManagerBundle(headers: IncomingHttpHeaders): boolean {
  if (headers['x-cordisx-resource-encoding'] !== 'br-v1' || typeof headers['accept-encoding'] !== 'string') {
    return false
  }
  let accepted = false
  let seen = false
  for (const part of headers['accept-encoding'].split(',')) {
    const [coding, ...parameters] = part.trim().toLowerCase().split(';').map(value => value.trim())
    if (coding !== 'br') continue
    if (seen) return false
    seen = true
    if (parameters.length === 0) {
      accepted = true
      continue
    }
    if (parameters.length !== 1) return false
    const match = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u.exec(parameters[0]!)
    if (!match) return false
    accepted = Number(match[1]) > 0
  }
  return accepted
}

/** The owner-authenticated bootstrap has already checked both representations. */
export function sendManagerBundle(
  request: IncomingMessage,
  response: ServerResponse,
  built: { readonly bundle: Buffer; readonly brotli: Buffer },
): void {
  const compressed = useBrotliManagerBundle(request.headers)
  const bytes = compressed ? built.brotli : built.bundle
  response.writeHead(200, {
    'content-type': 'text/javascript; charset=utf-8',
    'content-length': bytes.byteLength,
    'cache-control': 'private, no-store, max-age=0',
    'cross-origin-resource-policy': 'same-origin',
    vary: 'Accept-Encoding, X-Cordisx-Resource-Encoding',
    ...(compressed ? { 'content-encoding': 'br', 'x-cordisx-decoded-length': String(built.bundle.byteLength) } : {}),
  })
  response.end(request.method === 'HEAD' ? undefined : bytes)
}
