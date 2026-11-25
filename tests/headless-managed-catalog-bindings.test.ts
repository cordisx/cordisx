import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { HeadlessManagedCatalogBindings } from '../packages/cli/src/launcher/headless-managed-catalog-bindings.js'

describe('headless managed catalog evidence', () => {
  it('persists exact provider and revision independently for concurrent threads', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-catalog-bindings-'))
    const file = path.join(root, 'profile', 'bindings.json')
    const bindings = new HeadlessManagedCatalogBindings(file)
    try {
      expect(await bindings.read('unknown')).toBeUndefined()
      await Promise.all([
        bindings.record('first', { providerId: 'one', revision: 'rev-1' }),
        bindings.record('second', { providerId: 'two', revision: 'rev-2' }),
      ])
      expect(await bindings.read('first')).toEqual({ providerId: 'one', revision: 'rev-1' })
      expect(await bindings.read('second')).toEqual({ providerId: 'two', revision: 'rev-2' })
      await bindings.record('first', { providerId: 'one', revision: 'rev-1' })
      await expect(bindings.record('first', { providerId: 'two', revision: 'rev-2' }))
        .rejects.toThrow('MANAGED_CATALOG_BINDING_CONFLICT')
      await bindings.close()
      const reopened = new HeadlessManagedCatalogBindings(file)
      expect(await reopened.read('first')).toEqual({ providerId: 'one', revision: 'rev-1' })
      await reopened.close()
      if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600)
    } finally {
      await bindings.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('refuses corrupt or symlink state rather than guessing an old thread catalog', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-catalog-bindings-invalid-'))
    const file = path.join(root, 'bindings.json'), target = path.join(root, 'target.json')
    const bindings = new HeadlessManagedCatalogBindings(file)
    const original = JSON.stringify({ version: 1, entries: {} })
    try {
      await writeFile(file, '{bad json', { mode: 0o600 })
      await expect(bindings.read('first')).rejects.toThrow('MANAGED_CATALOG_BINDINGS_INVALID')
      await expect(bindings.record('first', { providerId: 'one', revision: 'rev' })).rejects.toThrow(
        'MANAGED_CATALOG_BINDINGS_INVALID',
      )
      await rm(file)
      await writeFile(target, original, { mode: 0o600 })
      await symlink(target, file)
      expect((await lstat(file)).isSymbolicLink()).toBe(true)
      await expect(bindings.read('first')).rejects.toThrow('MANAGED_CATALOG_BINDINGS_INVALID')
      expect(await readFile(target, 'utf8')).toBe(original)
    } finally {
      await bindings.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
