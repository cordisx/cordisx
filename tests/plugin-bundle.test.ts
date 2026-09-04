import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1,
  CORDISX_PLUGIN_BUNDLE_SCHEMA_V1,
  type CordisXPluginBundleLifecycleOperationV1,
} from '../packages/cli/src/plugin-bundle-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V1 } from '../packages/cli/src/platform-contracts.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V6 } from '../packages/cli/src/permission-contracts.js'
import { CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { PluginBundleCoordinator } from '../packages/cli/src/launcher/plugin-bundle.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  PluginLifecycleCoordinator,
  type PluginLifecycleRuntime,
  type PluginRuntimeMutation,
} from '../packages/cli/src/launcher/plugin-lifecycle.js'

const packageSchema = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v2.schema.json'
const packageSchemaV6 = 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-package.v6.schema.json'
const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async root => {
    const packageRoot = path.join(root, 'home', 'packages', 'sha256')
    for (const digest of await readdir(packageRoot).catch(() => [])) {
      await removeStagedPluginPackage(path.join(root, 'home'), `sha256:${digest}`)
    }
    await rm(root, { recursive: true, force: true })
  }))
  temporary.clear()
})

class FakeRuntime implements PluginLifecycleRuntime {
  readonly staged: PluginRuntimeMutation[] = []
  async stage(mutation: PluginRuntimeMutation): Promise<void> { this.staged.push(mutation) }
  async commit(): Promise<void> {}
  async abort(): Promise<void> {}
  async reload(): Promise<void> {}
}

async function pluginPackage(root: string, id: string, dependencies: readonly { id: string; version: string }[] = [], requiredCapability = false, version = '1.0.0'): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true })
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
    schemaVersion: 1,
    id,
    name: id.toUpperCase(),
    capabilities: requiredCapability ? [{
      name: 'models.read', required: true,
      reason: { key: 'permission.models', fallback: 'Read models' },
      scope: {},
    }] : [],
  }
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await Promise.all([
    writeFile(path.join(root, 'runtime.json'), runtimeText),
    writeFile(path.join(root, 'src/index.ts'), 'export function apply() {}\n'),
    writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
      $schema: packageSchema,
      schemaVersion: 2,
      id,
      version,
      entry: './src/index.ts',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V1] },
      dependencies,
      runtimeManifest: {
        path: './runtime.json', schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V1,
        digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
      },
    }, null, 2)}\n`),
  ])
}

async function agentPluginPackage(root: string, id: string): Promise<void> {
  await mkdir(path.join(root, 'src'), { recursive: true })
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
    schemaVersion: 6,
    id,
    capabilities: [{ name: 'agents.get', required: true, scope: {} }],
    services: [],
  }
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await Promise.all([
    writeFile(path.join(root, 'runtime.json'), runtimeText),
    writeFile(path.join(root, 'src/index.ts'), 'export function apply() {}\n'),
    writeFile(path.join(root, 'cordisx-package.json'), `${JSON.stringify({
      $schema: packageSchemaV6,
      schemaVersion: 6,
      id,
      version: '1.0.0',
      entry: './src/index.ts',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V6] },
      dependencies: [],
      runtimeManifest: {
        path: './runtime.json', schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V6,
        digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
      },
    }, null, 2)}\n`),
  ])
}

async function bundleFixture(input: {
  readonly root: string
  readonly id: string
  readonly includeStorage?: boolean
  readonly requiredCapability?: boolean
  readonly memberVersion?: string
  readonly bundleVersion?: string
}): Promise<string> {
  const bundle = path.join(input.root, input.id)
  await mkdir(path.join(bundle, 'plugins', 'notes'), { recursive: true })
  if (input.includeStorage) await mkdir(path.join(bundle, 'plugins', 'storage'), { recursive: true })
  await pluginPackage(
    path.join(bundle, 'plugins', 'notes'),
    'notes',
    input.includeStorage ? [{ id: 'storage', version: '1.0.0' }] : [],
    input.requiredCapability,
    input.memberVersion,
  )
  if (input.includeStorage) await pluginPackage(path.join(bundle, 'plugins', 'storage'), 'storage')
  const members = [
    ...(input.includeStorage ? [{ id: 'storage', version: '1.0.0', path: './plugins/storage', required: true, enabledByDefault: true }] : []),
    { id: 'notes', version: input.memberVersion ?? '1.0.0', path: './plugins/notes', required: true, enabledByDefault: true },
  ]
  await Promise.all([
    writeFile(path.join(bundle, 'README.md'), `# ${input.id}\n`),
    writeFile(path.join(bundle, 'cordisx-bundle.json'), `${JSON.stringify({
      $schema: CORDISX_PLUGIN_BUNDLE_SCHEMA_V1,
      schemaVersion: 1,
      id: input.id,
      name: input.id,
      version: input.bundleVersion ?? '1.0.0',
      authors: ['CordisX'],
      readme: './README.md',
      distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
      members,
    }, null, 2)}\n`),
  ])
  return bundle
}

