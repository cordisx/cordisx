import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rm, rmdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { FileHandle } from 'node:fs/promises'

// The local RPC token authenticates and encrypts the request and result. A sandbox can
// share this directory while AF_UNIX and the Host PID are unavailable to it.
const MAX_BYTES = 256 * 1024
const MAX_RESULT_BYTES = 8 * 1024 * 1024
const MAX_AGE_MS = 60_000
const POLL_MS = 100
const idPattern = /^[a-f0-9]{32}$/u

function key(token: string) {
  return createHash('sha256').update('cordisx-management-mailbox-v1\0').update(token).digest()
}
function seal(token: string, id: string, direction: string, value: unknown): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key(token), iv)
  cipher.setAAD(Buffer.from(`${direction}\0${id}`))
  const bytes = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
  return JSON.stringify({
    iv: iv.toString('hex'),
    tag: cipher.getAuthTag().toString('hex'),
    data: bytes.toString('base64'),
  })
}
function unseal(token: string, id: string, direction: string, payload: string): unknown {
  const value = JSON.parse(payload) as { iv?: unknown; tag?: unknown; data?: unknown }
  if (
    typeof value.iv !== 'string' || !/^[a-f0-9]{24}$/u.test(value.iv)
    || typeof value.tag !== 'string' || !/^[a-f0-9]{32}$/u.test(value.tag)
    || typeof value.data !== 'string'
  ) throw new Error('INVALID_MAILBOX_ENVELOPE')
  const decipher = createDecipheriv('aes-256-gcm', key(token), Buffer.from(value.iv, 'hex'))
  decipher.setAAD(Buffer.from(`${direction}\0${id}`))
  decipher.setAuthTag(Buffer.from(value.tag, 'hex'))
  return JSON.parse(
    Buffer.concat([decipher.update(Buffer.from(value.data, 'base64')), decipher.final()]).toString('utf8'),
  )
}
async function readBounded(file: string, max: number): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > max) throw new Error('INVALID_MAILBOX_FILE')
    // Bound the allocation and the read even if a writable file grows after stat.
    const buffer = Buffer.allocUnsafe(info.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== info.size) throw new Error('INVALID_MAILBOX_FILE')
    return buffer.subarray(0, offset).toString('utf8')
  } finally {
    await handle.close()
  }
}
export function managementMailboxPath(socketDirectory: string, mailboxId: string): string {
  if (!idPattern.test(mailboxId)) throw new Error('INVALID_MAILBOX_ID')
  return path.join(socketDirectory, `mailbox-${mailboxId}`)
}

