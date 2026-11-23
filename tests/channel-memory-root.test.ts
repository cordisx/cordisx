import { chmod, mkdir, mkdtemp, realpath, rm, symlink, unlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { MemoryFiles } from '../packages/cli/src/launcher/channel-memory-files.js'
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'memory-safe-root-')))
  roots.push(root)
  const actual = path.join(root, 'actual'), alias = path.join(root, 'alias')
  await mkdir(actual)
  await symlink(actual, alias, 'dir')
  return { root, actual, alias }
}
it('accepts a private leaf beneath an ancestor symlink and uses its pinned canonical directory', async () => {
  const f = await fixture(), files = new MemoryFiles(path.join(f.alias, 'memory'))
  await files.locked(async () => {
    await files.write('state.json', { value: 'synthetic' })
  })
  expect(await files.read('state.json')).toEqual({ value: 'synthetic' })
  expect(files.file('state.json')).toBe(path.join(f.actual, 'memory', 'state.json'))
  await files.prepare()
})
it('rejects a symlink leaf and world/group-accessible memory directory', async () => {
  const f = await fixture(), leaf = path.join(f.actual, 'private')
  await mkdir(leaf, { mode: 0o700 })
  const linked = path.join(f.actual, 'linked')
  await symlink(leaf, linked, 'dir')
  await expect(new MemoryFiles(linked).prepare()).rejects.toThrow('MEMORY_UNSAFE_ROOT')
  await chmod(leaf, 0o755)
  await expect(new MemoryFiles(leaf).prepare()).rejects.toThrow('MEMORY_UNSAFE_ROOT')
})
it('does not follow a retargeted ancestor after preparing a memory store', async () => {
  const f = await fixture(), files = new MemoryFiles(path.join(f.alias, 'memory'))
  await files.prepare()
  const other = path.join(f.root, 'other')
  await mkdir(path.join(other, 'memory'), { recursive: true, mode: 0o700 })
  await unlink(f.alias)
  await symlink(other, f.alias, 'dir')
  await expect(files.prepare()).rejects.toThrow('MEMORY_UNSAFE_ROOT')
  expect(files.file('state.json')).toBe(path.join(f.actual, 'memory', 'state.json'))
})
