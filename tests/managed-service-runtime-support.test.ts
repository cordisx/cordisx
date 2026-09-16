import { mkdir, mkdtemp, symlink } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { managedContainedFile } from '../packages/cli/src/launcher/managed-service-runtime-support.js'

describe('managed service runtime support', () => {
  it('allows a missing contained target and rejects lexical traversal', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-service-support-'))
    const serviceHome = path.join(root, 'service-home')
    await mkdir(serviceHome)

    expect(await managedContainedFile(serviceHome, './future/environment.json')).toBe(
      path.join(serviceHome, 'future', 'environment.json'),
    )
    await expect(
      managedContainedFile(serviceHome, './../outside/environment.json'),
    ).rejects.toThrow('escapes its package')
  })

  it.skipIf(process.platform === 'win32')('rejects a symbolic-link component', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-managed-service-support-'))
    const serviceHome = path.join(root, 'service-home')
    const outside = path.join(root, 'outside')
    await mkdir(serviceHome)
    await mkdir(outside)
    await symlink(outside, path.join(serviceHome, 'linked'))

    await expect(
      managedContainedFile(serviceHome, './linked/environment.json'),
    ).rejects.toThrow('uses a symbolic link')
  })
})
