import type { IncomingMessage, ServerResponse } from 'node:http'

export function managerWebJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(value))
}

export async function managerWebBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let length = 0
  for await (const part of request) {
    const chunk = Buffer.isBuffer(part) ? part : Buffer.from(part)
    length += chunk.length
    if (length > 1_048_576) throw new Error('REQUEST_TOO_LARGE')
    chunks.push(chunk)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
}

export function managerWebObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}
