import { type ChildProcess, spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { prepareProductionHostBootstrap } from '../packages/cli/src/cli/production-host-bootstrap.js'
import { nativeSubmissionCatalogOptions } from '../packages/cli/src/cli/native-submission-catalog-options.js'
import {
  createNativeSubmissionComposition,
  prepareNativeSubmissionBootstrap,
} from '../packages/cli/src/launcher/native-submission-composition.js'
import * as processModule from '../packages/cli/src/launcher/process.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture(layout = 'codex-cli/bin/codex') {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'cx-dot-')))
  roots.push(root)
  const contents = path.join(root, 'Selected Desktop.app/Contents')
  const executable = path.join(contents, 'MacOS/Fixture')
  const cli = path.join(contents, 'Resources', layout)
  const node = path.join(contents, 'Resources/cua_node/bin/node')
  const args = path.join(root, 'cli-args')
  for (const file of [executable, cli, node]) {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, '#!/bin/sh\nexit 99\n')
    await chmod(file, 0o755)
  }
  // These are temporary scripts only. No installed Desktop or native server runs.
  await writeFile(cli, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${args}'\nexec /bin/cat\n`)
  await writeFile(node, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`)
  return { root, contents, executable, cli, args }
}

it.skipIf(process.platform !== 'darwin').each(['codex', 'codex-cli/bin/codex'])(
  'keeps chat connected while the local executor uses the selected bundled %s',
  async layout => {
    const f = await fixture(layout)
    const bootstrap = await prepareNativeSubmissionBootstrap(f.executable)
    const children: ChildProcess[] = []
    try {
      const environment = bootstrap.environment
      expect(environment.CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH).toBe(f.cli)
      expect(environment.CORDISX_NATIVE_REAL_CODEX_PATH).toBe(f.cli)
      expect(environment.CODEX_CLI_PATH).not.toBe(f.cli)
      const chat = spawn(environment.CODEX_CLI_PATH!, ['app-server'], { env: environment })
      children.push(chat)
      chat.stdin!.on('error', () => {})
      const ready = once(chat.stdout!, 'data')
      chat.stdin!.write('{"probe":"chat"}\n')
      await ready
      const executor = spawn(environment.CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH!, ['exec-server'], { env: environment })
      children.push(executor)
      let output = ''
      executor.stdout!.on('data', chunk => output += chunk)
      executor.stdin!.end('{"probe":"executor"}\n')
      expect((await once(executor, 'close'))[0]).toBe(0)
      expect(output).toBe('{"probe":"executor"}\n')
      expect(chat.exitCode).toBeNull()
      // Chat still works after the executor exits, using the single control peer.
      const response = once(chat.stdout!, 'data')
      chat.stdin!.write('{"probe":"chat-still-connected"}\n')
      expect(String((await response)[0])).toContain('chat-still-connected')
      expect(await readFile(f.args, 'utf8')).toContain('exec-server')
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close')
          child.kill('SIGTERM')
          await closed
        }
      }
      await bootstrap.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin').each(['default', 'inherited', 'plan', 'configured', 'disabled', 'empty'])(
  'passes the %s executor path through the production prelaunch environment',
  async mode => {
    const f = await fixture()
    const key = 'CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH'
    const config = {
      ...createDefaultHomeConfig(),
      environmentVariables: mode === 'configured' || mode === 'disabled'
        ? [{ name: key, value: '/configured/executor', enabled: mode === 'configured' }]
        : [],
    }
    const configPath = path.join(f.root, 'config.json')
    await writeFile(configPath, JSON.stringify(config))
    const invocation = parseCordisXCli(['run', 'codex'])
    if (invocation.action !== 'run') throw new Error('expected run')
    const environment = mode === 'default' ? {} : { [key]: mode === 'empty' ? '' : '/inherited/executor' }
    const planEnvironment = mode === 'plan' || mode === 'configured' ? { [key]: '/plan/executor' } : {}
    const launch = vi.spyOn(processModule, 'launchCodex').mockReturnValue({ pid: 123 } as ChildProcess)
    const result = await prepareProductionHostBootstrap(
      {
        invocation: { ...invocation, action: 'launch' },
        stdout: () => {},
        environment,
        configPath,
        appId: 'codex',
        selection: {
          config,
          appId: 'codex',
          profileId: 'default',
          profile: { dataMode: 'shared' },
          dataMode: 'shared',
          created: false,
        },
        adapter: {
          id: 'codex',
          displayName: 'Fixture',
          prepareLaunch: async () => {},
          resolveLaunchPlan: async () => ({
            version: 1,
            appId: 'codex',
            appName: 'Fixture',
            profileId: 'default',
            dataMode: 'shared',
            executable: f.executable,
            chromiumProfile: { mode: 'system' },
            environment: planEnvironment,
            sharedDataRoots: [],
            isolatedDataRoots: [],
          }),
        },
      },
      { env: environment },
      {
        prelaunch: true,
        prepareNativeSubmission: true,
        mainInspector: false,
        markHostLaunched: () => {},
      },
    )
    try {
      const expected = mode === 'configured'
        ? '/configured/executor'
        : mode === 'plan'
        ? '/plan/executor'
        : mode === 'inherited'
        ? '/inherited/executor'
        : f.cli
      const launchedEnvironment = launch.mock.calls[0]![5]!
      expect(launchedEnvironment[key]).toBe(expected)
      expect(launchedEnvironment.CODEX_CLI_PATH).toBe(result.nativeSubmissionBootstrap!.environment.CODEX_CLI_PATH)
      expect(launchedEnvironment.CODEX_CLI_PATH).not.toBe(expected)
    } finally {
      await result.nativeSubmissionBootstrap?.close()
    }
  },
)

it.skipIf(process.platform !== 'darwin')(
  'preserves configured executor overrides through the direct development composition',
  async () => {
    const f = await fixture()
    const options = nativeSubmissionCatalogOptions(
      f.root,
      'default',
      {},
      {
        CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH: '/inherited/executor',
      },
      undefined,
      undefined,
      [{ name: 'CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH', value: '/custom/executor', enabled: true }],
    )
    // This fixture has no archive: catalog discovery may fail without dropping routing.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const composition = await createNativeSubmissionComposition(
      { nativeProviderIds: [], prepareNativeConnection: vi.fn() },
      f.executable,
      path.join(f.root, 'codex'),
      { nativeDiscoveryEnvironment: options.nativeDiscoveryEnvironment, nativeModelDiscovery: false },
    )
    try {
      expect(composition.environment.CODEX_TPP_LOCAL_EXECUTOR_CLI_PATH).toBe('/custom/executor')
      expect(composition.environment.CORDISX_NATIVE_REAL_CODEX_PATH).toBe(f.cli)
    } finally {
      await composition.close()
    }
  },
)
