import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { managerChildEnvironment } from '../packages/cli/src/cli/manager-supervisor.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { assertOwnedServicesStopped, captureOwnedService } from './fixtures/owned-service-cleanup.js'

const exec = promisify(execFile)

it('starts and retires the configured Web ingress with the service owner', async () => {
  const home = await mkdtemp('/tmp/cx-service-web-deployment-')
  const env = managerChildEnvironment(process.env, 'unused')
  delete env.CORDISX_MANAGER_CHILD_KEY
  const cli = path.resolve('packages/cli/dist/src/cli.js')
  const reservation = createServer()
  await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const address = reservation.address()
  if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
  const origin = `http://127.0.0.1:${address.port}`
  await new Promise<void>(resolve => reservation.close(() => resolve()))
  const deployment = path.join(home, 'web-deployment.json')
  Object.assign(env, {
    HOME: home,
    CODEX_HOME: path.join(home, 'codex'),
    CORDISX_HOME: home,
    CORDISX_MODEL_API_PORT: '0',
    CORDISX_WEB_DEPLOYMENT: deployment,
  })
  const run = async (...args: string[]) => await exec(process.execPath, [cli, ...args], { env, timeout: 30_000 })
  let startupRequested = false
  const owners: Awaited<ReturnType<typeof captureOwnedService>>[] = []
  try {
    await writeFile(path.join(home, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    await writeFile(
      deployment,
      JSON.stringify({
        publicOrigin: origin,
        listeners: [{ host: '127.0.0.1', port: address.port }],
      }),
      { mode: 0o600 },
    )
    startupRequested = true
    const started = JSON.parse((await run('start', '--mode', 'service', '--json')).stdout)
    owners.push(await captureOwnedService(home))
    expect(started).toMatchObject({ status: 'ready', mode: 'service', webStatus: 'ready', webOrigin: origin })
    expect((await fetch(origin)).status).toBe(200)
    expect((await fetch(`${origin}/api/state`)).status).toBe(401)
    expect((await fetch(`${origin}/api/state`, { headers: { origin: 'http://example.test' } })).status).toBe(403)

    // An explicit request for the already-selected deployment reuses the
    // service-owned listener; it does not start another gateway process.
    expect(JSON.parse((await run('manager', 'start', '--deployment', deployment)).stdout))
      .toMatchObject({ status: 'running' })
    const link = (await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!
    expect(new URL(link).origin).toBe(origin)
    await run('stop', '--mode', 'service', '--json')
    await expect(fetch(origin)).rejects.toThrow()

    env.CORDISX_WEB_ENABLED = '0'
    const headless = JSON.parse((await run('start', '--mode', 'service', '--json')).stdout)
    owners.push(await captureOwnedService(home))
    expect(headless).toMatchObject({ status: 'ready', mode: 'service', webStatus: 'disabled' })
    expect(headless.webOrigin).toBeUndefined()
    expect(JSON.parse((await run('manager', 'status')).stdout)).toMatchObject({ status: 'stopped' })
    await expect(run('manager', 'open', '--print-url')).rejects.toMatchObject({
      stderr: expect.stringContaining('MANAGER_SERVICE_WEB_DISABLED'),
    })
    await run('stop', '--mode', 'service', '--json')
  } finally {
    await run('stop', '--mode', 'service', '--json').catch(() => undefined)
    await assertOwnedServicesStopped(home, owners, startupRequested)
    await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  }
}, 120_000)
