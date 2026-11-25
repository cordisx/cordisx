import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { request as requestHttps } from 'node:https'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { startPluginManagementRpcServer } from '../packages/cli/src/launcher/management-rpc.js'
import { openManagedConsoleBrowserGateway } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'
import { openPluginManagementService } from '../packages/cli/src/management/service.js'

const exec = promisify(execFile)

it.each(['reverse-proxy', 'direct-tls'] as const)(
  'starts a %s ingress with the existing owner and reuses it without changing deployment',
  async mode => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-deployment-cli-'))
    const gateways: Awaited<ReturnType<typeof openManagedConsoleBrowserGateway>>[] = []
    let service: Awaited<ReturnType<typeof openPluginManagementService>> | undefined
    let rpc: Awaited<ReturnType<typeof startPluginManagementRpcServer>> | undefined
    const entry = path.resolve('packages/cli/src/cli.ts')
    const run = async (...args: string[]) =>
      await exec(process.execPath, ['--import', 'tsx', entry, 'manager', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, CORDISX_HOME: home },
        timeout: 20_000,
      })
    try {
      const configPath = path.join(home, 'config.json')
      await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
      for (let index = 0; index < 2; index++) gateways.push(await openManagedConsoleBrowserGateway())
      service = await openPluginManagementService({ configPath, homeDir: home, appId: 'codex', profileId: 'default' })
      rpc = await startPluginManagementRpcServer({
        homeDir: home,
        appId: 'codex',
        profileId: 'default',
        configPath,
        generation: 'owner-1',
        processStartedAt: (await processStartIdentity(process.pid))!,
        service,
        managerConsoleOrigins: gateways.map(gateway => gateway.origin),
      })
      const reservation = createServer()
      await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
      const address = reservation.address()
      if (!address || typeof address === 'string') throw new Error('fixture listener unavailable')
      const port = address.port
      await new Promise<void>(resolve => reservation.close(() => resolve()))
      const scheme = mode === 'direct-tls' ? 'https' : 'http'
      const publicOrigin = scheme + '://manager.example.test:' + port
      const deployment = path.join(home, 'deployment.json')
      if (mode === 'direct-tls') {
        await exec('openssl', [
          'req',
          '-x509',
          '-newkey',
          'rsa:2048',
          '-nodes',
          '-days',
          '1',
          '-subj',
          '/CN=manager.example.test',
          '-keyout',
          path.join(home, 'key.pem'),
          '-out',
          path.join(home, 'cert.pem'),
        ], { timeout: 15_000 })
      }
      await writeFile(
        deployment,
        JSON.stringify({
          publicOrigin,
          consoleOrigins: { template: scheme + '://{view}.console-{slot}.example.test:' + port },
          listeners: [{ host: '127.0.0.1', port }],
          ...(mode === 'direct-tls' ? { tls: { certificateFile: 'cert.pem', privateKeyFile: 'key.pem' } } : {}),
        }),
        { mode: 0o600 },
      )
      expect(JSON.parse((await run('start', '--deployment', deployment)).stdout).status).toBe('running')
      const link = (await run('open', '--print-url')).stdout.trim().split(' ').at(-1)!
      expect(new URL(link).origin).toBe(publicOrigin)
      const result = await new Promise<{ status: number | undefined; policy: string | undefined }>(
        (resolve, reject) => {
          const outgoing = (mode === 'direct-tls' ? requestHttps : request)({
            hostname: '127.0.0.1',
            port,
            path: '/',
            headers: { host: new URL(publicOrigin).host },
            ...(mode === 'direct-tls' ? { rejectUnauthorized: false } : {}),
          }, response => {
            response.resume()
            response.on(
              'end',
              () => resolve({ status: response.statusCode, policy: response.headers['content-security-policy'] }),
            )
            response.on('error', reject)
          })
          outgoing.on('error', reject).end()
        },
      )
      expect(result.status).toBe(200)
      expect(result.policy).toContain(scheme + '://*.console-1.example.test:' + port)
      const other = path.join(home, 'other.json')
      await writeFile(
        other,
        JSON.stringify({
          publicOrigin: 'http://other.example.test:' + port,
          listeners: [{ host: '127.0.0.1', port }],
        }),
        { mode: 0o600 },
      )
      await expect(run('start', '--deployment', other)).rejects.toThrow()
      expect(JSON.parse((await run('status')).stdout).status).toBe('running')
      expect(JSON.parse((await run('stop')).stdout).status).toBe('stopped')
      expect((await service.query()).profileId).toBe('default')
    } finally {
      await run('stop').catch(() => undefined)
      await rpc?.close()
      service?.close()
      await Promise.all(gateways.map(async gateway => await gateway.close()))
      await rm(home, { recursive: true, force: true })
    }
  },
  45_000,
)
