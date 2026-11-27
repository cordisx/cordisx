import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { OwnerAdapterClient } from '../packages/cli/src/cli/owner-adapter-client.js'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
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
    await mkdir(homeDir, { recursive: true, mode: 0o700 })
    await writeFile(
      path.join(homeDir, 'config.json'),
      JSON.stringify({
        ...createDefaultHomeConfig(),
        providers: [{
          id: 'fixture',
          kind: 'model-service',
          displayName: 'Fixture',
          baseUrl: 'https://fixture.invalid/v1',
          apiKeyEnv: 'FIXTURE_KEY',
          protocols: ['openai-responses'],
          models: { codex: ['fixture-model'] },
        }],
        environmentVariables: [{ name: 'FIXTURE_KEY', value: 'fixture-secret', enabled: true }],
      }),
      { mode: 0o600 },
    )
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
    const list = async () =>
      JSON.parse(
        (await run(process.execPath, [cli, 'models', 'services', 'list'], {
          cwd: root,
          env,
          timeout: 30_000,
        })).stdout,
      )
    const ownerServices = await list()
    expect(ownerServices).toMatchObject({ status: 'ok', services: [{ id: 'fixture', keyConfigured: true }] })
    expect(JSON.stringify(ownerServices)).not.toContain('fixture-secret')
    expect(await first.modelServicesRead()).toEqual({
      status: 'ok',
      revision: ownerServices.revision,
      services: ownerServices.services,
    })
    const updatePath = path.join(root, 'model-services-update.json')
    await writeFile(
      updatePath,
      JSON.stringify({
        expectedRevision: ownerServices.revision,
        services: [{
          id: 'fixture',
          displayName: 'Updated fixture',
          baseUrl: 'https://fixture.invalid/v1',
          protocols: ['openai-responses'],
          codexModels: ['fixture-model'],
          claudeModels: [],
          enabled: true,
        }],
      }),
      { mode: 0o600 },
    )
    await run(process.execPath, [cli, 'models', 'services', 'save', '--input-file', updatePath], {
      cwd: root,
      env,
      timeout: 30_000,
    })
    const updated = await list()
    expect(updated.revision).not.toBe(ownerServices.revision)
    expect(updated.services).toMatchObject([{ id: 'fixture', displayName: 'Updated fixture', keyConfigured: true }])
    expect(await second.modelServicesRead()).toEqual({
      status: 'ok',
      revision: updated.revision,
      services: updated.services,
    })
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
