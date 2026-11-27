import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { OwnerAdapterClient } from '../packages/cli/src/cli/owner-adapter-client.js'
import { assertOwnedServicesStopped, captureOwnedService } from './fixtures/owned-service-cleanup.js'

const run = promisify(execFile)
const cli = path.resolve('packages/cli/dist/src/cli.js')

it('admits independent adapter sessions through one production service owner', async () => {
  const root = await mkdtemp('/tmp/cx-service-adapter-')
  const homeDir = path.join(root, 'home')
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CORDISX_')),
  )
  Object.assign(env, {
    HOME: root,
    CODEX_HOME: path.join(root, 'codex'),
    CORDISX_HOME: homeDir,
    CORDISX_MODEL_API_PORT: '0',
    CORDISX_WEB_ENABLED: '0',
    CORDISX_EXPERIMENTAL_SERVICE_NATIVE_ADAPTER: '1',
  })
  const command = async (action: string) =>
    JSON.parse(
      (await run(
        process.execPath,
        [cli, action, '--mode', 'service', '--json'],
        { cwd: root, env, timeout: 60_000 },
      )).stdout,
    )
  const clientCommand = async (action: string) =>
    JSON.parse(
      (await run(
        process.execPath,
        [cli, action, 'codex', '--json'],
        { cwd: root, env, timeout: 60_000 },
      )).stdout,
    )
  const owners: Awaited<ReturnType<typeof captureOwnedService>>[] = []
  let requested = false
  let first: OwnerAdapterClient | undefined
  let second: OwnerAdapterClient | undefined
  try {
    requested = true
    const ready = await command('start')
    owners.push(await captureOwnedService(homeDir))
    expect(ready).toMatchObject({ mode: 'service', status: 'ready', webStatus: 'disabled' })
    expect(await clientCommand('status')).toMatchObject({ status: 'stopped' })
    expect(await clientCommand('stop')).toMatchObject({ status: 'stopped' })
    expect(await command('status')).toMatchObject({ status: 'ready', pid: ready.pid })
    const lost = vi.fn()
    first = await OwnerAdapterClient.connect({ homeDir, appId: 'codex', profileId: 'default', onLost: lost })
    second = await OwnerAdapterClient.connect({ homeDir, appId: 'codex', profileId: 'default', onLost: lost })
    const handle = async (command: { payload: unknown }) => ({ ok: true as const, value: command.payload })
    expect(await first.admit(handle)).toBe(true)
    expect(await second.admit(handle)).toBe(true)
    expect(first.snapshot).toEqual(second.snapshot)
    await first.close()
    expect(await command('status')).toMatchObject({ status: 'ready', pid: ready.pid })
    expect(await command('stop')).toMatchObject({ status: 'stopped' })
    await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce(), { timeout: 10_000 })
  } finally {
    await first?.close()
    await second?.close()
    if (owners.length > 0) await command('stop').catch(() => undefined)
    await assertOwnedServicesStopped(homeDir, owners, requested)
    await rm(root, { recursive: true, force: true })
  }
}, 120_000)
