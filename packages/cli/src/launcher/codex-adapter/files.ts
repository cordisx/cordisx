import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'

export async function ownedDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const stat = await lstat(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error(`Unsafe adapter directory: ${directory}`)
  }
}
export async function readPrivateJson<T>(file: string): Promise<T> {
  const stat = await lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0) {
    throw new Error('Unsafe adapter state file')
  }
  return JSON.parse(await readFile(file, 'utf8')) as T
}
export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await ownedDirectory(path.dirname(file))
  const temporary = `${file}.${randomUUID()}.tmp`
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await rm(temporary, { force: true })
  }
}
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === 'ENOENT'
export function processAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
export async function withStoreLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  await ownedDirectory(root)
  const file = path.join(root, 'lock.json')
  const token = randomUUID()
  try {
    await writeFile(file, JSON.stringify({ pid: process.pid, token }), { mode: 0o600, flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const owner = await readPrivateJson<{ pid: number }>(file)
    if (processAlive(owner.pid)) throw new Error('Adapter store is busy; retry after the current operation')
    await rm(file)
    return withStoreLock(root, action)
  }
  try {
    return await action()
  } finally {
    const owner = await readPrivateJson<{ token: string }>(file).catch(() => undefined)
    if (owner?.token === token) await rm(file, { force: true })
  }
}
