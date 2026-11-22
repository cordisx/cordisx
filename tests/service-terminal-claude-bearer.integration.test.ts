import { type ChildProcess, execFile, spawn } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, open, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { parse as parseToml } from 'smol-toml'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { managedServiceHome } from '../packages/cli/src/launcher/managed-service-process.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

// Explicit opt-in: the child is restricted to a synthetic loopback gateway and private test roots.
const claudeEntry = process.env.CORDISX_TEST_REAL_CLAUDE_CLI
const codexEntry = process.env.CORDISX_TEST_REAL_CODEX_CLI
const enabled = process.platform === 'darwin' && !!claudeEntry
const run = promisify(execFile)

async function removeFixture(directory: string): Promise<void> {
  await chmod(directory, 0o700)
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await removeFixture(path.join(directory, entry.name))
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}

it.skipIf(!enabled)('runs real terminal clients against a bearer gateway across owner loss', async () => {
  const cli = path.resolve('packages/cli/dist/src/cli.js')
  const node = await realpath(process.execPath)
  const claude = await realpath(claudeEntry!)
  const codex = codexEntry ? await realpath(codexEntry) : undefined
  const helperRoot = await realpath(path.resolve('packages/cli/dist/assets/launcher'))
  const installRoots = [path.dirname(path.dirname(node)), path.dirname(path.dirname(claude))]
  if (codex) installRoots.push(path.dirname(path.dirname(codex)))
  if (installRoots.some(directory => directory.startsWith('/Users/') && directory.split(path.sep).length < 6)) {
    throw new Error('Real client smoke needs narrowly scoped installation roots')
  }
  const isScript = async (entry: string) => {
    const file = await open(entry, 'r')
    const first = Buffer.alloc(2)
    try {
      await file.read(first, 0, first.length, 0)
      return first.toString() === '#!'
    } finally {
      await file.close()
    }
  }
  const claudeScript = await isScript(claude)
  const codexScript = codex ? await isScript(codex) : false
  const root = await realpath(await mkdtemp('/tmp/cx-claude-managed-'))
  const home = path.join(root, 'cordisx')
  const userHome = path.join(root, 'home')
  const codexHome = path.join(root, 'codex')
  const claudeHome = path.join(root, 'claude')
  const managed = path.join(root, 'managed')
  const env: NodeJS.ProcessEnv = {
    HOME: userHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeHome,
    CLAUDE_CODE_MANAGED_SETTINGS_PATH: managed,
    CORDISX_HOME: home,
    CORDISX_MODEL_API_PORT: '0',
    TMPDIR: root,
    PATH: path.dirname(node) + ':/usr/bin:/bin',
    USER: 'cordisx-fixture',
    LOGNAME: 'cordisx-fixture',
    LANG: 'en_US.UTF-8',
    CI: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
  }
  const serviceCommand = async (action: string) =>
    await run(node, [cli, action, '--mode', 'service', 'codex', 'default', '--json'], {
      cwd: root,
      env,
      timeout: 35_000,
    })
  const policyFor = (address: string) => {
    const base = new URL(address)
    if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !base.port) {
      throw new Error('Fixture gateway is not loopback')
    }
    // Native Claude Code reads the system time-zone database during startup.
    const allowed = [
      ...installRoots,
      root,
      helperRoot,
      '/private/etc',
      '/private/var/db/dyld',
      '/private/var/db/timezone',
    ]
    return [
      '(version 1)',
      '(allow default)',
      '(deny network*)',
      '(allow network-outbound (remote ip "localhost:' + base.port + '"))',
      '(allow network-outbound (remote unix-socket (subpath ' + JSON.stringify(root) + ')))',
      '(deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/Library") (subpath "/private"))',
      '(allow file-read-data ' + allowed.map(directory => '(subpath ' + JSON.stringify(directory) + ')').join(' ')
      + ')',
      '(deny file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/Library") (subpath "/private"))',
      '(allow file-write* (subpath ' + JSON.stringify(root) + '))',
      '(deny mach-lookup (global-name "com.apple.securityd"))',
    ].join('\n')
  }
  let child: ChildProcess | undefined
  let codexChild: ChildProcess | undefined
  let codexResult: Promise<{ ok: boolean; error?: unknown }> | undefined
  let childTimer: ReturnType<typeof setTimeout> | undefined
  let codexTimer: ReturnType<typeof setTimeout> | undefined
  let output = ''
  let errors = ''
  let codexOutput = ''
  let codexErrors = ''
  try {
    await Promise.all([home, userHome, codexHome, claudeHome, managed].map(directory => mkdir(directory)))
    await writeFile(path.join(home, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    await writeFile(path.join(managed, 'managed-settings.json'), '{}', { mode: 0o600 })
    await stageServiceModePlugin(root, home, 'default', true)
    expect(JSON.parse((await serviceCommand('start')).stdout)).toMatchObject({ status: 'ready', mode: 'service' })
    const paths = pluginManagementRpcPaths(home, 'codex', 'default')
    const endpoint = (await readPluginManagementRpcEndpoint(paths))!
    const request = (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
      requestPluginManagementRpc(paths, endpoint, operation)
    const other = await request({
      kind: 'terminal-provider',
      request: { kind: 'prepare', providerId: 'fixture-provider', model: 'fixture-model' },
    }) as { kind: string; leaseId: string }
    expect(other.kind).toBe('prepared')
    const gate = path.join(root, 'codex-gate.sh')
    await writeFile(gate, '#!/bin/sh\nprintf "fixture-gate-ready\\n" >&2\nIFS= read -r _ || exit 1\nexec "$@"\n', {
      mode: 0o700,
    })
    const startCodex = (prompt = 'Reply with one word.') => {
      if (!codex) return undefined
      clearTimeout(codexTimer)
      codexOutput = ''
      codexErrors = ''
      codexResult = runCordisXCli([
        'start',
        '--mode',
        'cli',
        'codex',
        '-s',
        'fixture-provider',
        '-m',
        'fixture-model',
        '--',
        'exec',
        '--skip-git-repo-check',
        '--sandbox',
        'read-only',
        prompt,
      ], {
        env,
        cwd: root,
        homedir: userHome,
        internalCheckTerminalClient: async () => codex,
        internalSpawnTerminal: ((executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          expect(executable).toBe(codex)
          const entry = args.find(value => value.startsWith('model_providers='))!
          const providers = parseToml(entry).model_providers as Record<string, { base_url: string }>
          const policy = policyFor(providers['fixture-provider']!.base_url)
          codexChild = spawn('/usr/bin/sandbox-exec', [
            '-p',
            policy,
            '/bin/sh',
            gate,
            ...(codexScript ? [node, codex] : [codex]),
            ...args,
          ], { cwd: root, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] })
          codexChild.stdout!.setEncoding('utf8').on('data', chunk => {
            codexOutput += chunk
          })
          codexChild.stderr!.setEncoding('utf8').on('data', chunk => {
            codexErrors += chunk
          })
          codexTimer = setTimeout(() => codexChild?.kill('SIGKILL'), 45_000)
          return codexChild
        }) as typeof spawn,
      }).then(() => ({ ok: true }), error => ({ ok: false, error }))
      return codexResult
    }
    const waitForCodex = async () =>
      await expect.poll(() => codexErrors.includes('fixture-gate-ready'), { timeout: 10_000 }).toBe(true)
    const firstCodex = startCodex()
    if (firstCodex) await waitForCodex()
    const runClaude = async () => {
      clearTimeout(childTimer)
      output = ''
      errors = ''
      await runCordisXCli([
        'start',
        '--mode',
        'cli',
        'claude-code',
        '-s',
        'fixture-provider',
        '-m',
        'fixture-model',
        '--',
        '--print',
        'Reply with one word.',
      ], {
        env,
        cwd: root,
        homedir: userHome,
        internalCheckTerminalClient: async () => claude,
        internalSpawnTerminal: ((executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
          expect(executable).toBe(claude)
          const policy = policyFor(options.env.ANTHROPIC_BASE_URL!)
          child = spawn('/usr/bin/sandbox-exec', [
            '-p',
            policy,
            ...(claudeScript ? [node, claude] : [claude]),
            ...args,
          ], { cwd: root, env: options.env, stdio: ['ignore', 'pipe', 'pipe'] })
          child.stdout!.setEncoding('utf8').on('data', chunk => {
            output += chunk
          })
          child.stderr!.setEncoding('utf8').on('data', chunk => {
            errors += chunk
          })
          childTimer = setTimeout(() => child?.kill('SIGKILL'), 30_000)
          return child
        }) as typeof spawn,
      }).catch(error => {
        const diagnostic = (errors + '\n' + output).slice(0, 1_500).replace(/[A-Za-z0-9_-]{20,}/gu, '[redacted]')
        throw new Error('Isolated Claude failed: ' + diagnostic, { cause: error })
      })
      expect(output).toContain('local fixture response')
    }
    await runClaude()
    expect(await request({ kind: 'terminal-provider', request: { kind: 'renew', leaseId: other.leaseId } }))
      .toEqual({ kind: 'renewed' })
    const finishCodex = async (result: NonNullable<typeof firstCodex>) => {
      codexChild!.stdin!.end('\n')
      const completed = await result
      if (!completed.ok) {
        const diagnostic = (codexErrors + '\n' + codexOutput).slice(0, 1_500).replace(
          /[A-Za-z0-9_-]{20,}/gu,
          '[redacted]',
        )
        throw new Error('Isolated Codex failed: ' + diagnostic, { cause: completed.error })
      }
      expect(codexOutput).toContain('local fixture response')
    }
    if (firstCodex) await finishCodex(firstCodex)
    const interrupted = startCodex('hold-open-fixture')
    if (interrupted) {
      await waitForCodex()
      codexChild!.stdin!.end('\n')
      await expect.poll(async () =>
        await access(path.join(
          managedServiceHome(home, 'fixture-service', 'gateway'),
          'fixture-response-open',
        )).then(
          () => true,
          () => false,
        ), { timeout: 20_000 }).toBe(true)
    }
    expect(JSON.parse((await serviceCommand('stop')).stdout)).toMatchObject({ status: 'stopped' })
    if (interrupted) {
      let timeout: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          interrupted,
          new Promise<never>((_resolve, reject) => {
            timeout = setTimeout(() => reject(new Error('Client did not stop after owner loss')), 25_000)
          }),
        ])
        expect(result.ok).toBe(false)
        expect((result.error as Error).message).toContain('CordisX provider retired')
      } finally {
        clearTimeout(timeout)
      }
    }
    expect(JSON.parse((await serviceCommand('start')).stdout)).toMatchObject({ status: 'ready', mode: 'service' })
    const recoveredEndpoint = (await readPluginManagementRpcEndpoint(paths))!
    expect(recoveredEndpoint.generation).not.toBe(endpoint.generation)
    await expect(requestPluginManagementRpc(paths, recoveredEndpoint, {
      kind: 'terminal-provider',
      request: { kind: 'renew', leaseId: other.leaseId },
    })).rejects.toThrow()
    await runClaude()
    const recoveredCodex = startCodex()
    if (recoveredCodex) {
      await waitForCodex()
      await finishCodex(recoveredCodex)
    }
  } finally {
    clearTimeout(childTimer)
    clearTimeout(codexTimer)
    if (child?.exitCode === null) child.kill('SIGKILL')
    if (codexChild?.exitCode === null) codexChild.kill('SIGKILL')
    await codexResult
    await serviceCommand('stop').catch(() => undefined)
    await removeFixture(root)
  }
}, 120_000)
