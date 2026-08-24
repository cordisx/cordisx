import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { c as createTar } from 'tar'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
} from '../packages/cli/src/platform-contracts.js'
import {
  JsonPackageStore,
  PackageLifecycleError,
  PackageLifecycleHost,
  createHostPermissionReviewAuthority,
  hashPackageTree,
  resolvePackageGraph,
  affectedClosure,
  type HostPackageManifest,
  type PackageActivationPlan,
  type PackageCandidateAccess,
  type PackageGenerationFence,
  type PackageReadinessReceipt,
  type PackageStoreState,
} from '../packages/cli/src/launcher/packages/index.js'

const runtime0 = 'runtime-0'
const fingerprint = 'a'.repeat(64)

const manifestResolver = {
  async resolve(snapshotRoot: string) {
    const packageManifest = JSON.parse(await readFile(path.join(snapshotRoot, 'cordisx-package.json'), 'utf8')) as HostPackageManifest
    const runtimeManifest = JSON.parse(await readFile(path.join(snapshotRoot, 'cordisx.plugin.json'), 'utf8'))
    return { packageManifest, runtime: { entry: './dist/index.js', manifest: runtimeManifest } }
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
    dependencies,
    compatibility: { runtimeAbi: 1, protocol: 1 },
    permissionFingerprint: fingerprint,
  }
  await writeFile(path.join(directory, 'cordisx-package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(path.join(directory, 'cordisx.plugin.json'), `${JSON.stringify({
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id: pluginId,
    capabilities: [],
  }, null, 2)}\n`)
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
    runtimeAbi: 1,
    protocolVersion: 1,
    manifestResolver,
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
      return [[pluginId, { moduleGeneration: plugin.active.moduleGeneration, identity: record.identity }]]
    })),
  }
}

function readiness(candidate: PackageActivationPlan): PackageReadinessReceipt {
  return {
    transactionId: candidate.transactionId,
    candidateId: candidate.candidateId,
    candidateFingerprint: candidate.candidateFingerprint,
    runtimeGeneration: candidate.after.runtimeGeneration,
    plugins: Object.fromEntries(candidate.affectedPluginIds.map((pluginId) => {
      const plugin = candidate.after.plugins[pluginId]
      if (plugin?.package === undefined) throw new Error(`candidate package missing for ${pluginId}`)
      return [pluginId, { moduleGeneration: plugin.moduleGeneration, identity: plugin.package.identity }]
    })),
  }
}

function candidateAccess(candidateId: PackageCandidateAccess['candidateId'], profileId = 'default'): PackageCandidateAccess {
  return { candidateId, ownerId: 'generation-runtime', profileId }
}

async function activate(host: PackageLifecycleHost, prepared: { readonly candidateId: PackageCandidateAccess['candidateId'] }) {
  const access = candidateAccess(prepared.candidateId)
  const candidate = await host.requestActivation(access)
  const receipt = readiness(candidate)
  await host.confirmReadiness(access, receipt)
  const committed = await host.commit(access, receipt)
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
      dependencies,
      compatibility: { runtimeAbi: 1, protocol: 1 },
      permissionFingerprint: fingerprint,
    },
  })

  it('orders dependencies before consumers and computes reverse affected closure', () => {
    const graph = resolvePackageGraph({
      provider: node('provider'),
      consumer: node('consumer', [{ id: 'provider', version: '1.0.0' }]),
      leaf: node('leaf', [{ id: 'consumer', version: '1.0.0' }]),
    })
    expect(graph.activationOrder).toEqual(['provider', 'consumer', 'leaf'])
    expect(graph.drainOrder).toEqual(['leaf', 'consumer', 'provider'])
    expect(affectedClosure(['provider'], graph)).toEqual(['consumer', 'leaf', 'provider'])
  })

  it('rejects dependency conflicts, missing providers, and cycles', () => {
    expect(() => resolvePackageGraph({
      provider: node('provider'),
      consumer: node('consumer', [{ id: 'provider', version: '2.0.0' }]),
    })).toThrow('selected 1.0.0')
    expect(() => resolvePackageGraph({ consumer: node('consumer', [{ id: 'provider', version: '1.0.0' }]) }))
      .toThrow('missing dependency')
    expect(() => resolvePackageGraph({
      left: node('left', [{ id: 'right', version: '1.0.0' }]),
      right: node('right', [{ id: 'left', version: '1.0.0' }]),
    })).toThrow('dependency cycle')
  })
})

describe('launcher package transactions', () => {
  it('installs through permission review, fenced readiness, and atomic last-good commit', async () => {
    const { root, host } = await createHost()
    const source = await makePackage(root, 'demo', '1.0.0')
    const prepared = await host.prepare({
      ownerId: 'generation-runtime',
      operation: 'install',
      profileId: 'default',
      expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} },
      proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: source },
    })
    expect(prepared.transaction.status).toBe('ready')
    expect(prepared.transaction.permission?.requiredSatisfied).toBe(true)
    const plan = await host.resolveCandidate(candidateAccess(prepared.candidateId), 'plan')
    const impact = await host.resolveImpact({
      impactToken: prepared.impactToken,
      ownerId: 'generation-runtime',
      profileId: 'default',
    }, 'plan')
    expect(plan.profileActivationRevision).toBe(0)
    expect(plan.current).toEqual(plan.expected)
    expect(plan.after.revision).toBe(1)
    expect(impact.affectedPluginIds).toEqual(['demo'])
    const { candidate, committed } = await activate(host, prepared)
    expect(candidate.after.plugins.demo?.package?.identity).toMatchObject({ pluginId: 'demo', version: '1.0.0' })
    expect(candidate.after.plugins.demo?.package?.runtimeEntry).toContain('/objects/sha256/')
    expect(committed.profiles.default?.runtimeGeneration).toBe('runtime-1')
    expect(committed.profiles.default?.revision).toBe(1)
    expect(committed.profiles.default?.plugins.demo?.active?.packageKey).toBe(candidate.after.plugins.demo?.package === undefined
      ? undefined
      : `${candidate.after.plugins.demo.package.identity.pluginId}@${candidate.after.plugins.demo.package.identity.version}#${candidate.after.plugins.demo.package.identity.integrity}`)
  })

  it('persists permission denial without exposing an activation candidate', async () => {
    const { root, host } = await createHost(false)
    const source = await makePackage(root, 'denied', '1.0.0')
    const prepared = await host.prepare({
      ownerId: 'generation-runtime',
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-package', path: source },
    })
    expect(prepared.activationAvailable).toBe(false)
    expect(prepared.transaction.permission?.unresolvedRequired).toEqual(['models.read'])
    await expect(host.requestActivation(candidateAccess(prepared.candidateId)))
      .rejects.toMatchObject({ code: 'permission-review-required' })
  })

  it('rejects forged tokens, wrong owners, and readiness with a mismatched package identity', async () => {
    const { root, host } = await createHost()
    const source = await makePackage(root, 'fenced', '1.0.0')
    const prepared = await host.prepare({
      ownerId: 'generation-runtime',
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: source },
    })
    await expect(host.resolveCandidate({
      ...candidateAccess(prepared.candidateId),
      ownerId: 'renderer',
    }, 'plan')).rejects.toMatchObject({ code: 'candidate-owner-mismatch' })
    await expect(host.resolveCandidate({
      ...candidateAccess(prepared.candidateId),
      candidateId: 'candidate:forged' as typeof prepared.candidateId,
    }, 'plan')).rejects.toMatchObject({ code: 'candidate-token-invalid' })
    const access = candidateAccess(prepared.candidateId)
    const candidate = await host.requestActivation(access)
    const receipt = readiness(candidate)
    const identity = receipt.plugins.fenced!.identity
    await expect(host.confirmReadiness(access, {
      ...receipt,
      plugins: { fenced: { ...receipt.plugins.fenced!, identity: { ...identity, integrity: `sha256:${'0'.repeat(64)}` } } },
    })).rejects.toMatchObject({ code: 'stale-readiness-receipt' })
  })

  it('recovers an exact activated candidate and aborts an unactivated interrupted candidate', async () => {
    const { root, store, host } = await createHost()
    const source = await makePackage(root, 'recoverable', '1.0.0')
    const prepared = await host.prepare({
      ownerId: 'generation-runtime',
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: source },
    })
    const candidate = await host.requestActivation(candidateAccess(prepared.candidateId))
    const receipt = readiness(candidate)
    const reopened = await JsonPackageStore.open(store.root)
    const recoveredHost = new PackageLifecycleHost(reopened, {
      runtimeAbi: 1, protocolVersion: 1, manifestResolver,
      permissionAuthority: allowPermissions(),
    })
    const recovered = await recoveredHost.recover({
      default: { runtimeGeneration: receipt.runtimeGeneration, plugins: receipt.plugins },
    })
    expect(recovered.transactions[prepared.transaction.transactionId]?.status).toBe('committed')

    const secondSource = await makePackage(root, 'interrupted', '1.0.0')
    const second = await recoveredHost.prepare({
      ownerId: 'generation-runtime', operation: 'install', profileId: 'default',
      expectedRevision: recovered.profiles.default!.revision,
      expected: stateFence(recovered), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: secondSource },
    })
    const aborted = await recoveredHost.recover({})
    expect(aborted.transactions[second.transaction.transactionId]?.status).toBe('recovered-aborted')
    expect(aborted.profiles.default?.runtimeGeneration).toBe('runtime-1')
  })

  it('refuses uninstall while an enabled dependent exists', async () => {
    const { root, host } = await createHost()
    const provider = await makePackage(root, 'provider', '1.0.0')
    const first = await host.prepare({
      ownerId: 'generation-runtime',
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: provider },
    })
    const providerState = (await activate(host, first)).committed
    const consumer = await makePackage(root, 'consumer', '1.0.0', [{ id: 'provider', version: '1.0.0' }])
    const second = await host.prepare({
      ownerId: 'generation-runtime', operation: 'install', profileId: 'default',
      expectedRevision: providerState.profiles.default!.revision,
      expected: stateFence(providerState), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: consumer },
    })
    const consumerState = (await activate(host, second)).committed
    await expect(host.prepare({
      ownerId: 'generation-runtime', operation: 'uninstall', pluginId: 'provider', profileId: 'default',
      expectedRevision: consumerState.profiles.default!.revision,
      expected: stateFence(consumerState), proposedRuntimeGeneration: 'runtime-3',
    })).rejects.toMatchObject({ code: 'package-in-use' })
  })

  it('holds last-good and rollback leases across upgrade before deferred GC', async () => {
    const { root, host } = await createHost()
    const v1 = await makePackage(root, 'upgradeable', '1.0.0')
    const first = await host.prepare({
      ownerId: 'generation-runtime',
      operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: v1 },
    })
    const v1State = (await activate(host, first)).committed
    const oldLease = v1State.profiles.default!.plugins.upgradeable!.active!
    const v2 = await makePackage(root, 'upgradeable', '2.0.0')
    const upgrade = await host.prepare({
      ownerId: 'generation-runtime', operation: 'update', pluginId: 'upgradeable', profileId: 'default',
      expectedRevision: v1State.profiles.default!.revision,
      expected: stateFence(v1State), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: v2 },
    })
    const upgraded = (await activate(host, upgrade)).committed
    expect(host.leases('default')[0]).toMatchObject({ lastGood: oldLease, rollbackLeases: [oldLease] })
    const retained = await host.collectGarbage(0)
    expect(retained.removed).not.toContain(oldLease.packageKey)
    await host.releaseLastGood('default', 'upgradeable', oldLease)
    await host.releaseRollbackLease('default', 'upgradeable', oldLease)
    const collected = await host.collectGarbage(0)
    expect(collected.removed).toContain(oldLease.packageKey)
  })

  it('keeps the previous durable state when atomic publication is interrupted before rename', async () => {
    const root = await tempRoot()
    const storeRoot = path.join(root, 'store')
    const initial = await JsonPackageStore.open(storeRoot)
    await initial.transaction(0, draft => {
      draft.profiles.default = {
        revision: 0, lastGoodRevision: 0, runtimeGeneration: runtime0,
        lastGoodRuntimeGeneration: runtime0, plugins: {},
      }
    })
    const interrupted = await JsonPackageStore.open(storeRoot, {
      fault: (point) => {
        if (point === 'before-rename') throw new Error('injected process interruption')
      },
    })
    await expect(interrupted.transaction(1, draft => {
      draft.profiles.default = {
        revision: 1, lastGoodRevision: 0, runtimeGeneration: 'runtime-bad',
        lastGoodRuntimeGeneration: runtime0, plugins: {},
      }
    })).rejects.toThrow('injected process interruption')
    const recovered = await JsonPackageStore.open(storeRoot)
    expect(recovered.snapshot()).toMatchObject({ revision: 1, profiles: { default: { runtimeGeneration: runtime0 } } })
  })
})
