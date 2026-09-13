import { createPrivateKey, sign, verify } from 'node:crypto'
import { lstat, mkdtemp, readFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { expect, it } from 'vitest'
import {
  loadManagedSourceTrust,
  provisionManagedSource,
  registerManagedSourceOwner,
  revokeManagedSource,
} from '../packages/cli/src/launcher/managed-source-trust.js'
import { createMacOSKeychainBackend } from '../packages/cli/src/launcher/secret-store.js'
it('keeps the normal Secret Store multiline rejection before invoking its native helper', async () => {
  await expect(createMacOSKeychainBackend().upsert('cordisx/managed-source/v1', 'fixture-only', 'first\nsecond'))
    .rejects.toMatchObject({ code: 'UNAVAILABLE' })
})
it('explicitly provisions separate private keys, exposes only registry pins, and revokes issuer trust', async t => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'managed-source-trust-test-'))
  t.onTestFinished(() => rm(homeDir, { recursive: true, force: true }))
  const keys = new Map<string, string>(),
    keychain = {
      upsert: async (s: string, k: string, v: string) => {
        // The normal backend rejects multiline values before invoking macOS Security.framework.
        if (!v || v.length > 16 * 1024 || /[\r\n\u0000]/u.test(v)) throw new Error('UNAVAILABLE')
        keys.set(`${s}:${k}`, v)
      },
      read: async (s: string, k: string) => keys.get(`${s}:${k}`)!,
      remove: async (s: string, k: string) => {
        keys.delete(`${s}:${k}`)
      },
      status: async () => 'set' as const,
    }
  const input = {
    homeDir,
    profileId: 'test',
    serverDirectory: path.join(homeDir, 'server'),
    keychain,
    binding: {
      origin: 'http://127.0.0.1:3000',
      sourceId: 'local',
      instanceId: 'fresh',
      audience: 'source-account' as const,
    },
    owner: { pluginId: 'wallet', source: 'file:///wallet.ts' },
  }
  const result = await provisionManagedSource(input)
  expect((await lstat(result.serverTrust)).mode & 0o777).toBe(0o600)
  const server = JSON.parse(await readFile(result.serverTrust, 'utf8')),
    registry = await readFile(result.registry, 'utf8')
  expect(registry).not.toContain('PRIVATE KEY')
  expect(server.hostPublicKey).not.toBe(server.serverPrivateKey)
  expect(await loadManagedSourceTrust(homeDir, 'test')).toHaveLength(1)
  expect(keys.size).toBe(1)
  const encoded = [...keys.values()][0]!, bytes = Buffer.from(encoded, 'base64')
  const signingKey = createPrivateKey({ key: bytes, type: 'pkcs8', format: 'der' })
  expect(signingKey.asymmetricKeyType).toBe('ed25519')
  expect(signingKey.export({ type: 'pkcs8', format: 'der' }).equals(bytes)).toBe(true)
  expect(
    verify(
      null,
      Buffer.from('fixture provisioned signer'),
      server.hostPublicKey,
      sign(null, Buffer.from('fixture provisioned signer'), signingKey),
    ),
  ).toBe(true)
  await expect(provisionManagedSource(input)).rejects.toThrow('already provisioned')
  const gameOwner = { pluginId: 'game', source: 'file:///game.ts' }
  await expect(
    registerManagedSourceOwner({
      ...input,
      existingOwner: input.owner,
      owner: gameOwner,
      binding: { ...input.binding, audience: 'work-income' },
    }),
  ).rejects.toThrow('not provisioned')
  await registerManagedSourceOwner({ ...input, existingOwner: input.owner, owner: gameOwner })
  const registered = await loadManagedSourceTrust(homeDir, 'test')
  expect(registered).toHaveLength(2)
  expect(registered[1]!.signingKeyRef).toBe(registered[0]!.signingKeyRef)
  expect(registered[1]!.serverPublicKey).toBe(registered[0]!.serverPublicKey)
  expect(keys.size).toBe(1)
  await expect(provisionManagedSource({ ...input, binding: { ...input.binding, sourceId: 'other' } }))
    .rejects.toThrow()
  expect(keys.size).toBe(1)
  expect(JSON.parse(await readFile(result.serverTrust, 'utf8'))).toEqual(server)
  await revokeManagedSource(input)
  expect(await loadManagedSourceTrust(homeDir, 'test')).toHaveLength(1)
  expect(keys.size).toBe(1)
  await revokeManagedSource({ ...input, owner: gameOwner })
  expect(await loadManagedSourceTrust(homeDir, 'test')).toHaveLength(0)
  expect(keys.size).toBe(0)
})
it('fails closed on symlink registries before any source key is authorized', async t => {
  const homeDir = await mkdtemp(path.join(tmpdir(), 'managed-source-trust-symlink-'))
  t.onTestFinished(() => rm(homeDir, { recursive: true, force: true }))
  const { mkdir, writeFile } = await import('node:fs/promises')
  const profile = path.join(homeDir, 'state/profiles/test')
  await mkdir(profile, { recursive: true })
  const target = path.join(homeDir, 'target.json')
  await writeFile(target, '[]', { mode: 0o600 })
  await symlink(target, path.join(profile, 'managed-source-trust.json'))
  await expect(loadManagedSourceTrust(homeDir, 'test')).rejects.toThrow('unsafe')
})
