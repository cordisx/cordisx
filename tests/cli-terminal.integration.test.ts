import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { createNativeProviderCredentialBroker } from '../packages/cli/src/launcher/native-provider-credential-broker.js'
import { createTerminalProviderAuthority } from '../packages/cli/src/launcher/terminal-provider.js'
import type { NativeManagedGatewayConnectionSession } from '../packages/cli/src/launcher/managed-service-native-connection.js'

const roots: string[] = [], closes: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-cli-terminal-'))
  roots.push(root)
  const configPath = path.join(root, 'config.json')
  await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
  const env = { ...process.env, CORDISX_HOME: root }
  for (const key of Object.keys(env)) if (key.startsWith('CORDISX_') && key !== 'CORDISX_HOME') delete env[key]
  return { root, configPath, env, stdout: [] as string[] }
}

it('runs ordinary native Codex commands without a Host or CordisX config', async () => {
  const f = await fixture()
  const missing = path.join(f.root, 'missing-home')
  const received: string[][] = []
  await runCordisXCli(['cli', '--', '--version'], {
    env: { ...f.env, CORDISX_HOME: missing },
    internalSpawnTerminal: ((executable: string, args: string[], options: object) => {
      received.push(args)
      expect(executable).toBe('codex')
      expect(options).toMatchObject({ stdio: 'inherit', shell: false })
      return spawn(process.execPath, ['-e', 'process.exit(0)'])
    }) as typeof spawn,
  })
  expect(received).toEqual([['--version']])
  await expect(readFile(path.join(missing, 'config.json'))).rejects.toThrow()
})

