import { createHash } from 'node:crypto'
import { access, chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service/v1'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import type { NativeSubmissionComposition } from '../packages/cli/src/launcher/native-submission-composition.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import { nativeSubmissionTransformsForApp } from '../packages/cli/src/launcher/native-submission-composition.js'
import { resources } from './fixtures/native-submission-structure.js'
import { createBuiltinSkillsFixture } from './helpers/cli-run-fixtures.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { LauncherMarketplaceCertifiedAuthority } from '../packages/cli/src/launcher/marketplace-certified-authority.js'
import { PluginActivationStore } from '../packages/cli/src/launcher/plugin-activation.js'
import { stagePluginPackageSourceV1 } from '../packages/cli/src/launcher/packages/index.js'
import { PLUGIN_PACKAGE_SCHEMA_V11 } from '../packages/cli/src/launcher/packages/manifest.js'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V11, normalizeUsageManifestV11 } from '../packages/cli/src/usage-permissions.js'
import { CORDISX_CAPABILITY_CATALOG_VERSION } from '../packages/cli/src/capability-risk-catalog.js'
import { CORDISX_PERMISSION_POLICY_SCHEMA_V3 } from '../packages/cli/src/permission-contracts.js'
import { domPermissionAuthorizationKeyV3 } from '../packages/cli/src/permission-model-v3.js'

const temporary = new Set<string>()

afterEach(async () => {
  vi.restoreAllMocks()
  const makeWritable = async (target: string): Promise<void> => {
    await chmod(target, 0o700).catch(() => undefined)
    const entries = await readdir(target, { withFileTypes: true }).catch(() => [])
    await Promise.all(
      entries.filter(entry => entry.isDirectory()).map(entry => makeWritable(path.join(target, entry.name))),
    )
  }
  await Promise.all([...temporary].map(async root => {
    await makeWritable(root)
    await rm(root, { recursive: true, force: true })
  }))
  temporary.clear()
})

async function fixture(name: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), name))
  temporary.add(root)
  const project = path.join(root, 'project')
  const entry = path.join(project, 'demo.ts')
  const executable = path.join(root, 'host')
  await mkdir(project, { recursive: true })
  await writeFile(path.join(project, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0' }))
  await writeFile(entry, "export default { name: 'demo', apply() {} }\n")
  await writeFile(executable, '#!/usr/bin/env node\nprocess.exit(0)\n')
  await chmod(executable, 0o755)
  return { root, project, entry, executable, home: path.join(root, 'home') }
}

async function stageInstalledRendererPlugin(
  homeDir: string,
  root: string,
  id: 'aiden' | 'traex',
  version: string,
) {
  const source = path.join(root, id)
  await mkdir(source, { recursive: true })
  await writeFile(path.join(source, 'index.js'), 'export function apply() {}\n')
  const runtime = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
    schemaVersion: 11 as const,
    id,
    services: [],
    capabilities: [{
      name: 'ui.extension-points.render' as const,
      required: false,
      scope: { extensionPoints: ['manager.settings.navigation-items', 'manager.content'] },
    }],
  }
  const runtimeText = `${JSON.stringify(runtime, null, 2)}\n`
  await writeFile(path.join(source, 'runtime.json'), runtimeText)
  await writeFile(
    path.join(source, 'cordisx-package.json'),
    `${
      JSON.stringify(
        {
          $schema: PLUGIN_PACKAGE_SCHEMA_V11,
          schemaVersion: 11,
          id,
          version,
          entry: './index.js',
          canonicalSource: 'https://code.byted.org/fe/cordisx-plugins',
          distribution: { mode: 'explicit-local-v1', signature: 'unsupported' },
          compatibility: { runtimeAbi: 1, protocolSchemas: [CORDISX_PLUGIN_MANIFEST_SCHEMA_V11] },
          dependencies: [],
          runtimeManifest: {
            path: './runtime.json',
            schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V11,
            digest: `sha256:${createHash('sha256').update(runtimeText).digest('hex')}`,
          },
        },
        null,
        2,
      )
    }\n`,
  )
  return await stagePluginPackageSourceV1({ kind: 'local-directory', location: pathToFileURL(source).href }, {
    homeDir,
    runtimeValidators: {
      [CORDISX_PLUGIN_MANIFEST_SCHEMA_V11]: value => normalizeUsageManifestV11(value, id),
    },
  })
}

