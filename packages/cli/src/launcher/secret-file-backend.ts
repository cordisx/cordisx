import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { link, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { type LauncherKeychainBackend, LauncherKeychainError } from './secret-store.js'

const MAX_BYTES = 64 * 1024 + 29
const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT'
const valid = (value: string) => value.length > 0 && value.length <= 16 * 1024 && !/[\r\n\u0000]/u.test(value)

/** Linux Host-private storage. Encryption is at rest; its key belongs to the same OS user. */
export function createFileSecretBackend(homeDir: string): LauncherKeychainBackend {
  if (!path.isAbsolute(homeDir)) throw new LauncherKeychainError('UNAVAILABLE')
  const directory = path.join(homeDir, 'credentials', 'channel')
  const assertPrivate = (info: Stats, file: boolean) => {
    if (
      (file ? !info.isFile() || info.nlink !== 1 : !info.isDirectory())
      || info.uid !== process.geteuid?.() || (info.mode & 0o777) !== (file ? 0o600 : 0o700)
    ) throw new LauncherKeychainError('UNAVAILABLE')
  }
  async function prepare() {
    for (const dir of [path.dirname(directory), directory]) {
      await mkdir(dir, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      assertPrivate(await lstat(dir), false)
    }
  }
  async function read(file: string, maxBytes = MAX_BYTES) {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const info = await handle.stat()
      assertPrivate(info, true)
      if (info.size > maxBytes) throw new LauncherKeychainError('UNAVAILABLE')
      return await handle.readFile()
    } finally {
      await handle.close()
    }
  }
  async function write(file: string, value: Buffer, replace: boolean) {
    const temporary = path.join(directory, `.tmp-${randomBytes(16).toString('hex')}`)
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
      try {
        await handle.writeFile(value)
        await handle.sync()
      } finally {
        await handle.close()
      }
      if (replace) {
        await lstat(file).then(info => assertPrivate(info, true)).catch(error => {
          if (!missing(error)) throw error
        })
        await rename(temporary, file)
      } else {
        // Publish a complete key once; concurrent writers use the winner's key.
        await link(temporary, file).catch(error => {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        })
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
  async function key(create: boolean) {
    const file = path.join(directory, 'master-key')
    if (create) {
      try {
        await lstat(file)
      } catch (error) {
        if (!missing(error)) throw error
        if ((await readdir(directory)).some(name => name.endsWith('.enc'))) {
          throw new LauncherKeychainError('UNAVAILABLE')
        }
        const value = randomBytes(32)
        try {
          await write(file, value, false)
        } finally {
          value.fill(0)
        }
      }
    }
    const value = await read(file, 32)
    if (value.length !== 32) throw new LauncherKeychainError('UNAVAILABLE')
    return value
  }
  function location(service: string, account: string) {
    if (
      !/^cordisx\/channel\/[a-z0-9][a-z0-9._-]{0,63}$/.test(service) || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(account)
    ) {
      throw new LauncherKeychainError('UNAVAILABLE')
    }
    const aad = Buffer.from(JSON.stringify([service, account]))
    return { aad, file: path.join(directory, createHash('sha256').update(aad).digest('hex') + '.enc') }
  }
  async function bounded<T>(operation: () => Promise<T>): Promise<T> {
    try {
      await prepare()
      return await operation()
    } catch (error) {
      if (error instanceof LauncherKeychainError) throw error
      throw new LauncherKeychainError(missing(error) ? 'MISSING' : 'UNAVAILABLE')
    }
  }
  const backend: LauncherKeychainBackend = {
    read: (service, account) =>
      bounded(async () => {
        const { file, aad } = location(service, account)
        const encrypted = await read(file)
        // An existing credential without its key is damaged storage, not an unset field.
        const secretKey = await key(false).catch(() => {
          throw new LauncherKeychainError('UNAVAILABLE')
        })
        try {
          if (encrypted.length < 30 || encrypted[0] !== 1) throw new LauncherKeychainError('UNAVAILABLE')
          const cipher = createDecipheriv('aes-256-gcm', secretKey, encrypted.subarray(1, 13))
          cipher.setAAD(aad)
          cipher.setAuthTag(encrypted.subarray(13, 29))
          const value = Buffer.concat([cipher.update(encrypted.subarray(29)), cipher.final()]).toString('utf8')
          if (!valid(value)) throw new LauncherKeychainError('UNAVAILABLE')
          return value
        } finally {
          secretKey.fill(0)
        }
      }),
    upsert: (service, account, value) =>
      bounded(async () => {
        if (!valid(value)) throw new LauncherKeychainError('UNAVAILABLE')
        const { file, aad } = location(service, account)
        const secretKey = await key(true)
        try {
          const iv = randomBytes(12)
          const cipher = createCipheriv('aes-256-gcm', secretKey, iv)
          cipher.setAAD(aad)
          const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
          await write(file, Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]), true)
        } finally {
          secretKey.fill(0)
        }
      }),
    remove: (service, account) =>
      bounded(async () => {
        const { file } = location(service, account)
        await lstat(file).then(info => assertPrivate(info, true))
        await unlink(file)
      }),
    status: async (service, account) => {
      try {
        await backend.read(service, account)
        return 'set'
      } catch (error) {
        if (error instanceof LauncherKeychainError && error.code === 'MISSING') return 'unset'
        throw error
      }
    },
  }
  return backend
}