it('uses the production management socket, real credential helper and original terminal spawn boundary', async () => {
  const f = await fixture()
  const dispose = vi.fn()
  const connection = (): NativeManagedGatewayConnectionSession => ({
    value: {
      service: { pluginId: 'fixture', serviceId: 'gateway', generation: 'generation-one' },
      endpoint: {
        origin: 'http://127.0.0.1:54321',
        apiPath: '/v1',
        auth: { scheme: 'bearer', token: 'TEST_HOST_PRIVATE_TOKEN' },
      },
      models: {
        generation: 'models-one',
        defaultAlias: 'one',
        aliases: [{ alias: 'one', gatewayModelId: 'model-one' }],
      },
      cleanup: { authorityId: 'fixture' },
    },
    dispose,
  })
  const credentials = createNativeProviderCredentialBroker({ resolve: connection })
  closes.push(() => credentials.close())
  const authority = createTerminalProviderAuthority({
    catalog: async () => [{
      providerId: 'fixture-provider',
      pluginId: 'fixture',
      models: [{ id: 'model-one', label: 'One', aliases: ['one'] }],
    }],
    owns: id => id === 'fixture-provider',
    resolve: connection,
    credentials,
  })
  closes.push(() => authority.close())
  const server = await openProductionPluginManagementComposition({
    homeDir: f.root,
    configPath: f.configPath,
    appId: 'codex',
    profileId: 'default',
    runtimeGeneration: 'runtime-one',
    token: 'a'.repeat(64),
    coordinator: new PluginLifecycleCoordinator({
      homeDir: f.root,
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
    terminalProvider: request => authority.request(request),
  })
  closes.push(() => server.close())
  const before = await readFile(f.configPath, 'utf8')
  const runtime = { env: f.env, stdout: (text: string) => f.stdout.push(text) }
  await runCordisXCli(['cli', '--list'], runtime)
  expect(JSON.parse(f.stdout[0]!)).toMatchObject({
    kind: 'list',
    providers: [{ providerId: 'fixture-provider', managed: true }],
  })
  expect(f.stdout.join('')).not.toContain('TEST_HOST_PRIVATE_TOKEN')
  const prompt = path.join(f.root, 'prompt.md')
  await writeFile(prompt, 'Use the requested model.')
  const seen: string[][] = []
  let helper: readonly string[] = []
  await runCordisXCli([
    'cli',
    '--service',
    'fixture-provider',
    '--model',
    'model-one',
    '--instructions-file',
    prompt,
    '--',
    'exec',
    'hello',
  ], {
    ...runtime,
    internalSpawnTerminal: ((executable: string, args: string[], options: object): ChildProcess => {
      seen.push(args)
      expect(options).toMatchObject({ stdio: 'inherit', shell: false })
      expect(JSON.stringify(args)).not.toContain('TEST_HOST_PRIVATE_TOKEN')
      const entry = args.find(arg => arg.startsWith('model_providers='))!
      const provider = (parseToml(entry) as any).model_providers['fixture-provider']
      helper = [provider.auth.command, ...provider.auth.args]
      return spawn(process.execPath, [
        '-e',
        `
        const {spawnSync}=require('node:child_process');
        const result=spawnSync(process.argv[1],JSON.parse(process.argv[2]),{encoding:'utf8'});
        process.exit(result.status===0 && result.stdout==='TEST_HOST_PRIVATE_TOKEN' ? 0 : 42);
      `,
        provider.auth.command,
        JSON.stringify(provider.auth.args),
      ])
    }) as typeof spawn,
  })
  expect(seen[0]!.slice(-2)).toEqual(['exec', 'hello'])
  expect(seen[0]).toContain(`model_instructions_file=${JSON.stringify(await realpath(prompt))}`)
  expect(await readFile(f.configPath, 'utf8')).toBe(before)
  // This launch's opaque credential handle is revoked while the Host remains usable.
  const status = await new Promise<number | null>(resolve => {
    const child = spawn(helper[0]!, helper.slice(1), { stdio: 'ignore' })
    child.once('exit', code => resolve(code))
  })
  expect(status).toBe(1)
  await runCordisXCli(['cli', '--list'], runtime)
})

it('reports unavailable live owners without spawning or fabricating an inactive runtime', async () => {
  const f = await fixture()
  const spawnTerminal = vi.fn()
  await expect(runCordisXCli(['cli', '--service', 'provider', '--model', 'model'], {
    env: f.env,
    internalSpawnTerminal: spawnTerminal as unknown as typeof spawn,
  })).rejects.toThrow('already-running')
  expect(spawnTerminal).not.toHaveBeenCalled()
})

it('releases a prepared lease after child spawn failure', async () => {
  const f = await fixture()
  const calls: string[] = []
  const server = await openProductionPluginManagementComposition({
    homeDir: f.root,
    configPath: f.configPath,
    appId: 'codex',
    profileId: 'default',
    runtimeGeneration: 'runtime-one',
    token: 'a'.repeat(64),
    coordinator: new PluginLifecycleCoordinator({
      homeDir: f.root,
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
      calls.push(request.kind)
      if (request.kind === 'prepare') {
        return {
          kind: 'prepared',
          leaseId: 'lease',
          providerId: 'fixture',
          model: 'model',
          provider: { name: 'Fixture' },
        }
      }
      return { kind: 'released' }
    },
  })
  closes.push(() => server.close())
  await expect(
    runCordisXCli(['cli', '--service', 'fixture', '--model', 'model', '--codex-executable', '/missing/codex'], {
      env: f.env,
    }),
  )
    .rejects.toThrow('Could not start')
  expect(calls).toEqual(['prepare', 'release'])
})

it('binds the terminal callback through production Host assembly without opening an App', async () => {
  const f = await fixture()
  const terminalProvider = vi.fn(async () => ({ kind: 'list' as const, providers: [] }))
  const close = vi.fn(async () => undefined)
  await runCordisXCli(['run', 'codex', 'default', '--executable', process.execPath], {
    env: f.env,
    internalNativeSubmissionPlatform: 'darwin',
    internalBuildRendererBundle: async () => 'fixture-renderer',
    internalSharedHomeDir: path.join(f.root, 'shared-host-home'),
    internalCreateNativeSubmissionComposition: async () => ({
      installation: { authority: {} as any, transforms: [] },
      environment: {},
      terminalProvider,
      close,
    }),
    internalRunInjectedHost: async () => {
      await runCordisXCli(['cli', '--list'], { env: f.env, stdout: text => f.stdout.push(text) })
      expect(JSON.parse(f.stdout[0]!)).toEqual({ kind: 'list', providers: [] })
      expect(terminalProvider).toHaveBeenCalledWith({ kind: 'list' })
    },
  })
  expect(close).toHaveBeenCalledOnce()
})

it('passes the original child exit code through the compiled CLI process', async () => {
  const f = await fixture()
  const executable = path.join(f.root, 'codex-fixture')
  await writeFile(executable, '#!/bin/sh\nexit 7\n', { mode: 0o700 })
  const child = spawn(process.execPath, [
    path.resolve('packages/cli/dist/src/cli.js'),
    'cli',
    '--codex-executable',
    executable,
  ], {
    env: f.env,
    stdio: 'ignore',
  })
  const code = await new Promise(resolve => child.once('exit', resolve))
  expect(code).toBe(7)
})