describe('Vite development native submission assembly', () => {
  it.each(['codex', 'dev'])(
    'reports incompatible resources without publishing native submission on %s',
    async command => {
      const f = await fixture('cordisx-incompatible-native-')
      const config = createDefaultHomeConfig()
      await mkdir(f.home, { mode: 0o700 })
      await writeFile(
        path.join(f.home, 'config.json'),
        JSON.stringify({
          ...config,
          apps: {
            codex: {
              defaultProfile: 'default',
              profiles: {
                default: {
                  displayName: 'Default',
                  dataMode: 'shared',
                  configModelCatalogs: { fixture: 'scoped.json' },
                  dynamicModelCatalog: true,
                },
                other: { displayName: 'Other', dataMode: 'shared', configModelCatalogs: { fixture: 'other.json' } },
              },
            },
          },
        }),
      )
      const sourceRoot = await createBuiltinSkillsFixture(f.root)
      const activation = {
        nativeProviderIds: [],
        dispose: vi.fn(async () => {}),
      } as unknown as ManagedServiceNodeActivation
      const create = vi.fn(async () => {
        throw new Error('Native capability submit-options: expected one structure, found 0')
      })
      const runHost = vi.fn(async () => {})
      const output: string[] = []
      await runCordisXCli([command, ...(command === 'dev' ? [f.entry] : []), '--executable', f.executable], {
        cwd: f.project,
        env: { CORDISX_HOME: f.home },
        stdout: line => output.push(line),
        internalRunInjectedHost: runHost,
        internalCreateNativeSubmissionComposition: create,
        internalCreateDevelopmentManagedServiceActivation: async () => activation,
        internalNativeSubmissionPlatform: 'darwin',
        internalBuiltinSkillsSourceRootDir: sourceRoot,
        internalSharedHomeDir: path.join(f.root, 'shared-home'),
      })
      expect(create).toHaveBeenCalledOnce()
      if (command === 'codex') {
        expect(create).toHaveBeenCalledWith(
          expect.anything(),
          f.executable,
          expect.any(String),
          {
            configModelCatalogs: { fixture: 'scoped.json' },
            dynamicModelCatalog: true,
            managedCatalog: { homeDir: f.home, profileId: 'default' },
            nativeDiscoveryEnvironment: { CORDISX_HOME: f.home },
          },
        )
      } else {
        expect(create).toHaveBeenCalledWith(
          expect.anything(),
          f.executable,
          expect.any(String),
          {
            configModelCatalogs: { fixture: 'scoped.json' },
            dynamicModelCatalog: true,
            managedCatalog: {
              homeDir: f.home,
              profileId: 'default',
            },
            nativeDiscoveryEnvironment: { CORDISX_HOME: f.home },
          },
        )
      }
      expect(runHost).toHaveBeenCalledWith(expect.not.objectContaining({ nativeSubmission: expect.anything() }))
      expect(output.join('\n')).toContain('submit-options')
      if (command === 'dev') expect(activation.dispose).toHaveBeenCalledOnce()
    },
  )
  it('passes the native installation and control environment to the development Host', async () => {
    const f = await fixture('cordisx-dev-native-submission-')
    const binding = {
      bindingId: 'binding-aiden',
      identity: { source: 'https://plugins.example/aiden' as const, pluginId: 'demo', serviceId: 'gateway' },
      scope: { profileId: 'default', generation: 'managed-runtime' },
    }
    const source = {
      binding,
      snapshot: vi.fn(async () => ({ status: 'available', projection: { binding, auth: { state: 'authenticated' } } })),
      subscribe: vi.fn(),
      authenticate: vi.fn(),
      logout: vi.fn(),
    } as unknown as ManagedServiceSourceV1
    const activation = {
      hostGeneration: 'managed-runtime',
      authorities: [],
      sources: [{
        pluginId: 'demo',
        pluginGeneration: 'installed-generation',
        serviceId: 'gateway',
        source,
      }],
      nativeProviderIds: ['aiden'],
      prepareNativeConnection: vi.fn(),
      dispose: vi.fn(async () => undefined),
    } as unknown as ManagedServiceNodeActivation
    const installation = {
      authority: {},
      transforms: nativeSubmissionTransformsForApp('future', 'unknown', resources()),
    } as unknown as NativeSubmissionComposition['installation']
    const nativeSubmission = {
      installation,
      environment: {
        CODEX_CLI_PATH: '/private/native-intermediary.mjs',
        CORDISX_NATIVE_CONTROL_SOCKET: '/private/native-control.sock',
      },
      close: vi.fn(async () => undefined),
    } satisfies NativeSubmissionComposition
    let capabilities: { pluginId: string; pluginGeneration: string; token: string }[] = []
    const runHost = vi.fn(async input => {
      const manifestUrl = /fetch\("([^"]+host-manifest\.json)"\)/u.exec(String(input.source))?.[1]
      expect(manifestUrl).toBeDefined()
      const manifest = await fetch(manifestUrl!).then(response => response.json()) as { entry: string }
      const bootSource = await fetch(manifest.entry).then(response => response.text())
      const entryUrl = /"(http:\/\/[^"\s]*virtual:cordisx-native-entry[^"\s]*)"/u.exec(bootSource)?.[1]
      expect(entryUrl).toBeDefined()
      const entrySource = await fetch(entryUrl!).then(response => response.text())
      const capabilitySource = /managedServiceCapabilities:\s*(\[[^\]]*\])/u.exec(entrySource)?.[1]
      expect(capabilitySource).toBeDefined()
      capabilities = JSON.parse(capabilitySource!) as typeof capabilities
      await expect(input.managedServiceUI!.handleBindingValue(JSON.stringify({
        version: 1,
        token: capabilities[0]!.token,
        requestId: 'get-aiden',
        operation: 'get',
        scope: {
          profileId: 'default',
          runtimeGeneration: 'managed-runtime',
          pluginGeneration: capabilities[0]!.pluginGeneration,
        },
        serviceId: 'gateway',
      }))).resolves.toMatchObject({ ok: true, value: { status: 'available' } })
    })
    const createActivation = vi.fn(async () => activation)
    const createNativeSubmission = vi.fn(async () => nativeSubmission)

    await runCordisXCli(['dev', f.entry, '--executable', f.executable], {
      cwd: f.project,
      env: { CORDISX_HOME: f.home },
      internalRunInjectedHost: runHost,
      internalCreateDevelopmentManagedServiceActivation: createActivation,
      internalCreateNativeSubmissionComposition: createNativeSubmission,
      internalNativeSubmissionPlatform: 'darwin',
      internalNativeSubmissionLegacyLockRecovery: { exitedPid: 1234, inode: 5678 },
      internalSharedHomeDir: path.join(f.root, 'shared-home'),
      stdout: () => undefined,
    })

    expect(createActivation).toHaveBeenCalledWith({
      homeConfigPath: path.join(f.home, 'config.json'),
      homeDir: f.home,
      environment: { CORDISX_HOME: f.home },
      profileId: 'default',
      runtimeGeneration: expect.any(String),
    })
    expect(createNativeSubmission).toHaveBeenCalledWith(
      activation,
      f.executable,
      path.join(os.homedir(), '.codex'),
      {
        managedCatalog: {
          homeDir: f.home,
          profileId: 'default',
          recoverLegacyLock: { exitedPid: 1234, inode: 5678 },
        },
        nativeDiscoveryEnvironment: { CORDISX_HOME: f.home },
      },
    )
    await expect(access(path.join(f.home, 'config.json'))).resolves.toBeUndefined()
    expect(runHost).toHaveBeenCalledWith(expect.objectContaining({
      nativeSubmission: installation,
      managedServiceUI: expect.objectContaining({ handleBindingValue: expect.any(Function) }),
      viteDevelopment: true,
      environment: expect.objectContaining({
        CORDISX_DEV_ENTRY: f.entry,
        CORDISX_DEV_MODE: 'explicit-entry',
        CODEX_CLI_PATH: '/private/native-intermediary.mjs',
        CORDISX_NATIVE_CONTROL_SOCKET: '/private/native-control.sock',
      }),
    }))
    expect(capabilities).toEqual([expect.objectContaining({
      pluginId: 'demo',
      pluginGeneration: expect.stringMatching(/^vite-/u),
      token: expect.any(String),
    })])
    expect(nativeSubmission.close).toHaveBeenCalledTimes(1)
    expect(activation.dispose).toHaveBeenCalledTimes(1)
  })

  it('hands native-profile permissions and exact Certified package identities to the Vite Host', async () => {
    const f = await fixture('cordisx-dev-native-permission-')
    const [aiden, traex] = await Promise.all([
      stageInstalledRendererPlugin(f.home, f.root, 'aiden', '0.1.2'),
      stageInstalledRendererPlugin(f.home, f.root, 'traex', '0.1.5'),
    ])
    const home = {
      ...createDefaultHomeConfig(),
      marketplaceSources: [],
      permissions: [{
        $schema: CORDISX_PERMISSION_POLICY_SCHEMA_V3,
        schemaVersion: 3 as const,
        key: domPermissionAuthorizationKeyV3({
          profileId: 'default',
          identity: { source: 'https://code.byted.org/fe/cordisx-plugins', pluginId: 'aiden' },
          pointId: 'manager.content',
          catalogVersion: CORDISX_CAPABILITY_CATALOG_VERSION,
        }),
        policy: 'deny-persistent' as const,
      }],
    }
    await mkdir(f.home, { recursive: true, mode: 0o700 })
    await writeFile(path.join(f.home, 'config.json'), JSON.stringify(home))
    const store = new PluginActivationStore(f.home, 'default', 'stored-generation')
    await store.writeCandidate({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-activation.v1.schema.json',
      schemaVersion: 1,
      recordKind: 'candidate',
      transactionId: 'installed-permissions',
      profileId: 'default',
      revision: 1,
      lastGoodRevision: 0,
      runtimeGeneration: 'stored-generation',
      plugins: [
        {
          id: 'aiden',
          version: '0.1.2',
          digest: aiden.digest,
          moduleGeneration: 'aiden-installed',
          enabled: true,
          dependencies: [],
          canonicalSource: 'https://code.byted.org/fe/cordisx-plugins',
        },
        {
          id: 'traex',
          version: '0.1.5',
          digest: traex.digest,
          moduleGeneration: 'traex-installed',
          enabled: true,
          dependencies: [],
          canonicalSource: 'https://code.byted.org/fe/cordisx-plugins',
        },
      ],
    })
    await store.commitCandidate('installed-permissions')
    const authority = {
      snapshot: vi.fn(() => ({ revision: 1, projections: [] })),
      subscribe: vi.fn(() => () => undefined),
      dispose: vi.fn(async () => undefined),
    } as unknown as LauncherMarketplaceCertifiedAuthority
    vi.spyOn(LauncherMarketplaceCertifiedAuthority, 'open').mockResolvedValue(authority)
    const runHost = vi.fn(async input => {
      expect(input.newDocumentSource).toEqual(expect.any(String))
      expect(input.permissionPersistence).toMatchObject({ profileId: 'default', identities: expect.any(Array) })
      expect(input.permissionPersistence!.identities).toEqual(expect.arrayContaining([
        { source: 'https://code.byted.org/fe/cordisx-plugins', id: 'aiden' },
        { source: 'https://code.byted.org/fe/cordisx-plugins', id: 'traex' },
      ]))
      expect(input.certifiedPermission).toMatchObject({
        authority,
        profileId: 'default',
        runtimeGeneration: expect.any(String),
        token: expect.any(String),
      })
      const owner = input.ownerDocuments!.issue(
        { source: 'https://code.byted.org/fe/cordisx-plugins', pluginId: 'aiden' },
        'aiden-installed',
      )
      await expect(input.ownerDocuments!.load({
        version: 1,
        requestId: 'native-profile-owner-load',
        token: owner.token,
        operation: 'load',
        documentId: 'fixture',
      })).resolves.toEqual({ status: 'missing', revision: 0 })
      const manifestUrl = /fetch\("([^"]+host-manifest\.json)"\)/u.exec(String(input.source))?.[1]
      expect(manifestUrl).toBeDefined()
      const manifest = await fetch(manifestUrl!).then(response => response.json()) as { entry: string }
      const bootSource = await fetch(manifest.entry).then(response => response.text())
      const entryUrl = /"(http:\/\/[^"\s]*virtual:cordisx-native-entry[^"\s]*)"/u.exec(bootSource)?.[1]
      expect(entryUrl).toBeDefined()
      const entrySource = await fetch(entryUrl!).then(response => response.text())
      expect(entrySource).toContain('"profileId":"default"')
      expect(entrySource).toContain('"capability":"ui.extension-points.render"')
      expect(entrySource).toContain('"policy":"deny-persistent"')
      expect(entrySource).toContain('"origin":"local-dev"')
    })

    await runCordisXCli(['dev', f.entry], {
      cwd: f.project,
      env: { CORDISX_HOME: f.home },
      internalRunInjectedHost: runHost,
      internalNativeSubmissionPlatform: 'linux',
      internalSharedHomeDir: path.join(f.root, 'shared-home'),
      stdout: () => undefined,
    })

    expect(LauncherMarketplaceCertifiedAuthority.open).toHaveBeenCalledWith({
      homeDir: f.home,
      configPath: path.join(f.home, 'config.json'),
      profileId: 'default',
    })
    expect(authority.dispose).toHaveBeenCalledOnce()
  }, 30_000)

  it('does not create native submission after the explicit opt-out', async () => {
    const f = await fixture('cordisx-dev-native-opt-out-')
    const runHost = vi.fn(async () => undefined)
    const createActivation = vi.fn()
    const createNativeSubmission = vi.fn()

    await runCordisXCli(['dev', f.entry, '--executable', f.executable], {
      cwd: f.project,
      env: { CORDISX_HOME: f.home, CORDISX_EXPERIMENTAL_NATIVE_SUBMISSION: '0' },
      internalRunInjectedHost: runHost,
      internalCreateDevelopmentManagedServiceActivation: createActivation,
      internalCreateNativeSubmissionComposition: createNativeSubmission,
      internalNativeSubmissionPlatform: 'darwin',
      internalSharedHomeDir: path.join(f.root, 'shared-home'),
      stdout: () => undefined,
    })

    expect(createActivation).not.toHaveBeenCalled()
    expect(createNativeSubmission).not.toHaveBeenCalled()
    await expect(access(path.join(f.home, 'config.json'))).resolves.toBeUndefined()
    expect(runHost).toHaveBeenCalledWith(expect.not.objectContaining({ nativeSubmission: expect.anything() }))
  })

  it('passes structurally selected resources through the production launch path and closes the composition', async () => {
    const f = await fixture('cordisx-production-native-')
    const sourceRoot = await createBuiltinSkillsFixture(f.root)
    const installation = {
      authority: {},
      transforms: nativeSubmissionTransformsForApp('future', 'unknown', resources()),
    } as unknown as NativeSubmissionComposition['installation']
    const composition = {
      installation,
      environment: { CODEX_CLI_PATH: '/test/intermediary' },
      close: vi.fn(async () => {}),
    }
    const create = vi.fn(async () => composition)
    const runHost = vi.fn(async () => {})
    await runCordisXCli(['codex', '--executable', f.executable], {
      cwd: f.project,
      env: { CORDISX_HOME: f.home },
      stdout: () => {},
      internalRunInjectedHost: runHost,
      internalCreateNativeSubmissionComposition: create,
      internalNativeSubmissionPlatform: 'darwin',
      internalBuiltinSkillsSourceRootDir: sourceRoot,
      internalSharedHomeDir: path.join(f.root, 'shared-home'),
    })
    expect(create).toHaveBeenCalledOnce()
    expect(runHost).toHaveBeenCalledWith(
      expect.objectContaining({
        nativeSubmission: installation,
        environment: expect.objectContaining({ CODEX_CLI_PATH: '/test/intermediary' }),
      }),
    )
    expect(composition.close).toHaveBeenCalledOnce()
  })
})
