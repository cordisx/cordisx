import { link, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
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
  createHostRollbackCompletionAuthority,
  hashPackageTree,
  resolvePackageGraph,
  affectedClosure,
  JsonPackageManifestV2Resolver,
  resolvePluginPackageSourceV1,
  type HostPackageManifest,
  type PackageActivationPlan,
  type PackageCandidateAccess,
  type PackageGenerationFence,
  type PackageReadinessReceipt,
  type PackageStoreState,
} from '../packages/cli/src/launcher/packages/index.js'

const runtimeManifestV3Schema =
  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-manifest.v3.schema.json'

const runtime0 = 'runtime-0'
const fingerprint = 'a'.repeat(64)

const manifestResolver = {
  async resolve(snapshotRoot: string) {
    const packageManifest = JSON.parse(await readFile(path.join(snapshotRoot, 'cordisx-package.json'), 'utf8')) as HostPackageManifest
    const runtimeBytes = await readFile(path.join(snapshotRoot, 'cordisx.plugin.json'))
    const runtimeManifest = JSON.parse(runtimeBytes.toString('utf8'))
    return {
      packageManifest,
      runtime: {
        entry: './dist/index.js',
        manifestIntegrity: `sha256:${createHash('sha256').update(runtimeBytes).digest('hex')}`,
        manifest: runtimeManifest,
      },
    }
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
    compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1] },
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
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
    planRevision: 1,
    decisionId: `decision-${input.transactionId}`,
    decisionFingerprint: input.manifestPermissionFingerprint,
    requiredSatisfied,
    unresolvedRequired: requiredSatisfied ? [] : ['models.read'],
    deniedRequired: [],
    oneShotGrantIds: [],
  }))
}

function tupleObservation(tuple: PackageActivationPlan['current']) {
  return {
    runtimeGeneration: tuple.runtimeGeneration,
    plugins: Object.fromEntries(Object.entries(tuple.plugins).map(([pluginId, plugin]) => {
      if (plugin.package === undefined) throw new Error(`tuple package missing for ${pluginId}`)
      return [pluginId, { moduleGeneration: plugin.moduleGeneration, identity: plugin.package.identity }]
    })),
  }
}

const rollbackAuthority = createHostRollbackCompletionAuthority(async plan => ({
  active: tupleObservation(plan.rollbackTarget),
  disposedAfter: tupleObservation(plan.expectedPublished),
}))

async function createHost(requiredSatisfied = true, storeOptions = {}) {
  const root = await tempRoot()
  const store = await JsonPackageStore.open(path.join(root, 'store'), storeOptions)
  const host = new PackageLifecycleHost(store, {
    runtimeAbi: 1,
    protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1],
    manifestResolver,
    permissionAuthority: allowPermissions(requiredSatisfied),
    rollbackAuthority,
  })
  return { root, store, host }
}

