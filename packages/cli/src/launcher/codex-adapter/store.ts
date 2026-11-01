import { createHash } from 'node:crypto'
import { readdir, readFile, rename, rm, statfs, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { t as listTar } from 'tar'
import { hashPackageTree, PluginPackageSourceSnapshotter } from '../packages/integrity.js'
import {
  ADAPTER_PACKAGE,
  ADAPTER_REGISTRY,
  type AdapterRelease,
  exactAdapterVersion,
  registryFetch,
  resolveAdapterRelease,
  verifyAdapterArchive,
} from './registry.js'
import { missing, ownedDirectory, processAlive, readPrivateJson, withStoreLock, writePrivateJson } from './files.js'

export interface AdapterReceipt extends AdapterRelease {
  readonly schema: 1
  readonly id: string
  readonly treeHash: string
  readonly entryHash: string
  readonly installedAt: string
  readonly bytes: number
  readonly trust: 'npm-sigstore-v1'
}
export interface AdapterStoreState {
  schema: 1
  preferred: string[]
  rollback: string[]
  pinned: string[]
  revoked: string[]
  lastUsed: Record<string, number>
  highWatermark?: string
}
export interface AdapterLease {
  readonly pid: number
  readonly packages: readonly string[]
  readonly modules: readonly { id: string; identity: string; version: string }[]
  readonly documents: Readonly<Record<string, 'active' | 'unavailable'>>
}
const fresh = (): AdapterStoreState => ({
  schema: 1,
  preferred: [],
  rollback: [],
  pinned: [],
  revoked: [],
  lastUsed: {},
})
export const adapterStoreRoot = (home: string): string => path.join(home, 'codex-adapters')
const validId = (id: string) => /^[a-f0-9]{64}$/u.test(id)

export async function readAdapterState(root: string): Promise<AdapterStoreState> {
  try {
    const state = await readPrivateJson<AdapterStoreState>(path.join(root, 'state.json'))
    if (
      state.schema !== 1 || ![state.preferred, state.rollback, state.pinned, state.revoked].every(a =>
        Array.isArray(a) && a.every(validId)
      )
      || !state.lastUsed || typeof state.lastUsed !== 'object'
    ) {
      throw new Error('Invalid adapter store state')
    }
    return state
  } catch (error) {
    if (missing(error)) return fresh()
    throw error
  }
}
export async function adapterReceipts(root: string): Promise<AdapterReceipt[]> {
  let names: string[]
  try {
    names = await readdir(path.join(root, 'packages'))
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const result: AdapterReceipt[] = []
  for (const id of names.filter(validId)) {
    try {
      const receipt = await readPrivateJson<AdapterReceipt>(path.join(root, 'packages', id, 'receipt.json'))
      if (
        receipt.schema !== 1 || receipt.id !== id || !exactAdapterVersion(receipt.version)
        || receipt.trust !== 'npm-sigstore-v1' || !validId(receipt.treeHash) || !validId(receipt.entryHash)
      ) throw new Error('Invalid adapter receipt')
      result.push(receipt)
    } catch { /* Damaged packages are never candidates. */ }
  }
  return result
}
export async function verifyInstalledAdapter(root: string, receipt: AdapterReceipt): Promise<string> {
  if (!validId(receipt.id)) throw new Error('Invalid adapter package identity')
  await ownedDirectory(root)
  await ownedDirectory(path.join(root, 'packages'))
  const directory = path.join(root, 'packages', receipt.id)
  await ownedDirectory(directory)
  const payload = path.join(directory, 'payload')
  await ownedDirectory(payload)
  if (await hashPackageTree(payload) !== receipt.treeHash) throw new Error('Cached adapter package content changed')
  const entry = path.join(payload, 'dist', 'adapter.mjs')
  if (createHash('sha256').update(await readFile(entry)).digest('hex') !== receipt.entryHash) {
    throw new Error('Cached adapter entry changed')
  }
  return entry
}

/** Explicit intake only; normal App startup never waits for the network. */
export async function installAdapterPackage(
  root: string,
  selector: string,
  progress: (state: string) => void = () => {},
): Promise<AdapterReceipt> {
  return withStoreLock(root, async () => {
    const state = await readAdapterState(root)
    const release = await resolveAdapterRelease(selector, {
      ...(state.highWatermark ? { highWatermark: state.highWatermark } : {}),
    })
    const archive = await registryFetch(release.tarball, 32 * 1024 * 1024)
    const id = verifyAdapterArchive(archive, release.integrity)
    if (state.revoked.includes(id)) throw new Error('Adapter release is locally revoked')
    const existing = (await adapterReceipts(root)).find(r => r.version === release.version)
    if (existing && existing.id !== id) throw new Error('Immutable adapter version changed in registry')
    if (existing) {
      await verifyInstalledAdapter(root, existing)
      return existing
    }
    progress('downloaded')
    const transaction = path.join(root, 'downloads')
    await ownedDirectory(transaction)
    const archivePath = path.join(transaction, `${id}.tgz`)
    let snapshot: Awaited<ReturnType<PluginPackageSourceSnapshotter['snapshot']>> | undefined
    try {
      // The exclusive store lock proves no live intake owns a previous interrupted download.
      await rm(archivePath, { force: true })
      await writeFile(archivePath, archive, { mode: 0o600, flag: 'wx' })
      let expandedBytes = 0
      await listTar({
        file: archivePath,
        strict: true,
        onReadEntry: entry => {
          expandedBytes += entry.size
          if (expandedBytes > 128 * 1024 * 1024) throw new Error('Adapter expansion exceeds size budget')
        },
      })
      snapshot = await new PluginPackageSourceSnapshotter(transaction).snapshot({
        kind: 'downloaded-tarball',
        path: archivePath,
        downloadedFrom: release.tarball,
        distributionIntegrity: `sha256:${id}`,
      })
      const manifest = JSON.parse(await readFile(path.join(snapshot.payloadDirectory, 'package.json'), 'utf8'))
      if (
        manifest.name !== ADAPTER_PACKAGE || manifest.version !== release.version
        || manifest.scripts
          && Object.keys(manifest.scripts).some(key => /^(?:preinstall|install|postinstall|prepare)$/u.test(key))
        || ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies', 'bundleDependencies']
          .some(key => Object.keys(manifest[key] ?? {}).length > 0)
        || manifest.bin
      ) throw new Error('Adapter package identity, dependency or install-script policy failed')
      const entryHash = createHash('sha256').update(
        await readFile(path.join(snapshot.payloadDirectory, 'dist', 'adapter.mjs')),
      ).digest('hex')
      const receipt: AdapterReceipt = {
        ...release,
        schema: 1,
        id,
        treeHash: snapshot.digest,
        entryHash,
        installedAt: new Date().toISOString(),
        bytes: expandedBytes,
        trust: 'npm-sigstore-v1',
      }
      await writePrivateJson(path.join(snapshot.stagingDirectory, 'receipt.json'), receipt)
      const packages = path.join(root, 'packages')
      await ownedDirectory(packages)
      await rename(snapshot.stagingDirectory, path.join(packages, id))
      if (!state.highWatermark || Date.parse(release.publishedAt) > Date.parse(state.highWatermark)) {
        state.highWatermark = release.publishedAt
      }
      await writePrivateJson(path.join(root, 'state.json'), state)
      progress('installed')
      return receipt
    } finally {
      await rm(archivePath, { force: true })
      if (snapshot) await rm(snapshot.stagingDirectory, { recursive: true, force: true })
    }
  })
}

export async function changeAdapterPolicy(
  root: string,
  operation: 'use' | 'pin' | 'unpin' | 'revoke',
  ids: readonly string[],
): Promise<void> {
  await withStoreLock(root, async () => {
    const state = await readAdapterState(root)
    const receipts = await adapterReceipts(root)
    if (ids.some(id => !validId(id) || !receipts.some(r => r.id === id))) {
      throw new Error('Select an installed exact package identity')
    }
    if (operation === 'use') {
      if (ids.some(id => state.revoked.includes(id))) throw new Error('Cannot select a revoked adapter')
      state.rollback = state.preferred
      state.preferred = [...new Set(ids)]
    } else if (operation === 'pin') state.pinned = [...new Set([...state.pinned, ...ids])]
    else if (operation === 'unpin') state.pinned = state.pinned.filter(id => !ids.includes(id))
    else {
      state.revoked = [...new Set([...state.revoked, ...ids])]
      state.preferred = state.preferred.filter(id => !ids.includes(id))
    }
    await writePrivateJson(path.join(root, 'state.json'), state)
  })
}
export async function liveAdapterLeases(root: string): Promise<AdapterLease[]> {
  const directory = path.join(root, 'leases')
  let files: string[]
  try {
    files = await readdir(directory)
  } catch (error) {
    if (missing(error)) return []
    throw error
  }
  const result: AdapterLease[] = []
  for (const file of files.filter(f => /^[a-f0-9-]+\.json$/u.test(f))) {
    const value = await readPrivateJson<AdapterLease>(path.join(directory, file))
    if (processAlive(value.pid)) result.push(value)
    else await rm(path.join(directory, file), { force: true })
  }
  return result
}
async function clearAbandonedAdapterIntake(root: string): Promise<void> {
  const downloads = path.join(root, 'downloads')
  let entries
  try {
    entries = await readdir(downloads, { withFileTypes: true })
  } catch (error) {
    if (missing(error)) return
    throw error
  }
  await ownedDirectory(downloads)
  for (const entry of entries) {
    if (/^[a-f0-9]{64}\.tgz$/u.test(entry.name)) await rm(path.join(downloads, entry.name), { force: true })
    if (entry.name !== 'staging') continue
    const staging = path.join(downloads, 'staging')
    await ownedDirectory(staging)
    for (const name of await readdir(staging)) {
      if (/^[a-f0-9-]{36}\.[a-f0-9-]{36}$/u.test(name)) {
        await rm(path.join(staging, name), { recursive: true, force: true })
      }
    }
  }
}

/** Disk/recency policy, never a version count. Leases, selected, rollback and pins survive. */
export async function pruneAdapterCache(
  root: string,
  maxBytes = 256 * 1024 * 1024,
  minFreeBytes = 512 * 1024 * 1024,
): Promise<string[]> {
  return withStoreLock(root, async () => {
    const state = await readAdapterState(root)
    const leases = await liveAdapterLeases(root)
    // Only the intake's named temporary artifacts are swept; unknown files are preserved.
    await clearAbandonedAdapterIntake(root)
    const protectedIds = new Set([
      ...state.preferred,
      ...state.rollback,
      ...state.pinned,
      ...leases.flatMap(l => l.packages),
    ])
    await ownedDirectory(path.join(root, 'packages'))
    const receipts = await adapterReceipts(root)
    let total = receipts.reduce((sum, r) => sum + r.bytes, 0)
    const disk = await statfs(root)
    let free = disk.bavail * disk.bsize
    const removed: string[] = []
    for (
      const receipt of receipts.filter(r => !protectedIds.has(r.id)).sort((a, b) =>
        (state.lastUsed[a.id] ?? Date.parse(a.installedAt)) - (state.lastUsed[b.id] ?? Date.parse(b.installedAt))
      )
    ) {
      if (total <= maxBytes && free >= minFreeBytes) break
      await rm(path.join(root, 'packages', receipt.id), { recursive: true, force: true })
      total -= receipt.bytes
      free += receipt.bytes
      removed.push(receipt.id)
      delete state.lastUsed[receipt.id]
    }
    await writePrivateJson(path.join(root, 'state.json'), state)
    return removed
  })
}
