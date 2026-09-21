import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export async function privateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) {
    throw new Error('Unsafe shortcut directory')
  }
  await chmod(directory, 0o700)
}
export async function readPrivateJson(file: string): Promise<unknown> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Unsafe shortcut record')
  }
  return JSON.parse(await readFile(file, 'utf8'))
}
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
export async function entryLock(file: string): Promise<() => Promise<void>> {
  const lock = `${file}.lock`
  await mkdir(lock, { mode: 0o700 }).catch(() => {
    throw new Error('Shortcut update already in progress; retry after it completes')
  })
  return async () => {
    await rm(lock, { recursive: true })
  }
}
export function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}
export function registryFor(home: string): string {
  return path.join(home, 'Library', 'Application Support', 'CordisX', 'shortcuts')
}
