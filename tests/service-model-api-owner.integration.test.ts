import { execFile } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { stageServiceModePlugin } from './fixtures/service-mode-plugin.js'

const run = promisify(execFile)

it('keeps a model API request alive until the affected plugin can be changed', async () => {
  const root = await mkdtemp('/tmp/cx-service-model-api-owner-')
  const home = path.join(root, 'cordisx')
  const cli = path.resolve('packages/cli/dist/src/cli.js')
  const profile = 'service-fixture'
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: root,
    CORDISX_HOME: home,
    CORDISX_MODEL_API_PORT: '0',
  }
  const command = async (action: string) =>
    await run(process.execPath, [cli, action, '--mode', 'service', 'codex', profile, '--json'], {
      env,
      cwd: root,
      timeout: 30_000,
    })
  const abort = new AbortController()
  try {
    await mkdir(home)
    await stageServiceModePlugin(root, home, profile, true)
    await stageServiceModePlugin(root, home, profile, false)
    const started = JSON.parse((await command('start')).stdout) as { status: string; modelApiUrl: string }
    expect(started.status).toBe('ready')
    const key = (await readFile(path.join(home, 'run', 'model-api', profile, 'access-key'), 'utf8')).trim()
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const response = await fetch(started.modelApiUrl + '/responses', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: 'fixture-provider::fixture-model', input: 'hold-open-fixture', stream: true }),
      signal: abort.signal,
    })
    expect(response.status).toBe(200)
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('fixture-ready')

    const paths = pluginManagementRpcPaths(home, 'codex', profile)
    const endpoint = (await readPluginManagementRpcEndpoint(paths))!
    const request = (operation: Parameters<typeof requestPluginManagementRpc>[2]) =>
      requestPluginManagementRpc(paths, endpoint, operation)
    const disable = async (pluginId: string) => {
      const plan = await request({ kind: 'plan', request: { kind: 'plugin-disable', pluginId } }) as {
        status: string
        executionRequest?: { kind: 'plugin-execute-plan'; executionToken: string }
      }
      expect(plan.status).toBe('planned')
      if (!plan.executionRequest) throw new Error('Missing fixture execution plan')
      return await request({ kind: 'execute', request: plan.executionRequest }) as {
        status: string
        error?: { code: string; message: string }
      }
    }
    expect((await disable('fixture-desktop')).status).toBe('applied')
    expect(await disable('fixture-service')).toMatchObject({
      status: 'rejected',
      error: { code: 'operation-unavailable', message: expect.stringContaining('Model API') },
    })
    abort.abort()
    await reader.cancel().catch(() => undefined)
    await vi.waitFor(async () => expect((await disable('fixture-service')).status).toBe('applied'), { timeout: 10_000 })
  } finally {
    abort.abort()
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
}, 90_000)
