import { request } from 'node:http'
import { lstat, readFile } from 'node:fs/promises'
import path from 'node:path'

/** Node-only client. The descriptor is a restricted local capability, never prompt text. */
export async function invokeAgentTool(
  input: { readonly bindingPath: string; readonly input: unknown },
): Promise<unknown> {
  if (!path.isAbsolute(input.bindingPath)) throw new Error('agent tool binding path must be absolute')
  const metadata = await lstat(input.bindingPath)
  if (!metadata.isFile() || (metadata.mode & 0o077) !== 0 || metadata.size > 16_384) {
    throw new Error('invalid agent tool binding file')
  }
  const descriptor = JSON.parse(await readFile(input.bindingPath, 'utf8')) as Record<string, unknown>
  if (
    descriptor.contract !== 'cordisx.agent-tool-binding/v1' || typeof descriptor.socketPath !== 'string'
    || !path.isAbsolute(descriptor.socketPath) || typeof descriptor.token !== 'string'
  ) throw new Error('invalid agent tool binding')
  const body = JSON.stringify({ input: input.input })
  if (Buffer.byteLength(body) > 65_536) throw new Error('agent tool input is too large')
  return await new Promise((resolve, reject) => {
    const call = request({
      socketPath: descriptor.socketPath as string,
      path: '/invoke',
      method: 'POST',
      headers: {
        authorization: `Bearer ${descriptor.token}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      },
    }, response => {
      let source = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        source += chunk
        if (source.length > 1_048_576) call.destroy(new Error('agent tool receipt is too large'))
      })
      response.on('end', () => {
        try {
          const result = JSON.parse(source) as { ok?: boolean; value?: unknown }
          if (response.statusCode !== 200 || result.ok !== true) {
            throw new Error('agent tool invocation rejected or unavailable')
          }
          resolve(result.value)
        } catch {
          reject(new Error('agent tool invocation rejected or unavailable'))
        }
      })
    })
    call.setTimeout(30_000, () => call.destroy(new Error('agent tool timed out; outcome unknown')))
    call.on('error', () => reject(new Error('agent tool transport unavailable; outcome may be unknown')))
    call.end(body)
  })
}
