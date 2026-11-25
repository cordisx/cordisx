import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  processIdentityStatus,
  processStartIdentity,
  readSupervisorState,
  supervisorPaths,
} from '../packages/cli/src/cli/supervisor-state.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

const run = promisify(execFile)
const cli = process.env.CORDISX_SERVICE_MODE_TEST_CLI ?? path.resolve('packages/cli/dist/src/cli.js')
const profile = 'service-fixture'
const scope = ['--mode', 'service', 'codex', profile, '--json']

async function removeFixture(root: string) {
  const allowRemoval = async (directory: string) => {
    await chmod(directory, 0o700)
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await allowRemoval(path.join(directory, entry.name))
    }
  }
  await allowRemoval(root)
  await rm(root, { recursive: true, force: true })
}

it('runs the production CLI and installed backend without Desktop, then reaps both owners', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-service-test-'))
  const home = path.join(root, 'home')
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CORDISX_')),
  )
  Object.assign(env, {
    CORDISX_HOME: home,
    CORDISX_MODEL_API_PORT: '0',
    HOME: root,
    CODEX_HOME: path.join(root, 'codex'),
  })
  const cmd = async (...args: string[]) =>
    (await run(process.execPath, [cli, ...args], { env, cwd: root, timeout: 25000 }).catch(error => {
      throw new Error(error.stdout || error.message)
    })).stdout
  const lifecycle = async (action: string) => JSON.parse(await cmd(action, ...scope))
  const bindingPath = path.join(home, 'run', 'model-api', profile, 'server.json')
  const backends = new Map<number, string>()
  const owners = new Map<number, string>()
  let restrictedDirectory: string | undefined
  const rememberBackend = async (pid: number) => {
    const startedAt = await processStartIdentity(pid)
    expect(startedAt).toBeDefined()
    if (startedAt !== undefined) backends.set(pid, startedAt)
  }
  try {
    await mkdir(home)
    await stageServiceModePlugin(root, home, profile, true)
    await stageServiceModePlugin(root, home, profile, false)
    const [ready, reused] = await Promise.all([lifecycle('start'), lifecycle('start')])
    expect(ready).toMatchObject({
      mode: 'service',
      status: 'ready',
      cdpEndpoint: null,
      desktop: 'unavailable',
    })
    expect(reused.pid).toBe(ready.pid)
    expect(await lifecycle('status')).toMatchObject({ pid: ready.pid, modelApiUrl: ready.modelApiUrl })
    const initialOwner = await readSupervisorState(supervisorPaths(home, 'codex', profile))
    expect(initialOwner).toMatchObject({ pid: ready.pid, mode: 'service', serviceCleanup: 'pending' })
    owners.set(ready.pid, initialOwner!.processStartedAt)
    expect(JSON.parse(await cmd('codex', 'capabilities', '--profile', profile))).toMatchObject({
      status: 'ok',
      capabilities: { modelServices: true, providerCatalog: false, executionSettings: true },
    })
    expect(JSON.parse(await cmd('codex', 'defaults', 'get', '--profile', profile))).toMatchObject({
      scope: 'creation-defaults',
      revision: 0,
    })
    expect(
      JSON.parse(await cmd('codex', 'defaults', 'set', '--revision', '0', '--effort', 'high', '--profile', profile)),
    ).toMatchObject({ revision: 1 })
    expect(JSON.parse(await cmd('codex', 'defaults', 'get', '--profile', profile))).toMatchObject({
      settings: { effort: 'high' },
      revision: 1,
    })
    expect(
      JSON.parse(
        await cmd(
          'codex',
          'defaults',
          'model',
          'set',
          '--revision',
          '0',
          '--provider',
          'later',
          '--model',
          'later-model',
          '--fast',
          'false',
          '--profile',
          profile,
        ),
      ),
    )
      .toMatchObject({ status: 'ok', revision: 1, validation: 'deferred-until-creation' })
    expect(JSON.parse(await cmd('codex', 'defaults', 'model', 'get', '--profile', profile)))
      .toMatchObject({ revision: 1, settings: { providerId: 'later', model: 'later-model', fast: false } })
    expect(JSON.parse(await cmd('models', 'services', 'list', '--profile', profile))).toMatchObject({
      status: 'ok',
      services: [],
    })
    await expect(cmd('start', 'codex', profile, '--json')).rejects.toThrow('owned by service mode')
    await expect(cmd('run', 'codex', profile)).rejects.toThrow('already has a runtime owner')
    const listing = JSON.parse(await cmd('plugin', 'list', '--profile', profile, '--json'))
    expect(listing).toMatchObject({
      runtime: { kind: 'active', mode: 'service' },
      plugins: expect.arrayContaining([
        expect.objectContaining({ id: 'fixture-desktop', status: 'unavailable-in-service-mode' }),
      ]),
    })

    const binding = JSON.parse(await readFile(bindingPath, 'utf8'))
    expect(binding).not.toHaveProperty('agentUrl')
    expect((await stat(binding.accessKeyFile)).mode & 0o777).toBe(0o600)
    const key = (await readFile(binding.accessKeyFile, 'utf8')).trim()
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const base = new URL(binding.baseUrl).origin
    expect(await (await fetch(base + '/healthz')).json()).toMatchObject({ mode: 'service', agents: 'unavailable' })
    expect((await fetch(base + '/agents/sessions', { method: 'POST', headers, body: '{"app":"claude"}' })).status).toBe(
      503,
    )
    expect((await fetch(binding.baseUrl + '/models')).status).toBe(401)
    const modelId = 'fixture-provider::fixture-model'
    const models = await (await fetch(binding.baseUrl + '/models', { headers })).json()
    expect(models, models.data.length ? undefined : await cmd('logs', ...scope)).toMatchObject({
      data: [{ id: modelId, invocation: 'model' }],
    })
    const response = async (url: string) =>
      await (await fetch(url + '/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId, input: 'fixture only' }),
      })).json()
    const result = await response(binding.baseUrl)
    expect(result).toMatchObject({
      model: 'fixture-model',
      output_text: 'local fixture',
      pid: expect.any(Number),
      port: expect.any(Number),
    })
    await rememberBackend(result.pid)
    const ps = await run('/bin/ps', ['-axo', 'pid=,ppid=,comm='])
    const children = ps.stdout.trim().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/))
      .filter(row => row?.[2] === String(ready.pid))
    expect(children.map(row => Number(row?.[1]))).toEqual([result.pid])
    expect((await fetch(`http://127.0.0.1:${result.port}/health`, { headers })).status).toBe(401)

    const disabled = JSON.parse(
      await cmd('plugin', 'disable', 'fixture-service', '--profile', profile, '--yes', '--json'),
    )
    expect(disabled.status).toBe('applied')
    expect(await (await fetch(binding.baseUrl + '/models', { headers })).json()).toMatchObject({ data: [] })
    expect(() => process.kill(result.pid, 0)).toThrow(/ESRCH/)
    const enabled = JSON.parse(
      await cmd('plugin', 'enable', 'fixture-service', '--profile', profile, '--yes', '--json'),
    )
    expect(enabled.status).toBe('applied')
    const reenabled = await response(binding.baseUrl)
    expect(reenabled.output_text).toBe('local fixture')
    await rememberBackend(reenabled.pid)

    const restarted = await lifecycle('restart')
    expect(restarted.pid).not.toBe(ready.pid)
    const restartedOwner = await readSupervisorState(supervisorPaths(home, 'codex', profile))
    expect(restartedOwner).toMatchObject({ pid: restarted.pid, serviceCleanup: 'pending' })
    owners.set(restarted.pid, restartedOwner!.processStartedAt)
    expect(() => process.kill(ready.pid, 0)).toThrow(/ESRCH/)
    expect(() => process.kill(reenabled.pid, 0)).toThrow(/ESRCH/)
    const afterRestart = await response(restarted.modelApiUrl)
    expect(afterRestart.output_text).toBe('local fixture')
    await rememberBackend(afterRestart.pid)
    const streamAbort = new AbortController()
    try {
      const stream = await fetch(restarted.modelApiUrl + '/responses', {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: modelId, input: 'hold-open-fixture', stream: true }),
        signal: streamAbort.signal,
      })
      expect(stream.status).toBe(200)
      expect((await stream.body!.getReader().read()).done).toBe(false)
    } finally {
      streamAbort.abort()
    }
    await expect(lifecycle('stop')).resolves.toMatchObject({ status: 'stopped' })
    expect(() => process.kill(restarted.pid, 0)).toThrow(/ESRCH/)
    expect(() => process.kill(afterRestart.pid, 0)).toThrow(/ESRCH/)
    await expect(fetch(new URL('/healthz', restarted.modelApiUrl))).rejects.toThrow()
    await expect(fetch(`http://127.0.0.1:${afterRestart.port}/health`)).rejects.toThrow()
    await expect(readFile(bindingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await cmd('logs', ...scope)).toContain('service-ready')
    if (process.platform !== 'win32' && process.getuid?.() !== 0) {
      const failureOwner = await lifecycle('start')
      const ownerState = await readSupervisorState(supervisorPaths(home, 'codex', profile))
      expect(ownerState).toMatchObject({ pid: failureOwner.pid, serviceCleanup: 'pending' })
      owners.set(failureOwner.pid, ownerState!.processStartedAt)
      const failureBinding = JSON.parse(await readFile(bindingPath, 'utf8'))
      const failureKey = (await readFile(failureBinding.accessKeyFile, 'utf8')).trim()
      const failureResponse = await (await fetch(failureBinding.baseUrl + '/responses', {
        method: 'POST',
        headers: { authorization: `Bearer ${failureKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model: modelId, input: 'fixture only' }),
      })).json()
      await rememberBackend(failureResponse.pid)
      const serviceHome = path.join(home, 'managed-services', 'fixture-service', 'gateway')
      const generations = (await readdir(serviceHome, { withFileTypes: true })).filter(entry => entry.isDirectory())
      expect(generations).toHaveLength(1)
      restrictedDirectory = path.join(serviceHome, generations[0]!.name)
      await writeFile(path.join(restrictedDirectory, 'synthetic-cleanup-lock'), 'fixture')
      await chmod(restrictedDirectory, 0o500)
      await expect(lifecycle('stop')).rejects.toThrow(/service cleanup failed/i)
      expect(await readSupervisorState(supervisorPaths(home, 'codex', profile)))
        .toMatchObject({ phase: 'failed', serviceCleanup: 'failed' })
      expect(() => process.kill(failureOwner.pid, 0)).toThrow(/ESRCH/)
      expect(() => process.kill(failureResponse.pid, 0)).toThrow(/ESRCH/)
    }
  } finally {
    if (restrictedDirectory) await chmod(restrictedDirectory, 0o700).catch(() => undefined)
    const current = await readSupervisorState(supervisorPaths(home, 'codex', profile)).catch(() => undefined)
    if (current?.mode === 'service') owners.set(current.pid, current.processStartedAt)
    await lifecycle('stop').catch(() => undefined)
    for (const [pid, startedAt] of owners) {
      if (await processIdentityStatus(pid, startedAt) !== 'alive') continue
      const command = await run('/bin/ps', ['-p', String(pid), '-o', 'args=']).then(result => result.stdout).catch(() =>
        ''
      )
      if (!command.includes(cli) || !command.includes('service-owner')) {
        throw new Error('test service owner identity could not be confirmed')
      }
      process.kill(-pid, 'SIGKILL')
      await expect.poll(async () => await processIdentityStatus(pid, startedAt), { timeout: 2_000 }).toBe('dead')
    }
    for (const [pid, startedAt] of backends) {
      if (await processIdentityStatus(pid, startedAt) !== 'alive') continue
      const command = await run('/bin/ps', ['-p', String(pid), '-o', 'args=']).then(result => result.stdout).catch(() =>
        ''
      )
      if (command.includes(root + path.sep) && command.includes('/server.mjs ')) {
        process.kill(pid, 'SIGKILL')
        await expect.poll(async () => await processIdentityStatus(pid, startedAt), { timeout: 2_000 }).toBe('dead')
      }
    }
    await removeFixture(root)
  }
}, 90000)

it('reports a specific API bind conflict and recovers on the next start', async () => {
  const home = await mkdtemp('/tmp/cx-service-conflict-')
  const blocker = createServer()
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const port = (blocker.address() as { port: number }).port
  const env = { ...process.env, CORDISX_HOME: home, CORDISX_MODEL_API_PORT: String(port) }
  const cmd = async (action: string) =>
    (await run(process.execPath, [cli, action, ...scope], { env, timeout: 25000 })).stdout
  try {
    await expect(cmd('start')).rejects.toThrow(`Model API port 127.0.0.1:${port} is already in use`)
    const failed = JSON.parse(await cmd('status'))
    expect(failed).toMatchObject({ status: 'failed', pid: null, modelApiUrl: null })
    const owner = JSON.parse(await readFile(path.join(home, 'run', 'codex', profile, 'state.json'), 'utf8'))
    await expect.poll(() => {
      try {
        process.kill(owner.pid, 0)
        return true
      } catch {
        return false
      }
    }).toBe(false)
    await expect(readFile(path.join(home, 'run', 'model-api', profile, 'server.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
    await new Promise<void>(resolve => blocker.close(() => resolve()))
    expect(JSON.parse(await cmd('start'))).toMatchObject({
      status: 'ready',
      modelApiUrl: `http://127.0.0.1:${port}/v1`,
    })
  } finally {
    blocker.close()
    await cmd('stop').catch(() => undefined)
    await rm(home, { recursive: true, force: true })
  }
}, 60000)

it('removes the API listener and binding if managed package admission fails after the bind', async () => {
  const root = await mkdtemp('/tmp/cx-service-failed-admission-')
  const home = path.join(root, 'home')
  const blocker = createServer()
  await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const port = (blocker.address() as { port: number }).port
  await new Promise<void>(resolve => blocker.close(() => resolve()))
  const env = { ...process.env, CORDISX_HOME: home, CORDISX_MODEL_API_PORT: String(port) }
  const cmd = async (action: string) =>
    (await run(process.execPath, [cli, action, ...scope], { env, timeout: 25000 })).stdout
  try {
    await mkdir(home)
    await stageServiceModePlugin(root, home, profile, true, null)
    await expect(cmd('start')).rejects.toThrow('managed backend packages require a canonical HTTPS source')
    expect(JSON.parse(await cmd('status'))).toMatchObject({ status: 'failed', modelApiUrl: null })
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
    await expect(readFile(path.join(home, 'run', 'model-api', profile, 'server.json')))
      .rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await cmd('stop').catch(() => undefined)
    await removeFixture(root)
  }
}, 45000)
