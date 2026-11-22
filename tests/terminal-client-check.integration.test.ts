import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, it, vi } from 'vitest'
import { checkTerminalClient } from '../packages/cli/src/cli/terminal-client-check.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'

const execute = promisify(execFile)
const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-terminal-check-'))
  roots.push(root)
  const env = { ...process.env, CORDISX_HOME: path.join(root, 'home') }
  await mkdir(env.CORDISX_HOME, { recursive: true })
  await writeFile(path.join(env.CORDISX_HOME, 'config.json'), JSON.stringify(createDefaultHomeConfig()))
  return { root, env, cwd: root, client: 'codex' as const }
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
async function entry(root: string, name: string, script: string) {
  const executable = path.join(root, name)
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(script)} -- "$@"\n`, {
    mode: 0o700,
  })
  return executable
}

it('reports missing CLI before contacting an unavailable provider, with install and PATH guidance', async () => {
  const f = await fixture()
  const spawn = vi.fn()
  const error = await runCordisXCli(['start', '--mode', 'cli', 'codex', '-s', 'aiden', '-m', 'gpt-6.1-sol'], {
    env: { ...f.env, PATH: f.root },
    internalSpawnTerminal: spawn as any,
  }).catch(error => error as Error)
  expect(error.message).toContain('Codex CLI was not found')
  expect(error.message).toContain('npm install -g @openai/codex@latest')
  expect(error.message).toContain('codex --version')
  expect(error.message).toContain('PATH')
  expect(error.message).toContain('--executable /absolute/path')
  expect(spawn).not.toHaveBeenCalled()
})

it('honors an explicit missing path instead of using another PATH installation', async () => {
  const f = await fixture()
  await entry(f.root, 'codex', 'process.exit(0)')
  const executable = path.join(f.root, 'missing', 'codex')
  await expect(checkTerminalClient(executable, { ...f, env: { ...f.env, PATH: f.root } }))
    .rejects.toThrow(`Selected executable: ${JSON.stringify(executable)}`)
})

it('detects a pnpm wrapper with a deleted module without falling through to a healthy PATH entry', async () => {
  const f = await fixture()
  const deleted = path.join(f.root, 'deleted', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
  const executable = path.join(f.root, 'pnpm', 'bin', 'codex')
  await mkdir(path.dirname(executable), { recursive: true })
  await writeFile(executable, `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(deleted)} "$@"\n`, { mode: 0o700 })
  await entry(f.root, 'healthy/codex', 'process.exit(0)')
  const env = { ...f.env, PATH: `${path.dirname(executable)}${path.delimiter}${path.join(f.root, 'healthy')}` }
  const error = await checkTerminalClient('codex', { ...f, env }).catch(error => error as Error)
  expect(error.message).toContain('installation is incomplete')
  expect(error.message).toContain(JSON.stringify(executable))
  expect(error.message).toContain('pnpm add -g @openai/codex@latest --force')
  expect(error.message).not.toContain('node:internal')
  expect(error.message).not.toContain(deleted)
})

it('accepts an explicit executable with spaces and passes only --version to its probe', async () => {
  const f = await fixture()
  const argsFile = path.join(f.root, 'args.json')
  const executable = await entry(
    f.root,
    'bin with spaces/codex',
    `require('node:fs').writeFileSync(${JSON.stringify(argsFile)}, JSON.stringify(process.argv.slice(1)))`,
  )
  expect(await checkTerminalClient(executable, { ...f, env: { ...f.env, PATH: '' } })).toBe(executable)
  expect(JSON.parse(await readFile(argsFile, 'utf8'))).toEqual(['--version'])
})

it('keeps help and list usable without an installed client', async () => {
  const f = await fixture()
  const output: string[] = []
  const runtime = { env: { ...f.env, PATH: f.root }, stdout: (line: string) => output.push(line) }
  await runCordisXCli(['start', '--mode', 'cli', '--help'], runtime)
  await runCordisXCli(['start', '--mode', 'cli', '--list'], runtime)
  expect(output[0]).toContain('Usage:')
  expect(JSON.parse(output[1]!)).toMatchObject({ complete: false, providers: [] })
})

it('checks and launches the same entry from a shared service configured PATH', async () => {
  const f = await fixture()
  const executable = await entry(f.root, 'configured-bin/codex', 'process.exit(0)')
  await writeFile(
    path.join(f.env.CORDISX_HOME, 'config.json'),
    JSON.stringify({
      ...createDefaultHomeConfig(),
      providers: [{
        id: 'shared',
        kind: 'model-service',
        displayName: 'Shared',
        baseUrl: 'https://example.com/v1',
        apiKeyEnv: 'KEY',
        protocols: ['openai-responses'],
        models: { codex: ['model'] },
      }],
      environmentVariables: [
        { name: 'KEY', value: 'TEST_PRIVATE_KEY', enabled: true },
        { name: 'PATH', value: path.dirname(executable), enabled: true },
      ],
    }),
  )
  await runCordisXCli(['cli', '-s', 'shared', '-m', 'model'], {
    env: { ...f.env, PATH: path.join(f.root, 'missing-bin') },
    internalSpawnTerminal: ((selected: string, _args: string[], options: any) => {
      expect(selected).toBe(executable)
      expect(options.env.PATH).toBe(path.dirname(executable))
      return execFile(executable, ['--version'])
    }) as any,
  })
})

it('gives a permission-specific diagnostic for a nonexecutable explicit file', async () => {
  const f = await fixture()
  const executable = await entry(f.root, 'codex', 'process.exit(0)')
  await chmod(executable, 0o600)
  await expect(checkTerminalClient(executable, f)).rejects.toThrow('permission denied')
})

it('does not expose arbitrary output from failed version checks', async () => {
  const f = await fixture()
  const executable = await entry(f.root, 'codex', "console.error('PRIVATE_TEST_TOKEN'); process.exit(2)")
  const error = await checkTerminalClient(executable, f).catch(error => error as Error)
  expect(error.message).toContain('failed its --version startup check (exit 2)')
  expect(error.message).not.toContain('PRIVATE_TEST_TOKEN')
})

it('bounds excessive version output without exposing it', async () => {
  const f = await fixture()
  const executable = await entry(f.root, 'codex', "process.stdout.write('PRIVATE_TEST_TOKEN'.repeat(10000))")
  const error = await checkTerminalClient(executable, f).catch(error => error as Error)
  expect(error.message).toContain('exceeded its output limit')
  expect(error.message).not.toContain('PRIVATE_TEST_TOKEN')
})

it('cancels a running probe and removes process signal handlers', async () => {
  const f = await fixture()
  const marker = path.join(f.root, 'started')
  const executable = await entry(
    f.root,
    'codex',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setInterval(() => {}, 1000)`,
  )
  const controller = new AbortController()
  const before = ['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal))
  const result = checkTerminalClient(executable, { ...f, signal: controller.signal }).catch(error => error as Error)
  await vi.waitFor(async () => expect(await readFile(marker, 'utf8')).toBe('started'), { timeout: 3000 })
  controller.abort()
  expect((await result).message).toContain('startup check cancelled')
  expect(['SIGINT', 'SIGTERM', 'SIGHUP'].map(signal => process.listenerCount(signal))).toEqual(before)
})