/** One launch owns this directory and token. Requests cannot be replayed during its lifetime. */
export async function startManagementMailbox(input: {
  directory: string
  token: string
  parentHandle?: FileHandle
  dispatch(value: unknown): Promise<unknown>
}): Promise<{ close(): Promise<void> }> {
  // Pin both parent and child: a sandbox sharing /tmp may replace either
  // pathname after startup, but cannot redirect host operations through it.
  const parentHandle = input.parentHandle ?? (process.platform === 'linux'
    ? await open(path.dirname(input.directory), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    : undefined)
  const creationPath = parentHandle
    ? `/proc/self/fd/${parentHandle.fd}/${path.basename(input.directory)}`
    : input.directory
  let directoryHandle: FileHandle | undefined, created = false
  try {
    await mkdir(creationPath, { mode: 0o700 })
    created = true
    directoryHandle = await open(creationPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
    await directoryHandle.chmod(0o700)
  } catch (error) {
    await directoryHandle?.close().catch(() => undefined)
    if (created) await rmdir(creationPath).catch(() => undefined)
    await parentHandle?.close()
    throw error
  }
  const handle = directoryHandle
  const anchoredDirectory = parentHandle ? `/proc/self/fd/${handle.fd}` : input.directory
  const seen = new Map<string, number>(), inFlight = new Set<Promise<void>>()
  let closed = false, scanning = false
  const scan = async () => {
    if (closed || scanning) return
    scanning = true
    try {
      for (const [id, until] of seen) if (until < Date.now()) seen.delete(id)
      for (const name of (await readdir(anchoredDirectory)).slice(0, 512)) {
        if (closed || inFlight.size >= 32 || seen.size >= 4096) break
        const id = name.slice(0, -4)
        if (!name.endsWith('.req')) {
          if (/^[a-f0-9]{32}\.(res|tmp|response-tmp)$/u.test(name)) {
            const file = path.join(anchoredDirectory, name)
            const info = await lstat(file).catch(() => undefined)
            if (info && Date.now() - info.mtimeMs > MAX_AGE_MS * 2) {
              await rm(file, { force: true }).catch(() => undefined)
            }
          }
          continue
        }
        if (!idPattern.test(id) || seen.has(id)) continue
        seen.set(id, Date.now() + MAX_AGE_MS * 2)
        const task = (async () => {
          const requestFile = path.join(anchoredDirectory, name)
          try {
            const request = unseal(input.token, id, 'request', await readBounded(requestFile, MAX_BYTES)) as {
              createdAt?: unknown
              value?: unknown
            }
            if (
              closed || typeof request?.createdAt !== 'number' || Math.abs(Date.now() - request.createdAt) > MAX_AGE_MS
            ) return
            let result: unknown
            try {
              result = { ok: true, value: await input.dispatch(request.value) }
            } catch {
              result = { ok: false, error: 'plugin management request failed' }
            }
            if (closed) return
            const response = seal(input.token, id, 'response', result)
            if (Buffer.byteLength(response) > MAX_RESULT_BYTES) return
            const responseTmp = path.join(anchoredDirectory, `${id}.response-tmp`)
            try {
              await writeFile(responseTmp, response, { flag: 'wx', mode: 0o600 })
              await link(responseTmp, path.join(anchoredDirectory, `${id}.res`))
            } finally {
              await rm(responseTmp, { force: true })
            }
          } catch {
            // Unauthenticated, oversized, malformed, and expired entries never reach dispatch.
          } finally {
            await rm(requestFile, { force: true }).catch(() => undefined)
          }
        })()
        inFlight.add(task)
        void task.finally(() => inFlight.delete(task))
      }
    } finally {
      scanning = false
    }
  }
  const timer = setInterval(() => void scan().catch(() => undefined), POLL_MS)
  timer.unref()
  return {
    async close() {
      closed = true
      clearInterval(timer)
      // Ongoing dispatch may outlive shutdown. Defer descriptor cleanup until
      // it settles; never recursively remove a path a sandbox could replace.
      const cleanup = async () => {
        while (scanning) await new Promise(resolve => setTimeout(resolve, 10))
        await Promise.allSettled([...inFlight])
        for (const name of await readdir(anchoredDirectory).catch(() => [])) {
          if (/^[a-f0-9]{32}\.(req|res|tmp|response-tmp)$/u.test(name)) {
            await rm(path.join(anchoredDirectory, name), { force: true }).catch(() => undefined)
          }
        }
        await handle.close()
        // rmdir is non-recursive and the Linux parent descriptor prevents a
        // replaced parent from redirecting this cleanup to another directory.
        await rmdir(creationPath).catch(() => undefined)
        await parentHandle?.close()
      }
      const pending = cleanup()
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([
          pending,
          new Promise(resolve => {
            timeout = setTimeout(resolve, 2_000)
          }),
        ])
      } finally {
        if (timeout) clearTimeout(timeout)
      }
    },
  }
}

/** Never retry a published operation: a timeout may mean the Host already applied it. */
export async function requestManagementMailbox(input: {
  directory: string
  token: string
  value: unknown
  timeoutMs?: number
}): Promise<unknown> {
  const id = randomBytes(16).toString('hex')
  const request = path.join(input.directory, `${id}.req`), response = path.join(input.directory, `${id}.res`)
  const temporary = path.join(input.directory, `${id}.tmp`)
  const data = seal(input.token, id, 'request', { createdAt: Date.now(), value: input.value })
  if (Buffer.byteLength(data) > MAX_BYTES) throw new Error('MAILBOX_REQUEST_TOO_LARGE')
  // Exclusive creation prevents a peer from redirecting the write through a symlink.
  await writeFile(temporary, data, { flag: 'wx', mode: 0o600 })
  try {
    await link(temporary, request)
  } finally {
    await rm(temporary, { force: true })
  }
  const deadline = Date.now() + (input.timeoutMs ?? 60_000)
  try {
    while (Date.now() < deadline) {
      try {
        const result = unseal(input.token, id, 'response', await readBounded(response, MAX_RESULT_BYTES)) as {
          ok?: unknown
          value?: unknown
        }
        if (result?.ok !== true) throw new Error('MAILBOX_REQUEST_REJECTED')
        return result.value
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS))
    }
    throw new Error('MAILBOX_RESULT_UNKNOWN')
  } finally {
    await Promise.allSettled([rm(request, { force: true }), rm(response, { force: true })])
  }
}
