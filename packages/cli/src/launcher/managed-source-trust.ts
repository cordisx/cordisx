import { lstatSync, readFileSync } from 'node:fs'
import { createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto'
import { lstat, mkdir, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { managedSourceBinding } from '@cordisx/protocol/managed-source/v1'
import { MANAGED_SOURCE_KEYCHAIN_SERVICE, type ManagedSourceTrust } from './managed-source-authority.js'
import { createMacOSKeychainBackend, type LauncherKeychainBackend } from './secret-store.js'

function location(homeDir: string, profileId: string) {
  if (!/^[A-Za-z0-9._-]{1,120}$/u.test(profileId) || profileId === '.' || profileId === '..') {
    throw new Error('invalid profile')
  }
  return path.join(homeDir, 'state', 'profiles', profileId, 'managed-source-trust.json')
}
export async function loadManagedSourceTrust(
  homeDir: string,
  profileId: string,
): Promise<readonly ManagedSourceTrust[]> {
  const file = location(homeDir, profileId)
  try {
    const stat = await lstat(file)
    if (
      !stat.isFile() || stat.size > 262_144 || (stat.mode & 0o022) !== 0
      || (process.getuid && stat.uid !== process.getuid())
    ) throw new Error('unsafe managed source registry')
    const entries: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(entries) || entries.length > 64) throw new Error('invalid managed source registry')
    return parseEntries(entries)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}
function parseEntries(entries: unknown): readonly ManagedSourceTrust[] {
  if (!Array.isArray(entries) || entries.length > 64) throw new Error('invalid managed source registry')
  return entries.map(entry => {
    if (
      !entry
      || Object.keys(entry).some(key => !['binding', 'owner', 'serverPublicKey', 'signingKeyRef'].includes(key))
    ) {
      throw new Error('invalid managed source trust')
    }
    const binding = managedSourceBinding(entry.binding)
    if (
      !entry.owner || Object.keys(entry.owner).some(key => !['pluginId', 'source'].includes(key))
      || typeof entry.owner.pluginId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/u.test(entry.owner.pluginId)
      || typeof entry.owner.source !== 'string' || entry.owner.source.length > 4096
      || !['file:', 'https:'].includes(new URL(entry.owner.source).protocol)
      || typeof entry.signingKeyRef !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(entry.signingKeyRef)
      || typeof entry.serverPublicKey !== 'string'
      || createPublicKey(entry.serverPublicKey).asymmetricKeyType !== 'ed25519'
    ) {
      throw new Error('invalid managed source trust principal or key')
    }
    return {
      binding,
      owner: { ...entry.owner },
      signingKeyRef: entry.signingKeyRef,
      serverPublicKey: entry.serverPublicKey,
    }
  })
}
/** Final local dispatch fence: no asynchronous registry read may race a held Native read. */
export function loadManagedSourceTrustNow(homeDir: string, profileId: string): readonly ManagedSourceTrust[] {
  try {
    const file = location(homeDir, profileId), stat = lstatSync(file)
    if (
      !stat.isFile() || stat.size > 262_144 || (stat.mode & 0o022) !== 0
      || (process.getuid && stat.uid !== process.getuid())
    ) throw new Error('unsafe managed source registry')
    return parseEntries(JSON.parse(readFileSync(file, 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function validateOwner(owner: ManagedSourceTrust['owner']) {
  if (
    !owner || Object.keys(owner).some(key => !['pluginId', 'source'].includes(key))
    || typeof owner.pluginId !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/u.test(owner.pluginId)
    || typeof owner.source !== 'string' || owner.source.length > 4096
    || !['file:', 'https:'].includes(new URL(owner.source).protocol)
  ) throw new Error('invalid managed source owner')
}
async function registryMutation<T>(homeDir: string, profileId: string, action: () => Promise<T>): Promise<T> {
  const file = location(homeDir, profileId), lock = file + '.lock'
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  // Cross-process provisioning must not overwrite another explicit owner grant.
  await mkdir(lock, { mode: 0o700 })
  try {
    return await action()
  } finally {
    await rmdir(lock)
  }
}
async function writeRegistry(file: string, entries: readonly ManagedSourceTrust[]) {
  const temporary = file + '.' + randomBytes(32).toString('base64url')
  try {
    await writeFile(temporary, JSON.stringify(entries, null, 2) + '\n', { mode: 0o600, flag: 'wx' })
    await rename(temporary, file)
  } finally {
    await unlink(temporary).catch(() => {})
  }
}
/** Explicit provisioning is a trust grant, not a scan or automatic loopback registration. */
export async function provisionManagedSource(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly binding: ManagedSourceTrust['binding']
  readonly owner: ManagedSourceTrust['owner']
  readonly serverDirectory: string
  readonly keychain?: LauncherKeychainBackend
}) {
  return registryMutation(input.homeDir, input.profileId, async () => {
    const binding = managedSourceBinding(input.binding), file = location(input.homeDir, input.profileId)
    const prior = await loadManagedSourceTrust(input.homeDir, input.profileId)
    if (
      prior.length >= 64 || prior.some(entry =>
        JSON.stringify(entry.binding) === JSON.stringify(binding)
        && entry.owner.pluginId === input.owner.pluginId && entry.owner.source === input.owner.source
      )
    ) {
      throw new Error('managed source already provisioned or registry full')
    }
    validateOwner(input.owner)
    const host = generateKeyPairSync('ed25519'), server = generateKeyPairSync('ed25519')
    const pem = (key: typeof host.publicKey) => key.export({ type: 'spki', format: 'pem' }).toString()
    const ref = randomBytes(32).toString('base64url'), keychain = input.keychain ?? createMacOSKeychainBackend()
    const trust: ManagedSourceTrust = {
      binding,
      owner: input.owner,
      signingKeyRef: ref,
      serverPublicKey: pem(server.publicKey),
    }
    const serverFile = path.join(path.resolve(input.serverDirectory), 'managed-source-server.json')
    await mkdir(path.dirname(serverFile), { recursive: true, mode: 0o700 })
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    await keychain.upsert(
      MANAGED_SOURCE_KEYCHAIN_SERVICE,
      ref,
      host.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
    )
    let createdServerFile = false
    try {
      await writeFile(
        serverFile,
        JSON.stringify({
          binding,
          hostPublicKey: pem(host.publicKey),
          serverPrivateKey: server.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        }) + '\n',
        { mode: 0o600, flag: 'wx' },
      )
      createdServerFile = true
      await writeRegistry(file, [...prior, trust])
    } catch (error) {
      if (createdServerFile) await unlink(serverFile).catch(() => {})
      await keychain.remove(MANAGED_SOURCE_KEYCHAIN_SERVICE, ref).catch(() => {})
      throw error
    }
    return { registry: file, serverTrust: serverFile }
  })
}

export async function revokeManagedSource(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly binding: ManagedSourceTrust['binding']
  readonly owner: ManagedSourceTrust['owner']
  readonly keychain?: LauncherKeychainBackend
}) {
  return registryMutation(input.homeDir, input.profileId, async () => {
    const binding = managedSourceBinding(input.binding), file = location(input.homeDir, input.profileId)
    const prior = await loadManagedSourceTrust(input.homeDir, input.profileId)
    const removed = prior.filter(entry =>
      JSON.stringify(entry.binding) === JSON.stringify(binding)
      && entry.owner.pluginId === input.owner.pluginId && entry.owner.source === input.owner.source
    )
    if (!removed.length) return { registry: file }
    const remaining = prior.filter(entry => !removed.includes(entry))
    await writeRegistry(file, remaining)
    const keychain = input.keychain ?? createMacOSKeychainBackend()
    const retiredRefs = new Set(
      removed.filter(entry => !remaining.some(other => other.signingKeyRef === entry.signingKeyRef)).map(entry =>
        entry.signingKeyRef
      ),
    )
    await Promise.all([...retiredRefs].map(ref => keychain.remove(MANAGED_SOURCE_KEYCHAIN_SERVICE, ref)))
    return { registry: file }
  })
}

/** Explicitly authorize an additional owner using an existing exact-binding server pin and signer. */
export async function registerManagedSourceOwner(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly binding: ManagedSourceTrust['binding']
  readonly existingOwner: ManagedSourceTrust['owner']
  readonly owner: ManagedSourceTrust['owner']
}) {
  validateOwner(input.owner)
  validateOwner(input.existingOwner)
  const binding = managedSourceBinding(input.binding), file = location(input.homeDir, input.profileId)
  return registryMutation(input.homeDir, input.profileId, async () => {
    const prior = await loadManagedSourceTrust(input.homeDir, input.profileId)
    const sameBinding = (entry: ManagedSourceTrust) => JSON.stringify(entry.binding) === JSON.stringify(binding)
    const existing = prior.find(entry =>
      sameBinding(entry)
      && entry.owner.pluginId === input.existingOwner.pluginId && entry.owner.source === input.existingOwner.source
    )
    if (!existing) throw new Error('existing managed source owner is not provisioned')
    if (
      prior.length >= 64 || prior.some(entry =>
        sameBinding(entry)
        && entry.owner.pluginId === input.owner.pluginId && entry.owner.source === input.owner.source
      )
    ) {
      throw new Error('managed source already provisioned or registry full')
    }
    await writeRegistry(file, [...prior, { ...existing, owner: { ...input.owner } }])
    return { registry: file }
  })
}
