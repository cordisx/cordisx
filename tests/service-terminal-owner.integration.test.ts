import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

const run = promisify(execFile)

it('publishes live plugin leases from the production service owner without a Desktop', async () => {
  const root = await mkdtemp('/tmp/cx-service-terminal-owner-')
  const cordisxHome = path.join(root, 'cordisx')
  const cli = path.resolve('packages/cli/dist/src/cli.js')
  const profile = 'service-fixture'
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('CORDISX_')),
  )
  env.CORDISX_HOME = cordisxHome
  env.CORDISX_MODEL_API_PORT = '0'
  const command = async (action: string) =>
    await run(process.execPath, [
      cli,
      action,
      '--mode',
      'service',
      'codex',
      profile,
      '--json',
    ], { env, cwd: root, timeout: 30000 })
  try {
    await mkdir(cordisxHome)
    await stageServiceModePlugin(root, cordisxHome, profile, true)
    expect(JSON.parse((await command('start')).stdout)).toMatchObject({ status: 'ready', mode: 'service' })
    const paths = pluginManagementRpcPaths(cordisxHome, 'codex', profile)
    const endpoint = (await readPluginManagementRpcEndpoint(paths))!
    const request = (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
      requestPluginManagementRpc(paths, endpoint, operation)
    const list = await request({ kind: 'terminal-provider', request: { kind: 'list' } })
    expect(list).toMatchObject({ kind: 'list', providers: [{ providerId: 'fixture-provider', managed: true }] })
    const prepare = () =>
      request({
        kind: 'terminal-provider',
        request: { kind: 'prepare', providerId: 'fixture-provider', model: 'fixture-model' },
      }) as Promise<{ kind: string; leaseId: string }>
    const [first, second] = await Promise.all([prepare(), prepare()])
    expect(first.kind).toBe('prepared')
    expect(first.leaseId).not.toBe(second.leaseId)
    expect(JSON.stringify([first, second])).not.toContain('SERVICE_TOKEN')
    await request({ kind: 'terminal-provider', request: { kind: 'release', leaseId: first.leaseId } })
    expect(await request({ kind: 'terminal-provider', request: { kind: 'renew', leaseId: second.leaseId } }))
      .toEqual({ kind: 'renewed' })
    const claude = await request({
      kind: 'terminal-provider',
      request: {
        kind: 'prepare',
        client: 'claude-code',
        providerId: 'fixture-provider',
        model: 'fixture-model',
      },
    }) as { kind: string; leaseId: string; anthropicBaseUrl: string }
    expect(claude).toMatchObject({
      kind: 'prepared',
      anthropicBaseUrl: expect.stringMatching(/^http:\/\/127\.0\.0\.1:/u),
    })
    expect(claude.leaseId).not.toBe(second.leaseId)
    const disable = async () => {
      const plan = await request({
        kind: 'plan',
        request: { kind: 'plugin-disable', pluginId: 'fixture-service' },
      }) as { status: string; executionRequest?: { kind: 'plugin-execute-plan'; executionToken: string } }
      expect(plan.status).toBe('planned')
      if (!plan.executionRequest) throw new Error('Missing fixture execution plan')
      return await request({ kind: 'execute', request: plan.executionRequest }) as {
        status: string
        error?: { code: string; message: string }
      }
    }
    expect(await disable()).toMatchObject({
      status: 'rejected',
      error: { code: 'operation-unavailable', message: expect.stringContaining('Terminal sessions') },
    })
    expect(await request({ kind: 'terminal-provider', request: { kind: 'renew', leaseId: second.leaseId } }))
      .toEqual({ kind: 'renewed' })
    expect(await request({ kind: 'terminal-provider', request: { kind: 'renew', leaseId: claude.leaseId } }))
      .toEqual({ kind: 'renewed' })
    await request({ kind: 'terminal-provider', request: { kind: 'release', leaseId: claude.leaseId } })
    expect((await disable()).status).not.toBe('applied')
    expect(await request({ kind: 'terminal-provider', request: { kind: 'renew', leaseId: second.leaseId } }))
      .toEqual({ kind: 'renewed' })
    await request({ kind: 'terminal-provider', request: { kind: 'release', leaseId: second.leaseId } })
    expect((await disable()).status).toBe('applied')
  } finally {
    await command('stop').catch(() => undefined)
    const allowRemoval = async (directory: string) => {
      await chmod(directory, 0o700)
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.isDirectory()) await allowRemoval(path.join(directory, entry.name))
      }
    }
    await allowRemoval(root)
    await rm(root, { recursive: true, force: true })
  }
}, 90000)