it('kills a hung version probe within the finite startup budget', async () => {
  const f = await fixture()
  const pidFile = path.join(f.root, 'pid')
  const executable = await entry(
    f.root,
    'codex',
    `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`,
  )
  const started = Date.now()
  await expect(checkTerminalClient(executable, f)).rejects.toThrow('timed out after 5 seconds')
  expect(Date.now() - started).toBeLessThan(8000)
  const pid = Number(await readFile(pidFile, 'utf8'))
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow())
})

it('prints the actionable diagnostic through the compiled CLI instead of a Node stack trace', async () => {
  const f = await fixture()
  const executable = await entry(f.root, 'pnpm/bin/codex', "require('./deleted-codex.js')")
  const error = await execute(process.execPath, [
    path.resolve('packages/cli/dist/src/cli.js'),
    'start',
    '--mode',
    'cli',
    'codex',
    '-s',
    'aiden',
    '-m',
    'gpt-6.1-sol',
    '--executable',
    executable,
  ], { env: f.env }).catch(error => error)
  expect(error.code).toBe(1)
  expect(error.stderr).toContain('installation is incomplete')
  expect(error.stderr).toContain('pnpm add -g @openai/codex@latest --force')
  expect(error.stderr).not.toContain('node:internal/modules')
  expect(error.stderr).not.toContain('requires an already-running')
})

it('names Claude Code correctly when its installation is missing', async () => {
  const f = await fixture()
  const error = await checkTerminalClient('claude', { ...f, client: 'claude-code', env: { ...f.env, PATH: f.root } })
    .catch(error => error as Error)
  expect(error.message).toContain('Claude Code CLI was not found')
  expect(error.message).not.toContain('@openai/codex')
})
