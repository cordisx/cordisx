import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openProductionPluginManagementComposition, runCordisXCli } from '../packages/cli/src/cli/run-command.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import type { PluginLifecycleRuntime } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { PackageLifecycleAuthority } from '../packages/cli/src/launcher/packages/authority.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async root => await rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<{ readonly homeDir: string; readonly configPath: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-production-management-'))
  roots.push(root)
  const homeDir = path.join(root, 'home')
  await runCordisXCli(['setup'], { env: { CORDISX_HOME: homeDir }, stdout: () => undefined })
  return { homeDir, configPath: path.join(homeDir, 'config.json') }
}

function runtime(): PluginLifecycleRuntime {
  return {
    stage: async () => undefined,
    commit: async () => undefined,
    abort: async () => undefined,
    reload: async () => undefined,
  }
}

describe('production plugin management composition', () => {
  it('shares the active lifecycle coordinator across renderer and RPC access', async () => {
    const { homeDir, configPath } = await fixture()
    const runtimeGeneration = 'production-generation'
    const openAuthority = vi.spyOn(PackageLifecycleAuthority, 'open')
    try {
      const coordinator = new PluginLifecycleCoordinator({
        homeDir,
        profileId: 'default',
        runtimeGeneration,
        permissionPolicies: [],
        runtime: runtime(),
      })
      const loadActive = vi.spyOn(coordinator.store, 'loadActive')
      const composition = await openProductionPluginManagementComposition({
        configPath,
        homeDir,
        appId: 'codex',
        profileId: 'default',
        runtimeGeneration,
        token: 'renderer-token',
        coordinator,
        processStartedAt: 'test-owner',
      })
      const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
      try {
        expect(composition.handler).toMatchObject({
          token: 'renderer-token',
          profileId: 'default',
          generation: runtimeGeneration,
        })
        await expect(composition.handler.service.query()).resolves.toMatchObject({
          profileId: 'default',
          runtime: { kind: 'active', runtimeGeneration },
        })
        const endpoint = await readPluginManagementRpcEndpoint(paths)
        expect(endpoint).toMatchObject({
          appId: 'codex',
          profileId: 'default',
          generation: runtimeGeneration,
        })
        await expect(requestPluginManagementRpc(paths, endpoint!, { kind: 'query' })).resolves.toMatchObject({
          runtime: { kind: 'active', runtimeGeneration },
        })
        expect(loadActive).toHaveBeenCalledTimes(2)
        expect(openAuthority).not.toHaveBeenCalled()
      } finally {
        await composition.close()
      }
      await expect(access(paths.state)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(access(paths.socket)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      openAuthority.mockRestore()
    }
  })

  it('does not publish management state during a production dry-run', async () => {
    const { homeDir, configPath } = await fixture()
    const before = await readFile(configPath, 'utf8')
    await runCordisXCli(['codex', '--dry-run', '--executable', process.execPath], {
      env: { CORDISX_HOME: homeDir },
      internalBuildRendererBundle: async () => 'production-renderer-source',
      stdout: () => undefined,
    })
    const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
    expect(await readFile(configPath, 'utf8')).toBe(before)
    await expect(access(paths.state)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(paths.socket)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('publishes the same active service to the production Host and CLI endpoint', async () => {
    const { homeDir } = await fixture()
    const paths = pluginManagementRpcPaths(homeDir, 'codex', 'default')
    await runCordisXCli(['codex', '--executable', process.execPath], {
      env: { CORDISX_HOME: homeDir },
      internalBuildRendererBundle: async () => 'production-renderer-source',
      internalSharedHomeDir: path.join(homeDir, 'shared-home'),
      internalRunInjectedHost: async input => {
        const handler = input.pluginManagement
        expect(handler).toBeDefined()
        const rendererSnapshot = await handler!.service.query()
        expect(rendererSnapshot.runtime).toEqual({
          kind: 'active',
          runtimeGeneration: handler!.generation,
        })
        const endpoint = await readPluginManagementRpcEndpoint(paths)
        expect(endpoint).toMatchObject({ generation: handler!.generation })
        await expect(requestPluginManagementRpc(paths, endpoint!, { kind: 'query' })).resolves.toMatchObject({
          runtime: { kind: 'active', runtimeGeneration: handler!.generation },
        })
      },
      stdout: () => undefined,
    })
    await expect(access(paths.state)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(access(paths.socket)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
