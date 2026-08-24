import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import {
  ChannelRuntime,
  LauncherChannelServiceHost,
} from '../packages/channel-runtime/src/index.js'
import {
  SIMULATOR_CHANNEL_SERVICE_CONFIG,
  SimulatedPermissionBroker,
  SimulatedTaskGateway,
} from '../packages/channel-runtime/src/simulator.js'
import { CapabilityRiskCatalog } from '../packages/cli/src/capability-risk-catalog.js'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V3,
} from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV4 } from '../packages/cli/src/permission-model-v2.js'
import {
  PackageLifecycleAuthority,
  createHostPermissionReviewAuthority,
  stagePluginPackageSourceV1,
  type CandidateAccess,
} from '../packages/cli/src/launcher/packages/index.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
  type CordisXPluginActivationRecordV1,
} from '../packages/cli/src/plugin-lifecycle-contracts.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(async (root) => {
    const homeDir = path.join(root, 'home')
    const digests = await readdir(path.join(homeDir, 'packages', 'sha256')).catch(() => [])
    await Promise.all(digests.map(digest => removeStagedPluginPackage(homeDir, `sha256:${digest}`)))
    await rm(root, { recursive: true, force: true })
  }))
  temporary.clear()
})

async function packageFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-channel-service-'))
  temporary.add(root)
  const homeDir = path.join(root, 'home')
  const source = path.join(root, 'source')
  await mkdir(path.join(source, 'src'), { recursive: true })
  await writeFile(path.join(source, 'src/index.js'), 'export function apply() {}\n')
  await writeFile(path.join(source, 'src/service.js'), `
export const inject = ['channel']
export async function apply(ctx, config) {
  const connection = config.connections.find(item => item.enabled && item.adapterKind === 'simulator')
  if (!connection) throw new Error('simulator connection missing')
  await ctx.channel.adapters.register({
    descriptor: {
      ref: connection.ref,
      kind: 'simulator',
      implementationStatus: 'verified',
      configurationRevision: 1,
      secretState: 'unavailable',
    },
    async start() {
      return {
        async send(delivery) { return { externalMessageId: 'loaded:' + delivery.deliveryId } },
        async stop() {},
      }
    },
  })
}
`)
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
    schemaVersion: 4,
    id: 'channel-simulator-package',
    capabilities: [{
      name: 'channel.accounts.connect',
      required: true,
      scope: {
        channelTenants: [{ adapterId: 'simulator', accountId: 'local', tenantId: 'test' }],
      },
    }],
    services: [{
      id: 'simulator',
      kind: 'channel-adapter',
      entry: './src/service.js',
      configuration: {
        kind: 'host',
        schema: 'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/channel-service-config.v1.schema.json',
        configApplies: 'restart',
      },
    }],
  } as const
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await writeFile(path.join(source, 'runtime.json'), runtimeText)
  await writeFile(path.join(source, 'cordisx-package.json'), `${JSON.stringify({
    $schema: CORDISX_PLUGIN_PACKAGE_SCHEMA_V3,
    schemaVersion: 3,
    id: runtime.id,
    version: '1.0.0',
    entry: './src/index.js',
    distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
    compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4] },
    dependencies: [],
    runtimeManifest: {
      path: './runtime.json',
      schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V4,
      digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
    },
  }, null, 2)}\n`)
  return { root, homeDir, source, runtime }
}

