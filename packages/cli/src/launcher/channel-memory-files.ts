import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

export class MemoryFiles {
  constructor(readonly root: string) {}
  async prepare(): Promise<void> {
    if (!path.isAbsolute(this.root) || path.parse(this.root).root === this.root) {
      throw new Error('MEMORY_UNSAFE_ROOT')
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 })
    const stat = await lstat(this.root)
    if (
      stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid()
      || await realpath(this.root) !== path.resolve(this.root)
    ) {
      throw new Error('MEMORY_UNSAFE_ROOT')
    }
  }
  file(name: string): string {
    if (!/^(?:state|index|lock|[a-f0-9-]{36}(?:-[1-9][0-9]*)?)\.json$/u.test(name)) {
      throw new Error('MEMORY_UNSAFE_PATH')
    }
    return path.join(this.root, name)
  }
  async read(name: string): Promise<unknown> {
    const handle = await open(this.file(name), constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile() || stat.size > 4_000_000) throw new Error('MEMORY_INVALID_FILE')
      return JSON.parse(await handle.readFile('utf8')) as unknown
    } finally {
      await handle.close()
    }
  }
  async write(name: string, value: unknown): Promise<void> {
    const encoded = JSON.stringify(value)
    if (Buffer.byteLength(encoded) > 4_000_000) throw new Error('MEMORY_CAPACITY_EXCEEDED')
    const temporary = this.file(`${randomUUID()}.json`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(encoded)
      await handle.sync()
    } finally {
      await handle.close()
    }
    try {
      await rename(temporary, this.file(name))
      const directory = await open(this.root, constants.O_RDONLY)
      try {
        await directory.sync()
      } finally {
        await directory.close()
      }
    } catch (error) {
      await unlink(temporary).catch(() => {})
      throw error
    }
  }
  async locked<Result>(operation: () => Promise<Result>): Promise<Result> {
    await this.prepare()
    const lock = await open(this.file('lock.json'), 'wx', 0o600).catch(() => {
      throw new Error('MEMORY_BUSY')
    })
    try {
      return await operation()
    } finally {
      await lock.close()
      await unlink(this.file('lock.json'))
    }
  }
}
