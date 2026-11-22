import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import path from 'node:path'

export class MemoryFiles {
  private canonicalRoot?: string
  constructor(readonly root: string) {}
  async prepare(): Promise<void> {
    if (!path.isAbsolute(this.root) || path.parse(this.root).root === this.root) {
      throw new Error('MEMORY_UNSAFE_ROOT')
    }
    const requested = path.resolve(this.root)
    await mkdir(requested, { recursive: true, mode: 0o700 })
    const stat = await lstat(requested)
    // Ancestors may be symlinks (including a platform's temporary directory).
    // The memory directory itself must remain a private, owned real directory.
    const canonical = path.join(await realpath(path.dirname(requested)), path.basename(requested))
    const resolved = await realpath(requested)
    const actual = await lstat(canonical)
    if (
      stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o077) !== 0
      || process.getuid && stat.uid !== process.getuid()
      || actual.isSymbolicLink() || !actual.isDirectory() || (actual.mode & 0o077) !== 0
      || process.getuid && actual.uid !== process.getuid()
      || resolved !== canonical || actual.dev !== stat.dev || actual.ino !== stat.ino
      || this.canonicalRoot !== undefined && this.canonicalRoot !== canonical
    ) {
      throw new Error('MEMORY_UNSAFE_ROOT')
    }
    this.canonicalRoot = canonical
  }
  file(name: string): string {
    if (!/^(?:state|index|lock|[a-f0-9-]{36}(?:-[1-9][0-9]*)?)\.json$/u.test(name)) {
      throw new Error('MEMORY_UNSAFE_PATH')
    }
    return path.join(this.canonicalRoot ?? this.root, name)
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
      const directory = await open(this.canonicalRoot ?? this.root, constants.O_RDONLY | constants.O_NOFOLLOW)
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
