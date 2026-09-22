import { access, chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { ManagedServiceSourceV1 } from '@cordisx/protocol/managed-service/v1'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import type { NativeSubmissionComposition } from '../packages/cli/src/launcher/native-submission-composition.js'
import type { ManagedServiceNodeActivation } from '../packages/cli/src/launcher/managed-service-node-host.js'
import { nativeSubmissionTransformsForApp } from '../packages/cli/src/launcher/native-submission-composition.js'
import { resources } from './fixtures/native-submission-structure.js'
import { createBuiltinSkillsFixture } from './helpers/cli-run-fixtures.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'

const temporary = new Set<string>()

afterEach(async () => {
  await Promise.all([...temporary].map(root => rm(root, { recursive: true, force: true })))
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
          },
        )
      } else expect(create.mock.calls[0]).toHaveLength(3)
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
      scope: { profileId: 'development', generation: 'managed-runtime' },
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
          profileId: 'development',
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
      internalSharedHomeDir: path.join(f.root, 'shared-home'),
      stdout: () => undefined,
    })

    expect(createActivation).toHaveBeenCalledWith({
      homeConfigPath: path.join(f.home, 'config.json'),
      homeDir: f.home,
      environment: { CORDISX_HOME: f.home },
    })
    expect(createNativeSubmission).toHaveBeenCalledWith(
      activation,
      f.executable,
      path.join(os.homedir(), '.codex'),
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
