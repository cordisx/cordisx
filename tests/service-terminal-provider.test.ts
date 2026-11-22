import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { createServiceTerminalProvider } from '../packages/cli/src/launcher/service-terminal-provider.js'
import type { ManagedServiceNativeActivation } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'

function activation(auth: { scheme: 'none' } | { scheme: 'bearer'; token: string } = { scheme: 'none' }) {
  const dispose = vi.fn()
  const authority = {
    hasProvider: () => false,
    providerReference: () => undefined,
    targets: () => [],
  }
  const connection = () => ({
    value: {
      service: { pluginId: 'fixture', serviceId: 'gateway', generation: 'generation-one' },
      endpoint: { origin: 'http://127.0.0.1:54321', apiPath: '/v1' as const, auth },
      models: {
        generation: 'models-one',
        defaultAlias: 'one',
        aliases: [{ alias: 'one', gatewayModelId: 'model-one' }],
      },
      cleanup: { authorityId: 'fixture' },
    },
    dispose,
  })
  return {
    dispose,
    value: {
      startup: authority,
      startupObserver: { read: async () => ({ entries: [] }) },
      revision: 1,
      nativeProviderIds: ['fixture-provider'],
      prepareNativeConnection: connection,
      subscribeNativeProviders: () => () => {},
    } as unknown as ManagedServiceNativeActivation,
  }
}

describe('headless service terminal provider authority', () => {
  it('gives simultaneous clients independent bounded leases and revokes them on close', async () => {
    const f = activation()
    const terminal = createServiceTerminalProvider({ activation: f.value })
    const selection = { providerId: 'fixture-provider', model: 'model-one' }
    try {
      const [codex, claude] = await Promise.all([
        terminal.request({ kind: 'prepare', ...selection }),
        terminal.request({ kind: 'prepare', ...selection, client: 'claude-code' }),
      ])
      if (codex.kind !== 'prepared' || claude.kind !== 'prepared') throw new Error('provider was not prepared')
      expect(codex.leaseId).not.toBe(claude.leaseId)
      expect(claude.anthropicBaseUrl).toBe('http://127.0.0.1:54321')
      await terminal.request({ kind: 'release', leaseId: codex.leaseId })
      expect(await terminal.request({ kind: 'renew', leaseId: claude.leaseId })).toEqual({ kind: 'renewed' })
      await terminal.close()
      await expect(terminal.request({ kind: 'renew', leaseId: claude.leaseId })).rejects.toThrow('retired')
    } finally {
      await terminal.close()
    }
    expect(f.dispose).toHaveBeenCalled()
  })

  it('gives Claude a revocable command lease without returning the upstream bearer', async () => {
    const f = activation({ scheme: 'bearer', token: 'PRIVATE_FIXTURE_SECRET' })
    const terminal = createServiceTerminalProvider({ activation: f.value })
    try {
      const claude = await terminal.request({
        kind: 'prepare',
        providerId: 'fixture-provider',
        model: 'model-one',
        client: 'claude-code',
      })
      expect(claude).toMatchObject({ kind: 'prepared', anthropicBaseUrl: 'http://127.0.0.1:54321' })
      expect(JSON.stringify(claude)).not.toContain('PRIVATE_FIXTURE_SECRET')
      const codex = await terminal.request({ kind: 'prepare', providerId: 'fixture-provider', model: 'model-one' })
      expect(JSON.stringify(codex)).not.toContain('PRIVATE_FIXTURE_SECRET')
    } finally {
      await terminal.close()
    }
  })

  it.each(['app', 'service', 'future-service', 'future-isolated'] as const)(
    'connects both CLI clients to one %s owner without replacing it',
    async mode => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cx-multi-client-'))
      const configPath = path.join(root, 'config.json')
      const defaults = createDefaultHomeConfig()
      const ownerApp = mode.startsWith('future') ? 'future-adapter' : 'codex'
      const codexApp = mode === 'future-isolated'
        ? {
          ...defaults.apps.codex!,
          profiles: { default: { displayName: 'Default', dataMode: 'host-isolated' } },
        }
        : defaults.apps.codex
      await writeFile(
        configPath,
        JSON.stringify({
          ...defaults,
          apps: { ...defaults.apps, codex: codexApp, 'future-adapter': defaults.apps.codex },
        }),
        { mode: 0o600 },
      )
      const f = activation()
      const terminal = createServiceTerminalProvider({ activation: f.value })
      const leaseIds: string[] = []
      const manager = await openProductionPluginManagementComposition({
        homeDir: root,
        configPath,
        appId: ownerApp,
        profileId: 'default',
        runtimeGeneration: 'runtime-one',
        token: 'a'.repeat(64),
        ...(mode === 'app' ? {} : { mode: 'service' as const }),
        coordinator: new PluginLifecycleCoordinator({
          homeDir: root,
          profileId: 'default',
          runtimeGeneration: 'runtime-one',
          permissionPolicies: [],
          runtime: {
            stage: async () => undefined,
            commit: async () => undefined,
            abort: async () => undefined,
            reload: async () => undefined,
          },
        }),
        terminalProvider: async request => {
          const result = await terminal.request(request)
          if (result.kind === 'prepared') leaseIds.push(result.leaseId)
          return result
        },
      })
      const children: EventEmitter[] = []
      const spawnTerminal = vi.fn((executable: string, _args: string[], options: { env: NodeJS.ProcessEnv }) => {
        expect(JSON.stringify(options.env)).not.toContain('PRIVATE_FIXTURE_SECRET')
        if (mode === 'future-isolated' && executable === 'codex') {
          expect(options.env.CODEX_HOME).toBe(path.join(root, 'apps', 'codex', 'profiles', 'default', 'codex-home'))
        }
        const child = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn() })
        children.push(child)
        return child as unknown as ChildProcess
      })
      const runtime = {
        env: { ...process.env, CORDISX_HOME: root },
        internalCheckTerminalClient: async (executable: string) => executable,
        internalSpawnTerminal: spawnTerminal as never,
      }
      try {
        const first = runCordisXCli([
          'start',
          '--mode',
          'cli',
          'codex',
          '-s',
          'fixture-provider',
          '-m',
          'model-one',
          '--',
          '--version',
        ], runtime)
        const second = runCordisXCli([
          'start',
          '--mode',
          'cli',
          'claude-code',
          '--owner-app',
          ownerApp,
          '-s',
          'fixture-provider',
          '-m',
          'model-one',
          '--',
          '--version',
        ], runtime)
        await vi.waitFor(() => expect(children).toHaveLength(2))
        if (mode === 'future-service') {
          await expect(runCordisXCli([
            'start',
            '--mode',
            'cli',
            'claude-code',
            '--owner-app',
            'codex',
            '-s',
            'fixture-provider',
            '-m',
            'model-one',
          ], runtime)).rejects.toThrow('No verified CordisX owner matches')
          await expect(runCordisXCli([
            'start',
            '--mode',
            'cli',
            'claude-code',
            '--profile',
            'other',
            '-s',
            'fixture-provider',
            '-m',
            'model-one',
          ], runtime)).rejects.toThrow('Existing CordisX profile required')
          expect(children).toHaveLength(2)
        }
        expect(new Set(leaseIds).size).toBe(2)
        children[0]!.emit('exit', 0, null)
        await vi.waitFor(async () => {
          const results = await Promise.allSettled(
            leaseIds.map(leaseId => terminal.request({ kind: 'renew', leaseId })),
          )
          expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
        })
        children[1]!.emit('exit', 0, null)
        await Promise.all([first, second])
      } finally {
        for (const child of children) child.emit('exit', 0, null)
        await manager.close()
        await terminal.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
