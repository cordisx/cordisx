import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import {
  processIdentityStatus,
  processStartIdentity,
  readSupervisorState,
} from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import { openPluginManagementService } from '../packages/cli/src/management/service.js'

const exec = promisify(execFile)

it.skipIf(process.platform === 'win32')(
  'reopens a manager against a replacement owner without reusing the old browser session',
  async () => {
    const root = await mkdtemp('/tmp/cx-manager-reopen-')
    const homeDir = path.join(root, 'x')
    const userHome = path.join(root, 'h')
    const codexHome = path.join(root, 'c')
    const configPath = path.join(homeDir, 'config.json')
    const env = {
      PATH: process.env.PATH,
      HOME: userHome,
      CODEX_HOME: codexHome,
      CORDISX_HOME: homeDir,
      TMPDIR: root,
      LANG: 'en_US.UTF-8',
    }
    const cli = process.env.CORDISX_MANAGER_TEST_CLI ?? path.resolve('packages/cli/dist/src/cli.js')
    const run = async (...args: string[]) =>
      await exec(process.execPath, [cli, ...args], { cwd: root, env, timeout: 30_000 })
    const link = async () => new URL((await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!)
    const exchange = async (url: URL) => {
      const response = await fetch(`${url.origin}/api/session`, {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: url.hash.slice(1) }),
      })
      expect(response.status).toBe(200)
      return (await response.json() as { token: string }).token
    }
    let service: Awaited<ReturnType<typeof openPluginManagementService>> | undefined
    let rpc: Awaited<ReturnType<typeof startPluginManagementRpcServer>> | undefined
    let managerAttempted = false
    try {
      await Promise.all([homeDir, userHome, codexHome].map(directory => mkdir(directory, { mode: 0o700 })))
      await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
      service = await openPluginManagementService({ configPath, homeDir, appId: 'codex', profileId: 'default' })
      const startedAt = (await processStartIdentity(process.pid))!
      const owner = async (generation: string) =>
        await startPluginManagementRpcServer({
          homeDir,
          appId: 'codex',
          profileId: 'default',
          configPath,
          generation,
          processStartedAt: startedAt,
          service: service!,
        })
      rpc = await owner('old')
      managerAttempted = true
      const oldUrl = await link()
      const oldToken = await exchange(oldUrl)
      const paths = managerRendererGatewayPaths(homeDir, 'default')
      const oldManager = (await readSupervisorState(paths))!
      await rpc.close()
      rpc = undefined
      rpc = await owner('replacement')
      expect(await processIdentityStatus(oldManager.pid, oldManager.processStartedAt)).toBe('alive')

      const [first, second] = await Promise.allSettled([link(), link()])
      if (first.status !== 'fulfilled' || second.status !== 'fulfilled') {
        const failure = first.status === 'rejected' ? first.reason : second.status === 'rejected' ? second.reason : null
        const code = String((failure as { stderr?: unknown } | null)?.stderr ?? '').match(/MANAGER_[A-Z_]+/u)?.[0]
        throw new Error(`concurrent manager reopen failed: ${code ?? 'unknown'}`)
      }
      const [newUrl, secondUrl] = [first.value, second.value]
      const newManager = (await readSupervisorState(paths))!
      expect(newManager.pid === oldManager.pid && newManager.processStartedAt === oldManager.processStartedAt).toBe(
        false,
      )
      expect(secondUrl.origin).toBe(newUrl.origin)
      expect(secondUrl.hash === newUrl.hash).toBe(false)
      const oldSession = await fetch(`${newUrl.origin}/api/state`, {
        headers: { authorization: `Bearer ${oldToken}` },
      })
      expect(oldSession.status).toBe(401)
      const newToken = await exchange(newUrl)
      const newSession = await fetch(`${newUrl.origin}/api/state`, {
        headers: { authorization: `Bearer ${newToken}` },
      })
      expect(newSession.status).toBe(200)
      const secondToken = await exchange(secondUrl)
      expect(secondToken === newToken).toBe(false)
    } finally {
      let stopped = !managerAttempted
      if (managerAttempted) {
        await run('manager', 'stop', '--profile', 'default').catch(() => undefined)
        const status = await run('manager', 'status', '--profile', 'default')
          .then(value => JSON.parse(value.stdout) as { status?: string }, () => undefined)
        stopped = status?.status === 'stopped'
      }
      let ownerClosed = true
      await rpc?.close().catch(() => {
        ownerClosed = false
      })
      service?.close()
      if (stopped && ownerClosed) await rm(root, { recursive: true, force: true })
      else throw new Error('isolated manager shutdown was not confirmed')
    }
  },
  45_000,
)
