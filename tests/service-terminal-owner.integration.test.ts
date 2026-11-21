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
    await expect(request({
      kind: 'terminal-provider',
      request: {
        kind: 'prepare',
        client: 'claude-code',
        providerId: 'fixture-provider',
        model: 'fixture-model',
      },
    })).rejects.toThrow('cannot supply Claude Code authentication')
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
