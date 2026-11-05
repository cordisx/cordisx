import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

const run = promisify(execFile)
const cli = path.resolve('packages/cli/dist/src/cli.js')
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
  const root = await mkdtemp('/tmp/cx-service-test-')
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
      agents: 'unavailable',
    })
    expect(reused.pid).toBe(ready.pid)
    expect(await lifecycle('status')).toMatchObject({ pid: ready.pid, modelApiUrl: ready.modelApiUrl })
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

    const restarted = await lifecycle('restart')
    expect(restarted.pid).not.toBe(ready.pid)
    expect(() => process.kill(ready.pid, 0)).toThrow(/ESRCH/)
    expect(() => process.kill(reenabled.pid, 0)).toThrow(/ESRCH/)
    const afterRestart = await response(restarted.modelApiUrl)
    expect(afterRestart.output_text).toBe('local fixture')
    await expect(lifecycle('stop')).resolves.toMatchObject({ status: 'stopped' })
    expect(() => process.kill(restarted.pid, 0)).toThrow(/ESRCH/)
    expect(() => process.kill(afterRestart.pid, 0)).toThrow(/ESRCH/)
    await expect(fetch(new URL('/healthz', restarted.modelApiUrl))).rejects.toThrow()
    await expect(fetch(`http://127.0.0.1:${afterRestart.port}/health`)).rejects.toThrow()
    await expect(readFile(bindingPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await cmd('logs', ...scope)).toContain('service-ready')
  } finally {
    await lifecycle('stop').catch(() => undefined)
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