async function harness() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-plugin-bundle-'))
  temporary.add(root)
  const homeDir = path.join(root, 'home')
  const runtime = new FakeRuntime()
  const pluginLifecycle = new PluginLifecycleCoordinator({
    homeDir, profileId: 'work', runtimeGeneration: 'runtime-1', permissionPolicies: [], runtime,
  })
  const coordinator = new PluginBundleCoordinator({ homeDir, profileId: 'work', runtimeGeneration: 'runtime-1', pluginLifecycle })
  pluginLifecycle.setBundleClaimGuard(async pluginId => await coordinator.bundleClaims(pluginId))
  return { root, runtime, pluginLifecycle, coordinator }
}

async function request(coordinator: PluginBundleCoordinator, operation: CordisXPluginBundleLifecycleOperationV1) {
  const snapshot = await coordinator.snapshot()
  return await coordinator.handle({
    $schema: CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1,
    schemaVersion: 1,
    requestId: `request-${Math.random().toString(36).slice(2)}`,
    profileId: snapshot.profileId,
    expectedRevision: snapshot.revision,
    expectedPluginRevision: snapshot.pluginRevision,
    runtimeGeneration: snapshot.runtimeGeneration,
    operation,
  })
}

async function inspectAndInstall(coordinator: PluginBundleCoordinator, directory: string) {
  const planned = await request(coordinator, { kind: 'inspect-source', source: { kind: 'local-directory', location: pathToFileURL(directory).href } })
  expect(planned.outcome, JSON.stringify(planned.plan?.conflicts)).toBe('planned')
  const bundlePermissions = planned.plan!.permissionRequests.map(permission => ({ permissionId: permission.permissionId, policy: 'allow' as const }))
  const applied = await request(coordinator, {
    kind: 'install', candidateId: planned.candidateId!, impactToken: planned.impactToken!, bundlePermissions, pluginOverrides: [],
  })
  expect(applied.outcome).toBe('applied')
  return { planned, applied }
}

