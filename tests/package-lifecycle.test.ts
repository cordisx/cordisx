import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { c as createTar } from 'tar'
import { describe, expect, it } from 'vitest'
import {
  JsonPackageStore,
  PackageLifecycleError,
  PackageLifecycleHost,
  createHostPermissionReviewAuthority,
  hashPackageTree,
  resolvePackageGraph,
  affectedClosure,
  type HostPackageManifest,
  type PackageActivationCandidate,
  type PackageGenerationFence,
  type PackageReadinessReceipt,
  type PackageStoreState,
} from '../packages/cli/src/launcher/packages/index.js'

const runtime0 = 'runtime-0'
const fingerprint = 'a'.repeat(64)

const manifestReader = {
  async read(snapshotRoot: string): Promise<HostPackageManifest> {
    return JSON.parse(await readFile(path.join(snapshotRoot, 'cordisx-package.json'), 'utf8')) as HostPackageManifest
  },
}

async function tempRoot(label = 'cordisx-packages-'): Promise<string> {
  return await mkdtemp(path.join(os.tmpdir(), label))
}

async function makePackage(
  root: string,
  pluginId: string,
  version: string,
  dependencies: HostPackageManifest['dependencies'] = [],
): Promise<string> {
  const directory = path.join(root, `${pluginId}-${version}`)
  await mkdir(path.join(directory, 'dist'), { recursive: true })
  const manifest: HostPackageManifest = {
    pluginId,
    version,
    entries: { renderer: './dist/index.js', node: [] },
    dependencies,
    compatibility: { host: '>=0.1.0-beta.0', protocol: '>=1.0.0' },
    permissionFingerprint: fingerprint,
  }
  await writeFile(path.join(directory, 'cordisx-package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(directory, 'dist', 'index.js'), `export const packageVersion = ${JSON.stringify(version)}\n`)
  return directory
}

function allowPermissions(requiredSatisfied = true) {
  return createHostPermissionReviewAuthority(async input => ({
    planId: `plan-${input.transactionId}`,
    fingerprint: input.manifestPermissionFingerprint,
    requiredSatisfied,
    unresolvedRequired: requiredSatisfied ? [] : ['models.read'],
    deniedRequired: [],
  }))
}

async function createHost(requiredSatisfied = true, storeOptions = {}) {
  const root = await tempRoot()
  const store = await JsonPackageStore.open(path.join(root, 'store'), storeOptions)
  const host = new PackageLifecycleHost(store, {
    hostVersion: '0.1.0-beta.0',
    protocolVersion: '1.0.0',
    manifestReader,
    permissionAuthority: allowPermissions(requiredSatisfied),
  })
  return { root, store, host }
}

function stateFence(state: PackageStoreState, profileId = 'default'): PackageGenerationFence {
  const profile = state.profiles[profileId]
  if (profile === undefined) return { runtimeGeneration: runtime0, plugins: {} }
  return {
    runtimeGeneration: profile.runtimeGeneration,
    plugins: Object.fromEntries(Object.entries(profile.plugins).flatMap(([pluginId, plugin]) => {
      if (plugin.active === undefined) return []
      const record = state.packages[plugin.active.packageKey]
      if (record === undefined) throw new Error(`missing package ${plugin.active.packageKey}`)
      return [[pluginId, { pluginGeneration: plugin.active.pluginGeneration, identity: record.identity }]]
    })),
  }
}

function readiness(candidate: PackageActivationCandidate): PackageReadinessReceipt {
  return {
    transactionId: candidate.transactionId,
    storeRevision: candidate.storeRevision,
    candidateFingerprint: candidate.candidateFingerprint,
    runtimeGeneration: candidate.proposedRuntimeGeneration,
    plugins: Object.fromEntries(candidate.affectedPluginIds.map((pluginId) => {
      const plugin = candidate.plugins[pluginId]
      if (plugin?.package === undefined) throw new Error(`candidate package missing for ${pluginId}`)
      return [pluginId, { pluginGeneration: plugin.pluginGeneration, identity: plugin.package.identity }]
    })),
  }
}

async function activate(host: PackageLifecycleHost, transactionId: string, revision: number) {
  const candidate = await host.requestActivation(transactionId, revision)
  const receipt = readiness(candidate)
  const confirmed = await host.confirmReadiness(receipt)
  const committed = await host.commit(receipt, confirmed.revision)
  return { candidate, receipt, committed }
}

describe('immutable package intake', () => {
  it('snapshots a local directory by deterministic content and never follows later source edits', async () => {
    const { ImmutablePackageObjects } = await import('../packages/cli/src/launcher/packages/index.js')
    const root = await tempRoot()
    const source = await makePackage(root, 'demo', '1.0.0')
    const objects = new ImmutablePackageObjects(path.join(root, 'store'))
    const first = await objects.snapshot({ kind: 'local-directory', path: source }, 'tx-first')
    const digest = first.digest
    const objectDirectory = await objects.publish(first)
    await writeFile(path.join(source, 'dist', 'index.js'), 'export const changed = true\n')
    expect(await hashPackageTree(objectDirectory)).toBe(digest)
    const second = await objects.snapshot({ kind: 'local-directory', path: source }, 'tx-second')
    expect(second.digest).not.toBe(digest)
    await objects.discard(second)
  })

  it('supports explicit local packages and downloaded npm-style tarballs', async () => {
    const { ImmutablePackageObjects } = await import('../packages/cli/src/launcher/packages/index.js')
    const root = await tempRoot()
    const source = await makePackage(root, 'archive-demo', '1.0.0')
    const packageRoot = path.join(root, 'archive-root', 'package')
    await mkdir(path.dirname(packageRoot), { recursive: true })
    const { cp } = await import('node:fs/promises')
    await cp(source, packageRoot, { recursive: true })
    const archive = path.join(root, 'archive-demo.tgz')
    await createTar({ cwd: path.dirname(packageRoot), file: archive, gzip: true }, ['package'])
    const objects = new ImmutablePackageObjects(path.join(root, 'store'))
    const fromDirectory = await objects.snapshot({ kind: 'local-package', path: source }, 'tx-directory')
    const fromArchive = await objects.snapshot({ kind: 'downloaded-tarball', path: archive }, 'tx-archive')
    expect(fromArchive.digest).toBe(fromDirectory.digest)
    await objects.discard(fromDirectory)
    await objects.discard(fromArchive)
  })

  it('fails closed on integrity mismatch and links', async () => {
    const { ImmutablePackageObjects } = await import('../packages/cli/src/launcher/packages/index.js')
    const root = await tempRoot()
    const source = await makePackage(root, 'unsafe', '1.0.0')
    const objects = new ImmutablePackageObjects(path.join(root, 'store'))
    await expect(objects.snapshot({
      kind: 'local-directory',
      path: source,
      expectedIntegrity: `sha256:${'0'.repeat(64)}`,
    }, 'tx-integrity')).rejects.toMatchObject({ code: 'integrity-mismatch' })
    await symlink(path.join(source, 'dist', 'index.js'), path.join(source, 'dist', 'linked.js'))
    await expect(objects.snapshot({ kind: 'local-directory', path: source }, 'tx-link'))
      .rejects.toMatchObject({ code: 'package-link-rejected' })
  })

  it.skipIf(process.platform === 'win32')('rejects hard-linked files and symlinks inside archives', async () => {
    const { ImmutablePackageObjects } = await import('../packages/cli/src/launcher/packages/index.js')
    const root = await tempRoot()
    const source = await makePackage(root, 'hardlink', '1.0.0')
    await link(path.join(source, 'dist', 'index.js'), path.join(source, 'dist', 'alias.js'))
    const objects = new ImmutablePackageObjects(path.join(root, 'store'))
    await expect(objects.snapshot({ kind: 'local-directory', path: source }, 'tx-hardlink'))
      .rejects.toMatchObject({ code: 'package-hardlink-rejected' })

    const archiveSource = await makePackage(root, 'archive-link', '1.0.0')
    await symlink('index.js', path.join(archiveSource, 'dist', 'alias.js'))
    const archive = path.join(root, 'archive-link.tgz')
    await createTar({ cwd: path.dirname(archiveSource), file: archive, gzip: true }, [path.basename(archiveSource)])
    await expect(objects.snapshot({ kind: 'downloaded-tarball', path: archive }, 'tx-archive-link'))
      .rejects.toMatchObject({ code: 'invalid-package-archive' })
  })
})

describe('package dependency graph', () => {
  const node = (pluginId: string, dependencies: HostPackageManifest['dependencies'] = []) => ({
    pluginId,
    packageKey: `${pluginId}-key`,
    manifest: {
      pluginId,
      version: '1.0.0',
      entries: { renderer: './index.js' },
      dependencies,
      compatibility: { host: '*' },
      permissionFingerprint: fingerprint,
    },
  })

  it('orders dependencies before consumers and computes reverse affected closure', () => {
    const graph = resolvePackageGraph({
      provider: node('provider'),
      consumer: node('consumer', [{ pluginId: 'provider', range: '^1.0.0' }]),
      leaf: node('leaf', [{ pluginId: 'consumer', range: '^1.0.0' }]),
    })
    expect(graph.activationOrder).toEqual(['provider', 'consumer', 'leaf'])
    expect(graph.drainOrder).toEqual(['leaf', 'consumer', 'provider'])
    expect(affectedClosure(['provider'], graph)).toEqual(['consumer', 'leaf', 'provider'])
  })

  it('rejects dependency conflicts, missing providers, and cycles', () => {
    expect(() => resolvePackageGraph({
      provider: node('provider'),
      consumer: node('consumer', [{ pluginId: 'provider', range: '^2.0.0' }]),
    })).toThrow('selected 1.0.0')
    expect(() => resolvePackageGraph({ consumer: node('consumer', [{ pluginId: 'provider', range: '*' }]) }))
      .toThrow('missing dependency')
    expect(() => resolvePackageGraph({
      left: node('left', [{ pluginId: 'right', range: '*' }]),
      right: node('right', [{ pluginId: 'left', range: '*' }]),
    })).toThrow('dependency cycle')
  })
})

describe('launcher package transactions', () => {
  it('installs through permission review, fenced readiness, and atomic last-good commit', async () => {
    const { root, host } = await createHost()
    const source = await makePackage(root, 'demo', '1.0.0')
    const prepared = await host.prepare({
      operation: 'install',
      profileId: 'default',
      expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} },
      proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: source },
    })
    expect(prepared.transaction.status).toBe('ready')
    expect(prepared.transaction.permission?.requiredSatisfied).toBe(true)
    const { candidate, committed } = await activate(host, prepared.transaction.transactionId, prepared.state.revision)
    expect(candidate.plugins.demo?.package?.identity).toMatchObject({ pluginId: 'demo', version: '1.0.0' })
    expect(candidate.plugins.demo?.package?.rendererEntry).toContain('/objects/sha256/')
    expect(committed.profiles.default?.runtimeGeneration).toBe('runtime-1')
    expect(committed.profiles.default?.plugins.demo?.active?.packageKey).toBe(candidate.plugins.demo?.package === undefined
      ? undefined
      : `${candidate.plugins.demo.package.identity.pluginId}@${candidate.plugins.demo.package.identity.version}#${candidate.plugins.demo.package.identity.integrity}`)
  })

  it('persists permission denial without exposing an activation candidate', async () => {
    const { root, host } = await createHost(false)
    const source = await makePackage(root, 'denied', '1.0.0')
    const prepared = await host.prepare({
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-package', path: source },
    })
    expect(prepared.activationAvailable).toBe(false)
    expect(prepared.transaction.permission?.unresolvedRequired).toEqual(['models.read'])
    await expect(host.requestActivation(prepared.transaction.transactionId, prepared.state.revision))
      .rejects.toMatchObject({ code: 'transaction-not-ready' })
  })

  it('rejects stale store CAS and any readiness receipt with a mismatched package identity', async () => {
    const { root, host } = await createHost()
    const source = await makePackage(root, 'fenced', '1.0.0')
    const prepared = await host.prepare({
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: source },
    })
    await expect(host.abort(prepared.transaction.transactionId, 0, 'stale'))
      .rejects.toMatchObject({ actualRevision: prepared.state.revision })
    const candidate = await host.requestActivation(prepared.transaction.transactionId, prepared.state.revision)
    const receipt = readiness(candidate)
    const identity = receipt.plugins.fenced!.identity
    await expect(host.confirmReadiness({
      ...receipt,
      plugins: { fenced: { ...receipt.plugins.fenced!, identity: { ...identity, integrity: `sha256:${'0'.repeat(64)}` } } },
    })).rejects.toMatchObject({ code: 'stale-readiness-receipt' })
  })

  it('recovers an exact activated candidate and aborts an unactivated interrupted candidate', async () => {
    const { root, store, host } = await createHost()
    const source = await makePackage(root, 'recoverable', '1.0.0')
    const prepared = await host.prepare({
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: source },
    })
    const candidate = await host.requestActivation(prepared.transaction.transactionId, prepared.state.revision)
    const receipt = readiness(candidate)
    const reopened = await JsonPackageStore.open(store.root)
    const recoveredHost = new PackageLifecycleHost(reopened, {
      hostVersion: '0.1.0-beta.0', protocolVersion: '1.0.0', manifestReader,
      permissionAuthority: allowPermissions(),
    })
    const recovered = await recoveredHost.recover(candidate.storeRevision, {
      default: { runtimeGeneration: receipt.runtimeGeneration, plugins: receipt.plugins },
    })
    expect(recovered.transactions[prepared.transaction.transactionId]?.status).toBe('committed')

    const secondSource = await makePackage(root, 'interrupted', '1.0.0')
    const second = await recoveredHost.prepare({
      operation: 'install', profileId: 'default', expectedRevision: recovered.revision,
      expected: stateFence(recovered), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: secondSource },
    })
    const aborted = await recoveredHost.recover(second.state.revision, {})
    expect(aborted.transactions[second.transaction.transactionId]?.status).toBe('recovered-aborted')
    expect(aborted.profiles.default?.runtimeGeneration).toBe('runtime-1')
  })

  it('refuses uninstall while an enabled dependent exists', async () => {
    const { root, host } = await createHost()
    const provider = await makePackage(root, 'provider', '1.0.0')
    const first = await host.prepare({
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: provider },
    })
    const providerState = (await activate(host, first.transaction.transactionId, first.state.revision)).committed
    const consumer = await makePackage(root, 'consumer', '1.0.0', [{ pluginId: 'provider', range: '^1.0.0' }])
    const second = await host.prepare({
      operation: 'install', profileId: 'default', expectedRevision: providerState.revision,
      expected: stateFence(providerState), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: consumer },
    })
    const consumerState = (await activate(host, second.transaction.transactionId, second.state.revision)).committed
    await expect(host.prepare({
      operation: 'uninstall', pluginId: 'provider', profileId: 'default', expectedRevision: consumerState.revision,
      expected: stateFence(consumerState), proposedRuntimeGeneration: 'runtime-3',
    })).rejects.toMatchObject({ code: 'package-in-use' })
  })

  it('holds last-good and rollback leases across upgrade before deferred GC', async () => {
    const { root, host } = await createHost()
    const v1 = await makePackage(root, 'upgradeable', '1.0.0')
    const first = await host.prepare({
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: v1 },
    })
    const v1State = (await activate(host, first.transaction.transactionId, first.state.revision)).committed
    const oldLease = v1State.profiles.default!.plugins.upgradeable!.active!
    const v2 = await makePackage(root, 'upgradeable', '2.0.0')
    const upgrade = await host.prepare({
      operation: 'upgrade', pluginId: 'upgradeable', profileId: 'default', expectedRevision: v1State.revision,
      expected: stateFence(v1State), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: v2 },
    })
    const upgraded = (await activate(host, upgrade.transaction.transactionId, upgrade.state.revision)).committed
    expect(host.leases('default')[0]).toMatchObject({ lastGood: oldLease, rollbackLeases: [oldLease] })
    const retained = await host.collectGarbage(upgraded.revision, 0)
    expect(retained.removed).not.toContain(oldLease.packageKey)
    const withoutLastGood = await host.releaseLastGood('default', 'upgradeable', retained.state.revision, oldLease)
    const withoutRollback = await host.releaseRollbackLease('default', 'upgradeable', withoutLastGood.revision, oldLease)
    const collected = await host.collectGarbage(withoutRollback.revision, 0)
    expect(collected.removed).toContain(oldLease.packageKey)
  })

  it('keeps the previous durable state when atomic publication is interrupted before rename', async () => {
    const root = await tempRoot()
    const storeRoot = path.join(root, 'store')
    const initial = await JsonPackageStore.open(storeRoot)
    await initial.transaction(0, draft => {
      draft.profiles.default = { runtimeGeneration: runtime0, plugins: {} }
    })
    const interrupted = await JsonPackageStore.open(storeRoot, {
      fault: (point) => {
        if (point === 'before-rename') throw new Error('injected process interruption')
      },
    })
    await expect(interrupted.transaction(1, draft => {
      draft.profiles.default = { runtimeGeneration: 'runtime-bad', plugins: {} }
    })).rejects.toThrow('injected process interruption')
    const recovered = await JsonPackageStore.open(storeRoot)
    expect(recovered.snapshot()).toMatchObject({ revision: 1, profiles: { default: { runtimeGeneration: runtime0 } } })
  })
})