describe('launcher Channel service module loading', () => {
  it('snapshots, stores, authority-resolves, loads, activates, and generation-disposes a Node service', async () => {
    const fixture = await packageFixture()
    const staged = await stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(fixture.source).href,
    }, {
      homeDir: fixture.homeDir,
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4]: value => normalizePluginManifestV4(
          value,
          fixture.runtime.id,
          new CapabilityRiskCatalog(),
        ),
      },
    })
    expect(staged.serviceModules).toEqual([
      expect.objectContaining({ declaration: expect.objectContaining({ id: 'simulator', kind: 'channel-adapter' }) }),
    ])

    const authority = await PackageLifecycleAuthority.open({
      homeDir: fixture.homeDir,
      profileId: 'default',
      runtimeGeneration: 'runtime-1',
      permissionAuthority: createHostPermissionReviewAuthority(async input => ({
        planId: `plan:${input.transactionId}`,
        planRevision: input.permissionPlanRevision,
        decisionId: `decision:${input.transactionId}`,
        decisionFingerprint: 'a'.repeat(64),
        requiredSatisfied: true,
        unresolvedRequired: [],
        deniedRequired: [],
        oneShotGrantIds: [],
      }), async () => undefined),
    })
    const candidate: CordisXPluginActivationRecordV1 = {
      $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
      schemaVersion: 1,
      recordKind: 'candidate',
      transactionId: 'install-channel-simulator',
      profileId: 'default',
      revision: 1,
      lastGoodRevision: 0,
      runtimeGeneration: 'runtime-1',
      plugins: [{
        id: fixture.runtime.id,
        version: '1.0.0',
        digest: staged.digest,
        moduleGeneration: 'channel-simulator-generation-1',
        enabled: true,
        dependencies: [],
      }],
    }
    await authority.activation.writeCandidate(candidate)
    const prepared = await authority.prepare({
      ownerId: 'launcher-runtime',
      operation: 'install',
      candidateId: candidate.transactionId!,
      transactionEpoch: 'transaction-epoch-1',
      expectedRegistryEpoch: 0,
      permissionPlanRevision: 1,
      permissionPlanFingerprint: 'b'.repeat(64),
    })
    const access: CandidateAccess = {
      ownerId: 'launcher-runtime',
      profileId: 'default',
      candidateToken: prepared.candidateToken,
      permissionReviewToken: prepared.permissionReviewToken,
    }
    const serviceAccess = await authority.resolveRuntimeService(
      access,
      'plan',
      fixture.runtime.id,
      'simulator',
    )
    expect(serviceAccess).toMatchObject({
      runtimeEntry: './services/simulator.mjs',
      serviceKind: 'channel-adapter',
      packageIdentity: { pluginId: fixture.runtime.id, integrity: staged.digest },
      pluginIdentity: {
        source: staged.identitySource,
        pluginId: fixture.runtime.id,
        generation: candidate.plugins[0]!.moduleGeneration,
      },
    })

    const runtime = await ChannelRuntime.open({
      gateway: new SimulatedTaskGateway(),
      permissions: new SimulatedPermissionBroker('allow'),
      storePath: path.join(fixture.root, 'channel-store.json'),
    })
    const host = new LauncherChannelServiceHost(runtime)
    await expect(host.activate({
      ...serviceAccess,
      pluginIdentity: { ...serviceAccess.pluginIdentity, pluginId: 'forged-plugin' },
    }, SIMULATOR_CHANNEL_SERVICE_CONFIG)).rejects.toThrow('identity is not bound')
    const active = await host.activate(serviceAccess, SIMULATOR_CHANNEL_SERVICE_CONFIG)
    expect(runtime.snapshot().accounts).toEqual([
      expect.objectContaining({
        adapterKind: 'simulator',
        connectionState: 'ready',
        generation: 1,
      }),
    ])

    await active.dispose()
    expect(runtime.snapshot().accounts[0]).toMatchObject({ connectionState: 'stopped' })
    await host.dispose()
    await removeStagedPluginPackage(fixture.homeDir, staged.digest)
  })

  it('rejects a manifest service entry that is absent from the source snapshot', async () => {
    const fixture = await packageFixture()
    await rm(path.join(fixture.source, 'src/service.js'))
    await expect(stagePluginPackageSourceV1({
      kind: 'local-directory',
      location: pathToFileURL(fixture.source).href,
    }, {
      homeDir: fixture.homeDir,
      runtimeValidators: {
        [CORDISX_PLUGIN_MANIFEST_SCHEMA_V4]: value => normalizePluginManifestV4(
          value,
          fixture.runtime.id,
          new CapabilityRiskCatalog(),
        ),
      },
    })).rejects.toMatchObject({ code: 'invalid-package-manifest' })
  })
})