describe('Host plugin bundle coordinator', () => {
  it('keeps manifest-v6 Agent Session capabilities on their dedicated runtime permission plane', async () => {
    const { root, coordinator } = await harness()
    const directory = await bundleFixture({ root, id: 'agent-workflow' })
    await agentPluginPackage(path.join(directory, 'plugins', 'notes'), 'notes')
    const planned = await request(coordinator, { kind: 'inspect-source', source: { kind: 'local-directory', location: pathToFileURL(directory).href } })
    expect(planned).toMatchObject({ outcome: 'planned', plan: { permissionRequests: [] } })
    const installed = await request(coordinator, {
      kind: 'install', candidateId: planned.candidateId!, impactToken: planned.impactToken!, bundlePermissions: [], pluginOverrides: [],
    })
    expect(installed.outcome).toBe('applied')
  })

  it('installs exact members dependency-first and binds required permissions to explicit bundle choices', async () => {
    const { root, runtime, pluginLifecycle, coordinator } = await harness()
    const directory = await bundleFixture({ root, id: 'team-workflow', includeStorage: true, requiredCapability: true })
    const inspected = await request(coordinator, { kind: 'inspect-source', source: { kind: 'local-directory', location: pathToFileURL(directory).href } })
    expect(inspected.plan?.memberActions.map(item => item.pluginId)).toEqual(['storage', 'notes'])
    expect(inspected.plan?.permissionRequests).toMatchObject([{ pluginId: 'notes', capability: 'models.read', required: true, defaultPolicy: 'ask' }])
    const blocked = await request(coordinator, {
      kind: 'install', candidateId: inspected.candidateId!, impactToken: inspected.impactToken!, bundlePermissions: [], pluginOverrides: [],
    })
    expect(blocked).toMatchObject({ outcome: 'rejected', error: { code: 'permission-review-required' } })
    const installed = await request(coordinator, {
      kind: 'install', candidateId: inspected.candidateId!, impactToken: inspected.impactToken!,
      bundlePermissions: inspected.plan!.permissionRequests.map(item => ({ permissionId: item.permissionId, policy: 'allow' })), pluginOverrides: [],
    })
    expect(installed.outcome).toBe('applied')
    expect((await pluginLifecycle.store.loadActive()).plugins.map(item => item.id)).toEqual(['storage', 'notes'])
    expect(runtime.staged.map(item => item.targetId)).toEqual(['storage', 'notes'])
    expect((await coordinator.snapshot()).bundles[0]).toMatchObject({ status: 'active', readme: '# team-workflow\n' })
  })

  it('tracks cross-bundle claims and retains a shared plugin until the final claim is removed', async () => {
    const { root, pluginLifecycle, coordinator } = await harness()
    const first = await bundleFixture({ root, id: 'bundle-one' })
    const second = await bundleFixture({ root, id: 'bundle-two' })
    const directFirst = await pluginLifecycle.stagePackageSource({ kind: 'local-directory', location: pathToFileURL(path.join(first, 'plugins', 'notes')).href })
    const directSecond = await pluginLifecycle.stagePackageSource({ kind: 'local-directory', location: pathToFileURL(path.join(second, 'plugins', 'notes')).href })
    expect(directSecond.manifest).toEqual(directFirst.manifest)
    expect(directSecond.moduleSource).toBe(directFirst.moduleSource)
    expect(directSecond.artifactSource).toBe(directFirst.artifactSource)
    expect(directSecond.digest, 'identical packages in different directories must have the same immutable digest').toBe(directFirst.digest)
    await inspectAndInstall(coordinator, first)
    const shared = await inspectAndInstall(coordinator, second)
    expect(shared.planned.plan?.memberActions).toMatchObject([{ pluginId: 'notes', action: 'share', reason: 'other-bundle-claim' }])

    const preview = await request(coordinator, { kind: 'uninstall', bundleId: 'bundle-one', impactToken: '' })
    expect(preview).toMatchObject({ outcome: 'planned', affectedPluginIds: [], retainedPluginIds: ['notes'] })
    const removedBundle = await request(coordinator, { kind: 'uninstall', bundleId: 'bundle-one', impactToken: preview.impactToken! })
    expect(removedBundle.outcome).toBe('applied')
    expect((await pluginLifecycle.store.loadActive()).plugins.map(item => item.id)).toEqual(['notes'])

    const finalPreview = await request(coordinator, { kind: 'uninstall', bundleId: 'bundle-two', impactToken: '' })
    expect(finalPreview.affectedPluginIds).toEqual(['notes'])
    const final = await request(coordinator, { kind: 'uninstall', bundleId: 'bundle-two', impactToken: finalPreview.impactToken! })
    expect(final).toMatchObject({ outcome: 'applied', removedPluginIds: ['notes'] })
    expect((await pluginLifecycle.store.loadActive()).plugins).toEqual([])
  })

  it('merges shared bundle policy deny over allow and lets an explicit plugin override win globally', async () => {
    const { root, coordinator } = await harness()
    const first = await bundleFixture({ root, id: 'bundle-one', requiredCapability: true })
    const second = await bundleFixture({ root, id: 'bundle-two', requiredCapability: true })
    await inspectAndInstall(coordinator, first)
    await inspectAndInstall(coordinator, second)
    const initial = await coordinator.snapshot()
    const firstBundle = initial.bundles.find(item => item.id === 'bundle-one')!
    const permission = firstBundle.permissions[0]!

    const preview = await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-one', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'deny' }], pluginOverrides: [], clearPluginOverrides: [], impactToken: '',
    })
    await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-one', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'deny' }], pluginOverrides: [], clearPluginOverrides: [], impactToken: preview.impactToken!,
    })
    expect((await coordinator.snapshot()).bundles.every(bundle => bundle.permissions[0]?.effectivePolicy === 'deny')).toBe(true)

    const overridePreview = await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-one', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'deny' }],
      pluginOverrides: [{ pluginId: 'notes', permissionId: permission.permissionId, policy: 'allow' }], clearPluginOverrides: [], impactToken: '',
    })
    await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-one', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'deny' }],
      pluginOverrides: [{ pluginId: 'notes', permissionId: permission.permissionId, policy: 'allow' }], clearPluginOverrides: [], impactToken: overridePreview.impactToken!,
    })
    expect((await coordinator.snapshot()).bundles.every(bundle => bundle.permissions[0]?.effectiveSource === 'plugin-override' && bundle.permissions[0]?.effectivePolicy === 'allow')).toBe(true)

    const clearPreview = await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-one', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'deny' }],
      pluginOverrides: [], clearPluginOverrides: [{ pluginId: 'notes', permissionId: permission.permissionId }], impactToken: '',
    })
    await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-one', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'deny' }],
      pluginOverrides: [], clearPluginOverrides: [{ pluginId: 'notes', permissionId: permission.permissionId }], impactToken: clearPreview.impactToken!,
    })
    expect((await coordinator.snapshot()).bundles.every(bundle => bundle.permissions[0]?.pluginOverride === undefined && bundle.permissions[0]?.effectivePolicy === 'deny')).toBe(true)

    const disablePreview = await request(coordinator, { kind: 'disable', bundleId: 'bundle-one', impactToken: '' })
    await request(coordinator, { kind: 'disable', bundleId: 'bundle-one', impactToken: disablePreview.impactToken! })
    const floored = (await coordinator.snapshot()).bundles.find(bundle => bundle.id === 'bundle-two')!.permissions[0]!
    expect(floored).toMatchObject({ effectivePolicy: 'deny', effectiveSource: 'safety-floor' })

    const acceptWidening = await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-two', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'allow' }],
      pluginOverrides: [], clearPluginOverrides: [], impactToken: '',
    })
    await request(coordinator, {
      kind: 'set-permissions', bundleId: 'bundle-two', bundlePermissions: [{ permissionId: permission.permissionId, policy: 'allow' }],
      pluginOverrides: [], clearPluginOverrides: [], impactToken: acceptWidening.impactToken!,
    })
    expect((await coordinator.snapshot()).bundles.find(bundle => bundle.id === 'bundle-two')!.permissions[0]).toMatchObject({ effectivePolicy: 'allow', effectiveSource: 'bundle' })
  })

  it('separates active enable intent from durable ownership and blocks direct removal of managed members', async () => {
    const { root, pluginLifecycle, coordinator } = await harness()
    await inspectAndInstall(coordinator, await bundleFixture({ root, id: 'bundle-one' }))
    await inspectAndInstall(coordinator, await bundleFixture({ root, id: 'bundle-two' }))

    const secondPreview = await request(coordinator, { kind: 'disable', bundleId: 'bundle-two', impactToken: '' })
    expect(secondPreview).toMatchObject({ affectedPluginIds: [], retainedPluginIds: ['notes'] })
    await request(coordinator, { kind: 'disable', bundleId: 'bundle-two', impactToken: secondPreview.impactToken! })
    expect((await coordinator.snapshot()).bundles.find(bundle => bundle.id === 'bundle-two')).toMatchObject({ enabled: false, status: 'disabled' })
    const firstPreview = await request(coordinator, { kind: 'disable', bundleId: 'bundle-one', impactToken: '' })
    expect(firstPreview).toMatchObject({ affectedPluginIds: ['notes'], retainedPluginIds: [] })
    await request(coordinator, { kind: 'disable', bundleId: 'bundle-one', impactToken: firstPreview.impactToken! })
    expect((await pluginLifecycle.store.loadActive()).plugins[0]).toMatchObject({ id: 'notes', enabled: false })
    expect((await coordinator.snapshot()).bundles.find(bundle => bundle.id === 'bundle-one')).toMatchObject({ enabled: false, status: 'disabled' })

    const active = await pluginLifecycle.store.loadActive()
    const direct = await pluginLifecycle.handle({
      $schema: CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
      schemaVersion: 1,
      requestId: 'direct-uninstall-managed-member',
      profileId: 'work',
      expectedRevision: active.revision,
      runtimeGeneration: 'runtime-1',
      operation: { kind: 'uninstall', pluginId: 'notes', impactToken: '' },
    })
    expect(direct).toMatchObject({ outcome: 'rejected', error: { code: 'operation-unavailable' } })
    expect(direct.error?.message).toContain('bundle-one, bundle-two')
    expect((await coordinator.snapshot()).bundles.flatMap(bundle => bundle.records.map(record => record.kind))).toContain('disable')
  })

  it('updates an exclusively owned member and removes members dropped by the new bundle version', async () => {
    const { root, pluginLifecycle, coordinator } = await harness()
    const directory = await bundleFixture({ root, id: 'bundle-updated', includeStorage: true })
    await inspectAndInstall(coordinator, directory)
    await bundleFixture({ root, id: 'bundle-updated', memberVersion: '2.0.0', bundleVersion: '2.0.0' })

    const planned = await request(coordinator, { kind: 'inspect-source', source: { kind: 'local-directory', location: pathToFileURL(directory).href } })
    expect(planned.outcome).toBe('planned')
    expect(planned.plan?.memberActions).toEqual(expect.arrayContaining([
      expect.objectContaining({ pluginId: 'notes', version: '2.0.0', action: 'update' }),
      expect.objectContaining({ pluginId: 'storage', action: 'remove', reason: 'orphaned' }),
    ]))
    const applied = await request(coordinator, {
      kind: 'update', candidateId: planned.candidateId!, impactToken: planned.impactToken!, bundlePermissions: [], pluginOverrides: [],
    })
    expect(applied).toMatchObject({ outcome: 'applied', removedPluginIds: ['storage'] })
    expect((await pluginLifecycle.store.loadActive()).plugins).toMatchObject([{ id: 'notes', version: '2.0.0' }])
    expect((await coordinator.snapshot()).bundles[0]).toMatchObject({ version: '2.0.0', members: [{ pluginId: 'notes', requestedVersion: '2.0.0' }] })
  })
})
