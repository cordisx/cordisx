import { type ChildProcess, spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import {
  createNativeProviderCredentialBroker,
  nativeProviderCredentialHelperPath,
} from '../packages/cli/src/launcher/native-provider-credential-broker.js'
import { createTerminalProviderAuthority } from '../packages/cli/src/launcher/terminal-provider.js'
import type { NativeManagedGatewayConnectionSession } from '../packages/cli/src/launcher/managed-service-native-connection.js'

const roots: string[] = [], closes: (() => void | Promise<void>)[] = []
const checkClient = async (executable: string) => executable
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
    internalCheckTerminalClient: checkClient,
    env: {
      ...f.env,
      CORDISX_HOME: missing,
      CORDISX_NATIVE_CONTROL_NONCE: 'old-app',
      CORDISX_SUPERVISOR_HOME: '/old-app',
      CODEX_THREAD_ID: 'old-thread',
      CODEX_CLI_PATH: '/old-intermediary',
    },
    internalSpawnTerminal: ((executable: string, args: string[], options: object) => {
      received.push(args)
      expect(executable).toBe('codex')
      expect(options).toMatchObject({ stdio: 'inherit', shell: false })
      for (
        const key of ['CORDISX_NATIVE_CONTROL_NONCE', 'CORDISX_SUPERVISOR_HOME', 'CODEX_THREAD_ID', 'CODEX_CLI_PATH']
      ) {
        expect((options as any).env).not.toHaveProperty(key)
      }
      return spawn(process.execPath, ['-e', 'process.exit(0)'])
    }) as typeof spawn,
  })
  expect(received).toEqual([['--version']])
  await expect(readFile(path.join(missing, 'config.json'))).rejects.toThrow()
})

