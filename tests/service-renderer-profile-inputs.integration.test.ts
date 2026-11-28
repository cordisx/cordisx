import { randomBytes } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { loadHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { abortPluginConfigCandidate, stagePluginConfigCandidate } from '../packages/cli/src/config/plugin-config.js'
import { abortServiceConfigCandidate, stageServiceConfigCandidate } from '../packages/cli/src/config/service-config.js'
import { PackagePluginConfigStore } from '../packages/cli/src/launcher/package-plugin-config.js'
import { PackagePluginServiceConfigStore } from '../packages/cli/src/launcher/package-plugin-service-config.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { readSettledPackageInputs } from '../packages/cli/src/cli/service-renderer-profile-inputs.js'
import { createServiceRendererProjector } from '../packages/cli/src/cli/service-renderer-projection.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle-model.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { fixture } from './fixtures/service-renderer-bootstrap-fixture.js'

const secret = () => randomBytes(32).toString('hex')
const supported = process.platform === 'darwin' || process.platform === 'linux'
const channelArchive = process.env.CORDISX_CHANNEL_ENTRY_FIXTURE

for (const state of ['plugin-candidate', 'service-candidate', 'nonempty'] as const) {
  it.skipIf(!supported)(
    'rejects a lifecycle projection with unsettled or unsupported package configuration: ' + state,
    async () => {
      const root = await mkdtemp('/tmp/cx-manager-config-projection-')
      const ownerToken = secret()
      try {
        const plugins = new PackagePluginConfigStore(root, 'default', 'owner')
        if (state === 'service-candidate') {
          const services = new PackagePluginServiceConfigStore(root, 'default', 'owner')
          await services.stage({
            profileId: 'default',
            pluginId: 'future',
            serviceId: 'runtime',
            generation: 'owner',
            ownerToken,
            initialConfig: {},
            expectedRevision: 0,
            config: { enabled: true },
            applies: 'service-restart',
          })
        } else {
          await plugins.stage('future', 0, { enabled: true }, ownerToken)
          if (state === 'nonempty') await plugins.commit('future', 1, ownerToken)
        }
        const previous = {
          $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
          schemaVersion: 1,
          recordKind: 'active',
          profileId: 'default',
          revision: 0,
          lastGoodRevision: 0,
          runtimeGeneration: 'owner',
          plugins: [],
        }
        const candidate = {
          ...previous,
          recordKind: 'candidate',
          transactionId: 'transaction',
          revision: 1,
          plugins: [{
            id: 'future',
            version: '1.0.0',
            digest: 'sha256:' + 'a'.repeat(64),
            moduleGeneration: 'future-generation',
            enabled: true,
            dependencies: [],
          }],
        }
        const mutation = {
          transactionId: 'transaction',
          transactionEpoch: 'transaction:preflight',
          operation: 'install',
          targetId: 'future',
          affectedPluginIds: ['future'],
          previous,
          candidate,
        } as unknown as PluginRuntimeMutation
        const project = createServiceRendererProjector({
          homeDir: root,
          profileId: 'default',
          generation: 'owner',
          isLive: () => true,
          canMutate: () => true,
        })
        await expect(project(mutation, {
          appId: 'codex',
          adapterId: 'codex',
          rendererId: 'renderer',
          pid: process.pid,
          processStartedAt: 'fixture',
        })).rejects.toThrow(/candidate is pending|renderer-profile-input-(pending|unavailable)/u)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
}

it.skipIf(!supported)('does not follow a redirected package-service state directory', async () => {
  const root = await mkdtemp('/tmp/cx-manager-config-path-')
  try {
    const plugins = path.join(root, 'state/profiles/default/plugins')
    const outside = path.join(root, 'elsewhere')
    await mkdir(plugins, { recursive: true, mode: 0o700 })
    await mkdir(outside, { mode: 0o700 })
    await symlink(outside, path.join(plugins, 'services'), 'dir')
    await expect(readSettledPackageInputs({
      homeDir: root,
      profileId: 'default',
      generation: 'owner',
      pluginIds: ['fixture'],
    })).rejects.toThrow('renderer-profile-input-unavailable')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!supported)('does not admit a redirected installed-plugin configuration file', async () => {
  const root = await mkdtemp('/tmp/cx-manager-config-file-')
  try {
    const directory = path.join(root, 'state/profiles/default/plugins/config')
    const outside = path.join(root, 'elsewhere.json')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await writeFile(outside, JSON.stringify({ version: 1, pluginId: 'fixture', revision: 0, config: {} }), {
      mode: 0o600,
    })
    await symlink(outside, path.join(directory, 'fixture.json'))
    await expect(readSettledPackageInputs({
      homeDir: root,
      profileId: 'default',
      generation: 'owner',
      pluginIds: ['fixture'],
    })).rejects.toThrow()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.skipIf(!supported)(
  'accepts the owner-selected startup configuration without exposing it to the Manager',
  async () => {
    const marker = 'synthetic-private-startup-value'
    const f = await fixture({
      managedUiVersion: 15,
      protectProfileInputs: true,
      managedStartupConfig: { 'fixture-service': { marker } },
    })
    try {
      const prepared = await f.call({ action: 'prepare' }) as any
      expect(prepared.status).toBe('ok')
      const source = prepared.value.privateGraphs[0]
      const origin = 'http://127.0.0.1:43123'
      const baseUrl = `${origin}/api/renderer/graphs/${secret()}/`
      const graph = {
        leaseId: secret(),
        pluginId: source.pluginId,
        moduleGeneration: source.moduleGeneration,
        baseUrl,
        entryUrl: baseUrl + source.entryUrl.slice(source.baseUrl.length),
        initialStyleUrls: source.initialStyleUrls.map((url: string) => baseUrl + url.slice(source.baseUrl.length)),
      }
      const completed = await f.call({ action: 'complete', managerOrigin: origin, graphs: [graph] }) as any
      expect(completed.status).toBe('ok')
      const bytes = await decodeManagerRendererBundle(completed.value.bundle)
      try {
        expect(bytes.includes(Buffer.from(marker))).toBe(false)
      } finally {
        bytes.fill(0)
      }
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(!supported)(
  'rejects admission when the owner started with an older managed-service startup configuration',
  async () => {
    const f = await fixture({ managedUiVersion: 15, protectProfileInputs: true })
    try {
      const before = await loadHomeConfig(f.configPath)
      await updateHomeConfigAtomic(current => ({
        ...current,
        apps: {
          ...current.apps,
          codex: {
            ...current.apps.codex!,
            profiles: {
              ...current.apps.codex!.profiles,
              [f.profileId]: {
                ...current.apps.codex!.profiles[f.profileId]!,
                managedServiceStartupConfig: { 'fixture-service': { enabled: true } },
              },
            },
          },
        },
      }), f.configPath)
      const result = await f.call({ action: 'prepare' }) as { readonly status: string }
      expect(result.status).toBe('unavailable')
      await vi.waitFor(async () => await updateHomeConfigAtomic(() => before, f.configPath))
      const browserSessionId = secret()
      const handle = (await f.sessions.open(f.gateway, browserSessionId))!
      const recovered = await f.sessions.call(
        { gateway: f.gateway, browserSessionId, handle },
        'manager-bootstrap',
        { action: 'prepare' },
      ) as { readonly status: string }
      expect(recovered.status).toBe('ok')
    } finally {
      await f.close()
    }
  },
  30_000,
)

it.skipIf(!supported)(
  'retires a Manager if managed-service startup configuration changes outside the fence',
  async () => {
    const f = await fixture({ managedUiVersion: 15, protectProfileInputs: true })
    try {
      const prepared = await f.call({ action: 'prepare' }) as { readonly status: string }
      expect(prepared.status).toBe('ok')
      const current = await loadHomeConfig(f.configPath)
      const changed = {
        ...current,
        apps: {
          ...current.apps,
          codex: {
            ...current.apps.codex!,
            profiles: {
              ...current.apps.codex!.profiles,
              [f.profileId]: {
                ...current.apps.codex!.profiles[f.profileId]!,
                managedServiceStartupConfig: { 'fixture-service': { enabled: true } },
              },
            },
          },
        },
      }
      await writeFile(f.configPath, JSON.stringify(changed))
      const result = await f.call({ action: 'status' }) as { status: string; value?: { current?: boolean } }
      expect(result.status === 'unavailable' || result.value?.current === false).toBe(true)
    } finally {
      await f.close()
    }
  },
  30_000,
)

for (const pending of ['plugin', 'service'] as const) {
  it.skipIf(!supported)(
    `refuses Manager admission while an installed ${pending} configuration candidate is pending`,
    async () => {
      const f = await fixture({ protectProfileInputs: true })
      const ownerToken = secret()
      const plugins = new PackagePluginConfigStore(f.homeDir, f.profileId, f.generation)
      const services = new PackagePluginServiceConfigStore(f.homeDir, f.profileId, f.generation)
      const scope = {
        profileId: f.profileId,
        pluginId: 'candidate-fixture',
        serviceId: 'runtime',
        generation: f.generation,
        ownerToken,
        initialConfig: {},
      }
      try {
        expect(await f.install('candidate-fixture')).toMatchObject({ outcome: 'applied' })
        if (pending === 'plugin') await plugins.stage('candidate-fixture', 0, { value: 'pending' }, ownerToken)
        else {
          await services.stage({
            ...scope,
            expectedRevision: 0,
            config: { value: 'pending' },
            applies: 'service-restart',
          })
        }
        const result = await f.call({ action: 'prepare' }) as { readonly status: string }
        expect(result.status).toBe('unavailable')
        await vi.waitFor(async () => {
          if (pending === 'plugin') await plugins.abort('candidate-fixture', 1, ownerToken)
          else await services.abort({ ...scope, candidateRevision: 1 })
        })
        const browserSessionId = secret()
        const handle = (await f.sessions.open(f.gateway, browserSessionId))!
        const recovered = await f.sessions.call(
          { gateway: f.gateway, browserSessionId, handle },
          'manager-bootstrap',
          { action: 'prepare' },
        ) as { readonly status: string }
        expect(recovered.status).toBe('ok')
      } finally {
        await f.close()
      }
    },
    30_000,
  )
}

for (const pending of ['plugin', 'service'] as const) {
  it.skipIf(!supported || !channelArchive)(
    `refuses a configured Channel with a pending ${pending} configuration candidate`,
    async () => {
      const f = await fixture({
        channelArchive,
        channelUiGrant: true,
        protectProfileInputs: true,
        channelServiceConfig: true,
      })
      const scope = { profileId: f.profileId, pluginId: 'channel', generation: f.generation, ownerToken: secret() }
      const serviceScope = { ...scope, serviceId: 'runtime', initialConfig: {} }
      try {
        if (pending === 'plugin') {
          await stagePluginConfigCandidate({ ...scope, expectedRevision: 0, config: {} }, f.configPath)
        } else {
          await stageServiceConfigCandidate({
            ...serviceScope,
            expectedRevision: 1,
            config: {},
            applies: 'service-restart',
          }, f.configPath)
        }
        const result = await f.call({ action: 'prepare' }) as { readonly status: string }
        expect(result.status).toBe('unavailable')
        await vi.waitFor(async () => {
          if (pending === 'plugin') await abortPluginConfigCandidate({ ...scope, candidateRevision: 1 }, f.configPath)
          else await abortServiceConfigCandidate({ ...serviceScope, candidateRevision: 2 }, f.configPath)
        })
        const browserSessionId = secret()
        const handle = (await f.sessions.open(f.gateway, browserSessionId))!
        const recovered = await f.sessions.call(
          { gateway: f.gateway, browserSessionId, handle },
          'manager-bootstrap',
          { action: 'prepare' },
        ) as { readonly status: string }
        expect(recovered.status).toBe('ok')
      } finally {
        await f.close()
      }
    },
    30_000,
  )
}

it.skipIf(!supported)('does not block admission for another profile’s pending configuration', async () => {
  const f = await fixture({ protectProfileInputs: true })
  const ownerToken = secret()
  try {
    expect(await f.install('other-profile-fixture')).toMatchObject({ outcome: 'applied' })
    const plugins = new PackagePluginConfigStore(f.homeDir, 'other', f.generation)
    const services = new PackagePluginServiceConfigStore(f.homeDir, 'other', f.generation)
    await plugins.stage('other-profile-fixture', 0, { value: 1 }, ownerToken)
    await services.stage({
      profileId: 'other',
      pluginId: 'other-profile-fixture',
      serviceId: 'runtime',
      generation: f.generation,
      ownerToken,
      initialConfig: {},
      expectedRevision: 0,
      config: { value: 1 },
      applies: 'service-restart',
    })
    const result = await f.call({ action: 'prepare' }) as { readonly status: string }
    expect(result.status).toBe('ok')
  } finally {
    await f.close()
  }
}, 30_000)

for (const changed of ['plugin', 'service'] as const) {
  it.skipIf(!supported)(
    `retires a Manager when an installed ${changed} configuration changes outside the fence`,
    async () => {
      const f = await fixture({ protectProfileInputs: true })
      const ownerToken = secret()
      const plugins = new PackagePluginConfigStore(f.homeDir, f.profileId, f.generation)
      const services = new PackagePluginServiceConfigStore(f.homeDir, f.profileId, f.generation)
      const scope = {
        profileId: f.profileId,
        pluginId: 'changed-fixture',
        serviceId: 'runtime',
        generation: f.generation,
        ownerToken,
        initialConfig: {},
      }
      try {
        expect(await f.install('changed-fixture')).toMatchObject({ outcome: 'applied' })
        if (changed === 'plugin') {
          await plugins.stage('changed-fixture', 0, {}, ownerToken)
          await plugins.commit('changed-fixture', 1, ownerToken)
        } else {
          await services.stage({ ...scope, expectedRevision: 0, config: { value: 1 }, applies: 'service-restart' })
          await services.commit({ ...scope, candidateRevision: 1, applies: 'service-restart' })
        }
        const prepared = await f.call({ action: 'prepare' }) as { readonly status: string }
        expect(prepared.status).toBe('ok')
        expect(await f.call({ action: 'status' })).toMatchObject({ status: 'ok', value: { current: true } })
        const file = changed === 'plugin'
          ? path.join(f.homeDir, 'state/profiles', f.profileId, 'plugins/config/changed-fixture.json')
          : path.join(f.homeDir, 'state/profiles', f.profileId, 'plugins/services/changed-fixture/runtime.json')
        const stored = JSON.parse(await readFile(file, 'utf8')) as {
          revision?: number
          state?: { revision: number; lastGoodRevision: number }
        }
        if (changed === 'plugin') stored.revision = 2
        else {
          stored.state!.revision = 2
          stored.state!.lastGoodRevision = 2
        }
        await writeFile(file, JSON.stringify(stored))
        const result = await f.call({ action: 'status' }) as { status: string; value?: { current?: boolean } }
        expect(result.status === 'unavailable' || result.value?.current === false).toBe(true)
      } finally {
        await f.close()
      }
    },
    30_000,
  )
}