function stateFence(state: PackageStoreState, profileId = 'default'): PackageGenerationFence {
  const profile = state.profiles[profileId]
  if (profile === undefined) return { runtimeGeneration: runtime0, plugins: {} }
  return {
    runtimeGeneration: profile.runtimeGeneration,
    plugins: Object.fromEntries(Object.entries(profile.plugins).flatMap(([pluginId, plugin]) => {
      if (plugin.installed === undefined || plugin.uninstalled === true) return []
      const record = state.packages[plugin.installed.packageKey]
      if (record === undefined) throw new Error(`missing package ${plugin.installed.packageKey}`)
      return [[pluginId, { moduleGeneration: plugin.installed.moduleGeneration, identity: record.identity }]]
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

function candidateAccess(
  prepared: {
    readonly candidateId: PackageCandidateAccess['candidateId']
    readonly permissionReview?: { readonly permissionReviewToken: NonNullable<PackageCandidateAccess['permissionReviewToken']> }
  },
  profileId = 'default',
): PackageCandidateAccess {
  return {
    candidateId: prepared.candidateId,
    ownerId: 'generation-runtime',
    profileId,
    ...(prepared.permissionReview === undefined ? {} : {
      permissionReviewToken: prepared.permissionReview.permissionReviewToken,
    }),
  }
}

async function activate(host: PackageLifecycleHost, prepared: {
  readonly candidateId: PackageCandidateAccess['candidateId']
  readonly permissionReview?: { readonly permissionReviewToken: NonNullable<PackageCandidateAccess['permissionReviewToken']> }
}) {
  const access = candidateAccess(prepared)
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

describe('formal source and separated manifest adapters', () => {
  it('maps all source-v1 forms without granting remote installation authority', async () => {
    const directory = await tempRoot()
    expect(resolvePluginPackageSourceV1({
      kind: 'local-directory',
      location: new URL(`file://${directory}`).href,
    })).toMatchObject({ kind: 'local-directory', path: directory })
    expect(resolvePluginPackageSourceV1({
      kind: 'downloaded-tarball',
      location: new URL(`file://${path.join(directory, 'package.tgz')}`).href,
      downloadedFrom: 'https://plugins.example/package.tgz',
      expectedDigest: `sha256:${'a'.repeat(64)}`,
    })).toMatchObject({
      kind: 'downloaded-tarball',
      downloadedFrom: 'https://plugins.example/package.tgz',
      expectedIntegrity: `sha256:${'a'.repeat(64)}`,
    })
    expect(() => resolvePluginPackageSourceV1({
      kind: 'downloaded-tarball',
      location: new URL(`file://${path.join(directory, 'package.tgz')}`).href,
    })).toThrow('requires its HTTPS discovery URL')
    expect(() => resolvePluginPackageSourceV1({
      kind: 'local-package',
      location: 'https://plugins.example/package.tgz',
    })).toThrow('file URL')
  })

  it('resolves package v2 and preserves only the manifest-v3 Host configuration declaration', async () => {
    const root = await tempRoot()
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'index.js'), 'export default {}\n')
    const runtimeManifest = {
      $schema: runtimeManifestV3Schema,
      schemaVersion: 3,
      id: 'channel-demo',
      capabilities: [],
      services: [{
        id: 'channel',
        kind: 'channel-adapter',
        entry: './dist/channel.js',
        configuration: {
          kind: 'host',
          schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json',
          configApplies: 'restart',
        },
      }],
    } as const
    const runtimeBytes = Buffer.from(`${JSON.stringify(runtimeManifest, null, 2)}\n`)
    await writeFile(path.join(root, 'cordisx-runtime.json'), runtimeBytes)
    const runtimeDigest = `sha256:${createHash('sha256').update(runtimeBytes).digest('hex')}`
    await writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v2.schema.json',
      schemaVersion: 2,
      id: 'channel-demo',
      version: '1.0.0',
      entry: './dist/index.js',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: { runtimeAbi: 1, protocolSchemas: [runtimeManifestV3Schema] },
      dependencies: [],
      runtimeManifest: { path: './cordisx-runtime.json', schema: runtimeManifestV3Schema, digest: runtimeDigest },
    }, null, 2)}\n`)
    const resolver = new JsonPackageManifestV2Resolver({
      runtimeValidators: { [runtimeManifestV3Schema]: value => value as typeof runtimeManifest },
    })
    const resolved = await resolver.resolve(root)
    expect(resolved.runtime.manifest.services?.[0]?.configuration).toEqual(runtimeManifest.services[0].configuration)
    expect(JSON.stringify(resolved)).not.toMatch(/secretRef|secretState|transport|dataDir/)

    const tunneled = structuredClone(runtimeManifest) as unknown as Record<string, unknown>
    ;(tunneled.services as Array<Record<string, unknown>>)[0]!.secretRef = 'keychain:cordisx/channel/demo'
    const tunneledBytes = Buffer.from(`${JSON.stringify(tunneled)}\n`)
    await writeFile(path.join(root, 'cordisx-runtime.json'), tunneledBytes)
    const packageManifest = JSON.parse(await readFile(path.join(root, 'cordisx-package.json'), 'utf8')) as {
      runtimeManifest: { digest: string }
    }
    packageManifest.runtimeManifest.digest = `sha256:${createHash('sha256').update(tunneledBytes).digest('hex')}`
    await writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify(packageManifest)}\n`)
    await expect(resolver.resolve(root)).rejects.toMatchObject({ code: 'launcher-config-tunnel' })
  })

  it('rejects a separately referenced runtime manifest integrity mismatch', async () => {
    const root = await tempRoot()
    await mkdir(path.join(root, 'dist'), { recursive: true })
    await writeFile(path.join(root, 'dist', 'index.js'), 'export default {}\n')
    await writeFile(path.join(root, 'cordisx-runtime.json'), '{}\n')
    await writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
      $schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v2.schema.json',
      schemaVersion: 2,
      id: 'bad-runtime',
      version: '1.0.0',
      entry: './dist/index.js',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1] },
      dependencies: [],
      runtimeManifest: {
        path: './cordisx-runtime.json', schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        digest: `sha256:${'0'.repeat(64)}`,
      },
    })}\n`)
    const resolver = new JsonPackageManifestV2Resolver({
      runtimeValidators: { [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1]: value => value as never },
    })
    await expect(resolver.resolve(root)).rejects.toMatchObject({ code: 'integrity-mismatch' })
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
      compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1] },
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
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
    const plan = await host.resolveCandidate(candidateAccess(prepared), 'plan')
    const impact = await host.resolveImpact({
      impactToken: prepared.impactToken,
      ownerId: 'generation-runtime',
      profileId: 'default',
    }, 'plan')
    expect(plan.profileActivationRevision).toBe(0)
    expect(plan.current).toEqual(plan.expected)
    expect(plan.after.revision).toBe(1)
    expect(impact.affectedPluginIds).toEqual(['demo'])
    expect((await host.resolveRuntimeModule(candidateAccess(prepared), 'plan', 'demo'))).toMatchObject({
      identity: { pluginId: 'demo' },
      runtimeEntry: expect.stringContaining('/objects/sha256/'),
    })
    expect(JSON.stringify(prepared.state.transactions[prepared.transaction.transactionId])).not.toMatch(/capabilities|scope|secret/i)
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
    await expect(host.resolveCandidate(candidateAccess(prepared), 'plan'))
      .rejects.toMatchObject({ code: 'permission-review-required' })
    await expect(host.requestActivation(candidateAccess(prepared)))
      .rejects.toMatchObject({ code: 'permission-review-required' })
  })

  it('binds Host permission review to tokens/fences and clears allow-once on generation disposal', async () => {
    const revoked: string[][] = []
    const reviews: Array<{ candidateId: string; impactToken: string; ownerId: string; expected: PackageGenerationFence }> = []
    const permissionAuthority = createHostPermissionReviewAuthority(async input => {
      reviews.push(input)
      return {
        planId: `plan-${input.transactionId}`,
        planRevision: 7,
        decisionId: `decision-${input.transactionId}`,
        decisionFingerprint: input.manifestPermissionFingerprint,
        requiredSatisfied: true,
        unresolvedRequired: [],
        deniedRequired: [],
        oneShotGrantIds: ['grant:allow-once:demo'],
      }
    }, async ids => { revoked.push([...ids]) })
    const root = await tempRoot()
    const store = await JsonPackageStore.open(path.join(root, 'store'))
    const host = new PackageLifecycleHost(store, {
      runtimeAbi: 1,
      protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1],
      manifestResolver,
      permissionAuthority,
      rollbackAuthority,
    })
    const source = await makePackage(root, 'permission-bound', '1.0.0')
    const prepared = await host.prepare({
      ownerId: 'generation-runtime', operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: source },
    })
    expect(reviews).toMatchObject([{
      candidateId: prepared.candidateId,
      impactToken: prepared.impactToken,
      ownerId: 'generation-runtime',
      expected: { runtimeGeneration: runtime0, plugins: {} },
    }])
    expect(prepared.transaction.permission).toMatchObject({ planRevision: 7, oneShotGrantIds: ['grant:allow-once:demo'] })
    expect(JSON.stringify(prepared.transaction.permission)).not.toMatch(/capabilities|scope|secret/i)
    await expect(host.resolveCandidate({
      candidateId: prepared.candidateId,
      ownerId: 'generation-runtime',
      profileId: 'default',
    }, 'plan')).rejects.toMatchObject({ code: 'permission-review-token-invalid' })
    await expect(host.resolveCandidate({
      ...candidateAccess(prepared),
      permissionReviewToken: 'permission-token:forged' as NonNullable<PackageCandidateAccess['permissionReviewToken']>,
    }, 'plan')).rejects.toMatchObject({ code: 'permission-review-token-invalid' })
    const installed = (await activate(host, prepared)).committed
    expect(installed.profiles.default?.plugins['permission-bound']?.oneShotGrantIds).toEqual(['grant:allow-once:demo'])
    expect(revoked).toEqual([[]])

    const disabled = await host.prepare({
      ownerId: 'generation-runtime', operation: 'disable', pluginId: 'permission-bound', profileId: 'default',
      expectedRevision: installed.profiles.default!.revision,
      expected: stateFence(installed), proposedRuntimeGeneration: 'runtime-2',
    })
    await activate(host, disabled)
    expect(revoked).toEqual([[], ['grant:allow-once:demo']])
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
      ...candidateAccess(prepared),
      ownerId: 'renderer',
    }, 'plan')).rejects.toMatchObject({ code: 'candidate-owner-mismatch' })
    await expect(host.resolveCandidate({
      ...candidateAccess(prepared),
      candidateId: 'candidate:forged' as typeof prepared.candidateId,
    }, 'plan')).rejects.toMatchObject({ code: 'candidate-token-invalid' })
    const access = candidateAccess(prepared)
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
    const candidate = await host.requestActivation(candidateAccess(prepared))
    const receipt = readiness(candidate)
    const reopened = await JsonPackageStore.open(store.root)
    const recoveredHost = new PackageLifecycleHost(reopened, {
      runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1], manifestResolver,
      permissionAuthority: allowPermissions(),
      rollbackAuthority,
    })
    const recovery = await recoveredHost.recover({
      default: { runtimeGeneration: receipt.runtimeGeneration, plugins: receipt.plugins },
    })
    expect(recovery.directives).toMatchObject([{ action: 'rollback-published' }])
    expect(recovery.state.transactions[prepared.transaction.transactionId]?.status).toBe('rollback-pending')
    expect(recovery.state.profiles.default?.runtimeGeneration).toBe(runtime0)
    const directive = recovery.directives[0]!
    if (directive.rollbackToken === undefined) throw new Error('rollback token missing')
    const recovered = await recoveredHost.completeRollback({
      rollbackToken: directive.rollbackToken,
      ownerId: directive.ownerId,
      profileId: directive.profileId,
    })
    expect(recovered.transactions[prepared.transaction.transactionId]?.status).toBe('aborted')

    const secondSource = await makePackage(root, 'interrupted', '1.0.0')
    const second = await recoveredHost.prepare({
      ownerId: 'generation-runtime', operation: 'install', profileId: 'default',
      expectedRevision: recovered.profiles.default!.revision,
      expected: stateFence(recovered), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: secondSource },
    })
    const aborted = await recoveredHost.recover({})
    expect(aborted.directives).toMatchObject([{ action: 'discard-staged' }])
    expect(aborted.state.transactions[second.transaction.transactionId]?.status).toBe('recovered-aborted')
    expect(aborted.state.profiles.default?.runtimeGeneration).toBe(runtime0)
  })

  it('pins a published candidate through authenticated rollback completion', async () => {
    const { root, store, host } = await createHost()
    const v1 = await makePackage(root, 'rollback-demo', '1.0.0')
    const first = await host.prepare({
      ownerId: 'generation-runtime', operation: 'install', profileId: 'default', expectedRevision: 0,
      expected: { runtimeGeneration: runtime0, plugins: {} }, proposedRuntimeGeneration: 'runtime-1',
      source: { kind: 'local-directory', path: v1 },
    })
    const installed = (await activate(host, first)).committed
    const v2 = await makePackage(root, 'rollback-demo', '2.0.0')
    const update = await host.prepare({
      ownerId: 'generation-runtime', operation: 'update', pluginId: 'rollback-demo', profileId: 'default',
      expectedRevision: installed.profiles.default!.revision,
      expected: stateFence(installed), proposedRuntimeGeneration: 'runtime-2',
      source: { kind: 'local-directory', path: v2 },
    })
    const access = candidateAccess(update)
    const published = await host.requestActivation(access)
    const rollback = await host.beginRollback(access, 'readiness-failed')
    const candidateKey = `${published.after.plugins['rollback-demo']!.package!.identity.pluginId}@2.0.0#${published.after.plugins['rollback-demo']!.package!.identity.integrity}`
    await expect(host.abort(access, 'unsafe-abort')).rejects.toMatchObject({ code: 'rollback-required' })
    await expect(host.prepare({
      ownerId: 'generation-runtime', operation: 'disable', pluginId: 'rollback-demo', profileId: 'default',
      expectedRevision: installed.profiles.default!.revision,
      expected: stateFence(installed), proposedRuntimeGeneration: 'runtime-3',
    })).rejects.toMatchObject({ code: 'transaction-in-progress' })
    expect((await host.collectGarbage(0)).removed).not.toContain(candidateKey)

    const forgedHost = new PackageLifecycleHost(await JsonPackageStore.open(store.root), {
      runtimeAbi: 1,
      protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1],
      manifestResolver,
      permissionAuthority: allowPermissions(),
      rollbackAuthority: {
        complete: async plan => ({
          active: tupleObservation(plan.rollbackTarget),
          disposedAfter: tupleObservation(plan.expectedPublished),
          inputFingerprint: 'forged',
        }),
      },
    })
    const rollbackAccess = {
      rollbackToken: rollback.rollbackToken,
      ownerId: 'generation-runtime',
      profileId: 'default',
    } as const
    await expect(forgedHost.completeRollback(rollbackAccess))
      .rejects.toMatchObject({ code: 'untrusted-rollback-receipt' })

    const staleHost = new PackageLifecycleHost(await JsonPackageStore.open(store.root), {
      runtimeAbi: 1,
      protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1],
      manifestResolver,
      permissionAuthority: allowPermissions(),
      rollbackAuthority: createHostRollbackCompletionAuthority(async plan => ({
        active: { ...tupleObservation(plan.rollbackTarget), runtimeGeneration: 'runtime-stale' },
        disposedAfter: tupleObservation(plan.expectedPublished),
      })),
    })
    await expect(staleHost.completeRollback(rollbackAccess))
      .rejects.toMatchObject({ code: 'stale-rollback-receipt' })

    const rolledBack = await host.completeRollback(rollbackAccess)
    expect(rolledBack.transactions[update.transaction.transactionId]?.status).toBe('aborted')
    expect(rolledBack.profiles.default?.runtimeGeneration).toBe('runtime-1')
    expect((await host.collectGarbage(0)).removed).toContain(candidateKey)
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
    const records = host.activationRecords('default')
    expect(records.find(record => record.recordKind === 'active')?.plugins)
      .toMatchObject([{ id: 'upgradeable', version: '2.0.0', enabled: true }])
    expect(records.find(record => record.recordKind === 'last-good')?.plugins)
      .toMatchObject([{ id: 'upgradeable', version: '1.0.0', enabled: true }])
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
        lastGoodRuntimeGeneration: runtime0, lastGoodPlugins: {}, plugins: {},
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
        lastGoodRuntimeGeneration: runtime0, lastGoodPlugins: {}, plugins: {},
      }
    })).rejects.toThrow('injected process interruption')
    const recovered = await JsonPackageStore.open(storeRoot)
    expect(recovered.snapshot()).toMatchObject({ revision: 1, profiles: { default: { runtimeGeneration: runtime0 } } })
  })
})
