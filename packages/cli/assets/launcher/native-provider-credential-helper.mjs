import { lstat, realpath } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'

async function main() {
  const [socketPath, operationHandle, extra] = process.argv.slice(2)
  if (
    extra !== undefined || typeof socketPath !== 'string' || !path.isAbsolute(socketPath)
    || Buffer.byteLength(socketPath) > 103
    || typeof operationHandle !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(operationHandle)
  ) throw new Error('invalid invocation')
  const directory = path.dirname(socketPath)
  const parent = await lstat(directory)
  const socketMetadata = await lstat(socketPath)
  const uid = process.getuid?.()
  if (
    uid === undefined || !parent.isDirectory() || parent.isSymbolicLink()
    || parent.uid !== uid || (parent.mode & 0o077) !== 0 || await realpath(directory) !== directory
    || !socketMetadata.isSocket() || socketMetadata.isSymbolicLink()
    || socketMetadata.uid !== uid || (socketMetadata.mode & 0o077) !== 0
  ) throw new Error('invalid credential socket')

  const response = await new Promise(resolve => {
    const socket = createConnection(socketPath)
    let bytes = Buffer.alloc(0)
    let settled = false
    const finish = value => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(undefined), 5000)
    socket.once('connect', () => socket.write(`${JSON.stringify({ operationHandle })}\n`))
    socket.on('data', chunk => {
      if (bytes.byteLength + chunk.byteLength > 65_536) finish(undefined)
      else bytes = Buffer.concat([bytes, chunk])
    })
    socket.once('end', () => finish(bytes.toString('utf8')))
    socket.once('error', () => finish(undefined))
    socket.once('close', () => finish(undefined))
  })
  if (typeof response !== 'string') throw new Error('credential request failed')
  const parsed = JSON.parse(response)
  if (
    parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || Object.keys(parsed).sort().join(',') !== 'credential,ok' || parsed.ok !== true
    || typeof parsed.credential !== 'string' || parsed.credential.length === 0
    || Buffer.byteLength(parsed.credential) > 32_768 || /[\u0000-\u0020\u007f]/u.test(parsed.credential)
  ) throw new Error('credential response failed')
  process.stdout.write(parsed.credential)
}

main().catch(() => {
  process.exitCode = 1
})