it.each(['codex', 'claude-code'] as const)(
  'starts %s from a shared declaration without an App or global config write',
  async client => {
    const f = await fixture()
    const config = {
      ...createDefaultHomeConfig(),
      providers: [{
        id: 'shared',
        kind: 'model-service',
        displayName: 'Shared',
        baseUrl: 'https://example.com/v1',
        apiKeyEnv: 'SHARED_KEY',
        protocols: ['openai-responses', 'anthropic-messages'],
        models: { codex: ['model-one'], claude: ['model-one'] },
      }],
      environmentVariables: [{ name: 'SHARED_KEY', value: 'TEST_PRIVATE_KEY', enabled: true }],
    }
    await writeFile(f.configPath, JSON.stringify(config))
    const before = await readFile(f.configPath, 'utf8')
    let called = false
    await runCordisXCli(['start', '--mode', 'cli', client, '-s', 'shared', '-m', 'model-one', '--', '--version'], {
      internalCheckTerminalClient: checkClient,
      env: f.env,
      internalSpawnTerminal: ((executable: string, args: string[], options: any) => {
        called = true
        expect(executable).toBe(client === 'codex' ? 'codex' : 'claude')
        expect(options.env.SHARED_KEY).toBe('TEST_PRIVATE_KEY')
        expect(args.join(' ')).not.toContain('TEST_PRIVATE_KEY')
        if (client === 'claude-code') {
          expect(options.env.CORDISX_TERMINAL_SERVICE_KEY).toBe('TEST_PRIVATE_KEY')
          expect(options.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined()
          expect(options.env.ANTHROPIC_BASE_URL).toBe('https://example.com/v1')
          expect(args.slice(0, 3)).toEqual(['--model', 'model-one', '--version'])
          const settings = JSON.parse(args[args.indexOf('--settings') + 1]!)
          expect(settings.env.ANTHROPIC_BASE_URL).toBe('https://example.com/v1')
          expect(settings.apiKeyHelper).toContain('terminal-claude-key.mjs')
        } else expect(args).toContain('model_provider="shared"')
        return spawn(process.execPath, ['-e', 'process.exit(0)'])
      }) as typeof spawn,
    })
    expect(called).toBe(true)
    expect(await readFile(f.configPath, 'utf8')).toBe(before)
    await expect(runCordisXCli(['start', '--mode', 'cli', client, '-s', 'shared', '-m', 'missing'], {
      env: f.env,
      internalCheckTerminalClient: checkClient,
    }))
      .rejects.toThrow('catalog')
    await runCordisXCli(['start', '--mode', 'cli', client, '--list'], {
      env: f.env,
      stdout: line => f.stdout.push(line),
    })
    expect(JSON.parse(f.stdout[0]!)).toMatchObject({
      complete: false,
      providers: [{ providerId: 'shared', managed: false }],
    })
    expect(f.stdout.join('')).not.toContain('TEST_PRIVATE_KEY')
  },
)

it('rejects unsupported Claude protocol before child spawn', async () => {
  const f = await fixture()
  await writeFile(
    f.configPath,
    JSON.stringify({
      ...createDefaultHomeConfig(),
      providers: [{
        id: 'responses',
        kind: 'model-service',
        displayName: 'Responses',
        baseUrl: 'https://example.com',
        apiKeyEnv: 'KEY',
        protocols: ['openai-responses'],
        models: { codex: ['model'] },
      }],
    }),
  )
  const spawnTerminal = vi.fn()
  await expect(runCordisXCli(['start', '--mode', 'cli', 'claude-code', '-s', 'responses', '-m', 'model'], {
    internalCheckTerminalClient: checkClient,
    env: f.env,
    internalSpawnTerminal: spawnTerminal as unknown as typeof spawn,
  })).rejects.toThrow('anthropic-messages')
  expect(spawnTerminal).not.toHaveBeenCalled()
})

it('leaves foreground Ctrl-C semantics to the original Codex CLI', async () => {
  const f = await fixture()
  const child = Object.assign(new EventEmitter(), { exitCode: null, kill: vi.fn() })
  const run = runCordisXCli(['cli'], {
    internalCheckTerminalClient: checkClient,
    env: f.env,
    internalSpawnTerminal: (() => {
      setImmediate(() => {
        process.emit('SIGINT')
        child.emit('exit', 0, null)
      })
      return child
    }) as unknown as typeof spawn,
  })
  await run
  expect(child.kill).not.toHaveBeenCalled()
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
  const helperPath = path.join(f.root, "credential helper's fixture.mjs")
  await symlink(nativeProviderCredentialHelperPath(), helperPath)
  const credentials = createNativeProviderCredentialBroker({ resolve: connection, helperPath })
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
    internalCheckTerminalClient: checkClient,
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
  let claudeHelper = ''
  await runCordisXCli([
    'start',
    '--mode',
    'cli',
    'claude-code',
    '--service',
    'fixture-provider',
    '--model',
    'model-one',
    '--',
    '--version',
  ], {
    ...runtime,
    internalCheckTerminalClient: checkClient,
    internalSpawnTerminal: ((executable: string, args: string[], options: { env: NodeJS.ProcessEnv }): ChildProcess => {
      expect(executable).toBe('claude')
      expect(JSON.stringify(args)).not.toContain('TEST_HOST_PRIVATE_TOKEN')
      expect(JSON.stringify(options.env)).not.toContain('TEST_HOST_PRIVATE_TOKEN')
      expect(options.env.CORDISX_TERMINAL_SERVICE_KEY).toBeUndefined()
      const settings = JSON.parse(args[args.indexOf('--settings') + 1]!) as { apiKeyHelper: string }
      claudeHelper = settings.apiKeyHelper
      return spawn(process.execPath, [
        '-e',
        "const {spawnSync}=require('node:child_process');"
        + "const result=spawnSync('/bin/sh',['-c',process.argv[1]],{encoding:'utf8'});"
        + "process.exit(result.status===0 && result.stdout==='TEST_HOST_PRIVATE_TOKEN' ? 0 : 42);",
        claudeHelper,
      ])
    }) as typeof spawn,
  })
  const claudeStatus = await new Promise<number | null>(resolve => {
    const child = spawn('/bin/sh', ['-c', claudeHelper], { stdio: 'ignore' })
    child.once('exit', code => resolve(code))
  })
  expect(claudeStatus).toBe(1)
  await runCordisXCli(['cli', '--list'], runtime)
})

it('reports unavailable live owners without spawning or fabricating an inactive runtime', async () => {
  const f = await fixture()
  const spawnTerminal = vi.fn()
  await expect(runCordisXCli(['cli', '--service', 'provider', '--model', 'model'], {
    internalCheckTerminalClient: checkClient,
    env: f.env,
    internalSpawnTerminal: spawnTerminal as unknown as typeof spawn,
  })).rejects.toThrow('already-running')
  expect(spawnTerminal).not.toHaveBeenCalled()
})

it.each(['missing', 'permission', 'synchronous'])(
  'releases a prepared lease and gives repair advice for a %s startup failure after the check',
  async failure => {
    const f = await fixture()
    const executable = path.join(f.root, 'codex')
    await writeFile(executable, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
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
          if (failure === 'missing') await rm(executable)
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
    const error = await runCordisXCli([
      'cli',
      '--service',
      'fixture',
      '--model',
      'model',
      '--codex-executable',
      executable,
    ], {
      env: f.env,
      ...(failure === 'missing' ? {} : {
        internalSpawnTerminal: (() => {
          const error = Object.assign(new Error('PRIVATE_TEST_DETAILS'), { code: 'EACCES' })
          if (failure === 'synchronous') throw error
          const child = new EventEmitter()
          setImmediate(() => child.emit('error', error))
          return child
        }) as unknown as typeof spawn,
      }),
    }).catch(error => error as Error)
    expect(error.message).toContain(
      failure === 'missing' ? 'disappeared after the startup check' : 'permission to execute',
    )
    expect(error.message).toContain('npm install -g @openai/codex@latest')
    expect(error.message).toContain('--executable')
    expect(error.message).not.toContain('PRIVATE_TEST_DETAILS')
    expect(calls).toEqual(['prepare', 'release'])
  },
)

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
  await writeFile(executable, '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\nexit 7\n', { mode: 0o700 })
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

it.each(['codex', 'claude-code'] as const)(
  'installs configured Skills before starting %s and skips informational commands',
  async client => {
    const f = await fixture()
    const { execFileSync } = await import('node:child_process')
    const { mkdir } = await import('node:fs/promises')
    const { pathToFileURL } = await import('node:url')
    const repo = path.join(f.root, 'fixture.git')
    await mkdir(path.join(repo, 'review'), { recursive: true })
    await writeFile(path.join(repo, 'review', 'SKILL.md'), 'fixture')
    for (
      const args of [
        ['init', '-q'],
        ['config', 'user.email', 'test@example.invalid'],
        ['config', 'user.name', 'Test'],
        ['add', '.'],
        ['commit', '-qm', 'fixture'],
      ]
    ) execFileSync('git', ['-C', repo, ...args])
    const source = `${pathToFileURL(repo).href}@review`
    await writeFile(f.configPath, JSON.stringify({ ...createDefaultHomeConfig(), skills: [source] }))
    const target = path.join(f.root, client === 'codex' ? '.agents' : '.claude', 'skills', 'review', 'SKILL.md')
    const runtime = {
      homedir: f.root,
      env: f.env,
      stdout: () => {},
      internalCheckTerminalClient: checkClient,
      internalSpawnTerminal: (() => spawn(process.execPath, ['-e', 'process.exit(0)'])) as typeof spawn,
    }
    await runCordisXCli(['start', '--mode', 'cli', client, '--', '--help'], runtime)
    await expect(readFile(target)).rejects.toThrow()
    await runCordisXCli(['start', '--mode', 'cli', client, '--list'], runtime)
    await expect(readFile(target)).rejects.toThrow()
    await runCordisXCli(['start', '--mode', 'cli', client], {
      ...runtime,
      internalSpawnTerminal: (() => {
        expect(readFileSync(target, 'utf8')).toBe('fixture')
        return spawn(process.execPath, ['-e', 'process.exit(0)'])
      }) as typeof spawn,
    })
  },
)

it.each(['codex', 'claude-code'] as const)(
  'projects MCP before spawning %s alongside a provider overlay',
  async client => {
    const f = await fixture()
    const home = path.join(f.root, 'native-home')
    const codexHome = path.join(f.root, 'actual-codex-home')
    const config = {
      ...createDefaultHomeConfig(),
      mcp: {
        servers: {
          example: { type: 'http', url: 'https://example.com/mcp', headers: { Authorization: { env: 'MCP_TOKEN' } } },
        },
      },
      providers: [{
        id: 'shared',
        kind: 'model-service',
        displayName: 'Shared',
        baseUrl: 'https://example.com/v1',
        apiKeyEnv: 'SHARED_KEY',
        protocols: ['openai-responses', 'anthropic-messages'],
        models: { codex: ['model-one'], claude: ['model-one'] },
      }],
      environmentVariables: [{ name: 'SHARED_KEY', value: 'private-provider', enabled: true }, {
        name: 'MCP_TOKEN',
        value: 'private-mcp',
        enabled: true,
      }],
    }
    await writeFile(f.configPath, JSON.stringify(config))
    let adapterFile: string | undefined
    const { readFileSync } = await import('node:fs')
    await runCordisXCli(['start', '--mode', 'cli', client, '-s', 'shared', '-m', 'model-one'], {
      internalCheckTerminalClient: checkClient,
      env: { ...f.env, HOME: home, CODEX_HOME: codexHome },
      internalSpawnTerminal: ((_exe: string, args: string[], options: any) => {
        expect(options.env.MCP_TOKEN).toBe('private-mcp')
        if (client === 'codex') {
          const actual = parseToml(readFileSync(path.join(codexHome, 'config.toml'), 'utf8'))
          expect(actual).toMatchObject({
            mcp_servers: { example: { env_http_headers: { Authorization: 'MCP_TOKEN' } } },
          })
          expect(args).toContain('model_provider="shared"')
        } else {
          expect(args).toContain('--settings')
          adapterFile = args[args.indexOf('--mcp-config') + 1]
          expect(JSON.parse(readFileSync(adapterFile!, 'utf8'))).toMatchObject({
            mcpServers: { cordisx_example: { type: 'http' } },
          })
        }
        return spawn(process.execPath, ['-e', 'process.exit(0)'])
      }) as typeof spawn,
    })
    if (adapterFile) await expect(readFile(adapterFile)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it('does not project MCP for terminal help, native inspection, or service listing', async () => {
  const f = await fixture()
  const codexHome = path.join(f.root, 'unused-codex-home')
  await writeFile(
    f.configPath,
    JSON.stringify({
      ...createDefaultHomeConfig(),
      mcp: {
        servers: {
          needs_env: {
            type: 'http',
            url: 'https://example.com/mcp',
            headers: { Authorization: { env: 'MISSING_MCP_TOKEN' } },
          },
        },
      },
    }),
  )
  const runtime = {
    env: { ...f.env, HOME: f.root, CODEX_HOME: codexHome },
    stdout: () => {},
    internalCheckTerminalClient: checkClient,
    internalSpawnTerminal: (() => spawn(process.execPath, ['-e', 'process.exit(0)'])) as typeof spawn,
  }
  await runCordisXCli(['cli', '--help'], runtime)
  await runCordisXCli(['cli', '--', '--version'], runtime)
  await runCordisXCli(['cli', '--list'], runtime)
  await expect(readFile(path.join(codexHome, 'config.toml'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(
  [
    ['codex', ['-c', 'mcp_servers.example.command="other"']],
    ['claude-code', ['--strict-mcp-config']],
    ['claude-code', ['--mcp-config', '/tmp/other.json']],
  ] as const,
)('rejects conflicting native MCP overlays for %s', async (client, args) => {
  const f = await fixture()
  await writeFile(
    f.configPath,
    JSON.stringify({ ...createDefaultHomeConfig(), mcp: { servers: { example: { type: 'stdio', command: 'true' } } } }),
  )
  const spawnTerminal = vi.fn()
  await expect(runCordisXCli(['start', '--mode', 'cli', client, '--', ...args], {
    env: { ...f.env, HOME: f.root, CODEX_HOME: path.join(f.root, 'codex') },
    internalCheckTerminalClient: checkClient,
    internalSpawnTerminal: spawnTerminal as unknown as typeof spawn,
  })).rejects.toThrow(/MCP/)
  expect(spawnTerminal).not.toHaveBeenCalled()
})

it.each(['codex', 'claude-code'] as const)('loads Skills and MCP from the same home config for %s', async client => {
  const f = await fixture()
  const { execFileSync } = await import('node:child_process')
  const { mkdir } = await import('node:fs/promises')
  const { pathToFileURL } = await import('node:url')
  const repo = path.join(f.root, 'combined.git')
  await mkdir(path.join(repo, 'review'), { recursive: true })
  await writeFile(path.join(repo, 'review', 'SKILL.md'), 'fixture')
  for (
    const args of [['init', '-q'], ['config', 'user.email', 'test@example.invalid'], ['config', 'user.name', 'Test'], [
      'add',
      '.',
    ], ['commit', '-qm', 'fixture']]
  ) execFileSync('git', ['-C', repo, ...args])
  await writeFile(
    f.configPath,
    JSON.stringify({
      ...createDefaultHomeConfig(),
      skills: [`${pathToFileURL(repo).href}@review`],
      mcp: { servers: { example: { type: 'stdio', command: 'true' } } },
      environmentVariables: [{ name: 'CORDISX_HOME', value: path.join(f.root, 'other-home'), enabled: true }],
    }),
  )
  const target = path.join(f.root, client === 'codex' ? '.agents' : '.claude', 'skills', 'review', 'SKILL.md')
  const codexHome = path.join(f.root, 'codex-home')
  await runCordisXCli(['start', '--mode', 'cli', client], {
    homedir: f.root,
    env: { ...f.env, HOME: f.root, CODEX_HOME: codexHome },
    stdout: () => {},
    internalCheckTerminalClient: checkClient,
    internalSpawnTerminal: ((_executable: string, args: string[]) => {
      expect(readFileSync(target, 'utf8')).toBe('fixture')
      if (client === 'codex') {
        expect(parseToml(readFileSync(path.join(codexHome, 'config.toml'), 'utf8'))).toMatchObject({
          mcp_servers: { example: { command: 'true' } },
        })
      } else {expect(JSON.parse(readFileSync(args[args.indexOf('--mcp-config') + 1]!, 'utf8'))).toMatchObject({
          mcpServers: { cordisx_example: { command: 'true' } },
        })}
      return spawn(process.execPath, ['-e', 'process.exit(0)'])
    }) as typeof spawn,
  })
})
