import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { connect, createServer as createSocketServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { managerOwnerIsLocal, openManagerOwner } from '../packages/cli/src/cli/manager-owner.js'
import { startManagerWeb } from '../packages/cli/src/cli/manager-web.js'
import {
  createManagerEntry,
  recoverManagerEntries,
  validateManagerEntry,
} from '../packages/cli/src/cli/manager-entry.js'
import { managerChildEnvironment, terminateCreatedManagerChild } from '../packages/cli/src/cli/manager-supervisor.js'
import { openManagerBrowser } from '../packages/cli/src/cli/manager-command.js'
import { parseCordisXCli } from '../packages/cli/src/cli/parse.js'
import { processStartIdentity } from '../packages/cli/src/cli/supervisor-state.js'
import { createCodexModelServices } from '../packages/cli/src/launcher/codex-model-services.js'
import { createManagerChannelCredentials } from '../packages/cli/src/cli/manager-channel-credentials-composition.js'
import {
  requestPluginManagementRpc,
  startPluginManagementRpcServer,
} from '../packages/cli/src/launcher/management-rpc.js'
import { openPluginManagementService } from '../packages/cli/src/management/service.js'

const exec = promisify(execFile)

describe('independent manager production boundaries', () => {
  it('never forwards model-service saves to an older owner without the safe-write handshake', async () => {
    let writes = 0
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-old-owner-'))
    const configPath = path.join(home, 'config.json')
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    const service = await openPluginManagementService({
      configPath,
      homeDir: home,
      appId: 'codex',
      profileId: 'default',
    })
    const processStartedAt = (await processStartIdentity(process.pid))!
    const start = async (generation: string) =>
      await startPluginManagementRpcServer({
        homeDir: home,
        appId: 'codex',
        profileId: 'default',
        configPath,
        generation,
        processStartedAt,
        service,
        codex: async operation => {
          if (operation === 'model-services:read') return { status: 'ok', revision: 'old', services: [] }
          if (operation === 'model-services:save') {
            writes++
            return { status: 'applied' }
          }
          return { status: 'unavailable' }
        },
      })
    let rpc = await start('old')
    const owner = await openManagerOwner('default', { CORDISX_HOME: home })
    const web = await startManagerWeb(owner)
    try {
      const url = new URL(web.url)
      const session = await fetch(`${url.origin}/api/session`, {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/json' },
        body: JSON.stringify({ token: url.hash.slice(1) }),
      })
      const { token } = await session.json() as { token: string }
      const response = await fetch(`${url.origin}/api/model-services`, {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ expectedRevision: 'old', services: [] }),
      })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({ error: 'MODEL_SERVICE_SAFE_WRITE_UNAVAILABLE' })
      expect(writes).toBe(0)
      await rpc.close()
      rpc = await start('replacement')
      await expect(owner.request({ kind: 'codex', operation: 'model-services:save', input: {} }))
        .rejects.toThrow('MANAGER_OWNER_CHANGED')
      expect(writes).toBe(0)
    } finally {
      await web.close()
      await rpc.close()
      service.close()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('does not expose Channel writes without a verified profile owner', () => {
    const input = {
      plugin: { id: 'channel', enabled: true, package: { version: '1', moduleGeneration: 'g', digest: 'sha256:test' } },
      service: {},
      lifecycle: {},
      configPath: '/fixture/config.json',
      profileId: 'default',
      generation: 'g',
    } as unknown as Parameters<typeof createManagerChannelCredentials>[0]
    expect(createManagerChannelCredentials(input)).toBeUndefined()
  })

  it('bounds cleanup calls when an owner accepts a connection but never responds', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-timeout-'))
    const socketPath = path.join(directory, 'owner.sock')
    const server = createSocketServer(socket => {
      socket.on('data', () => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(socketPath, resolve)
    })
    try {
      await expect(requestPluginManagementRpc(
        { socket: socketPath } as Parameters<typeof requestPluginManagementRpc>[0],
        { token: 'test', profileId: 'fixture' } as Parameters<typeof requestPluginManagementRpc>[1],
        { kind: 'query' },
        { timeoutMs: 25 },
      )).rejects.toThrow('timed out')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('scopes managed-service authentication to server-generated browser sessions and retires evictions', async () => {
    const operations: Array<Record<string, unknown>> = []
    const web = await startManagerWeb(
      {
        appId: 'codex',
        profileId: 'fixture',
        generation: 'generation',
        isCurrent: async () => true,
        request: async (operation: Record<string, unknown>) => {
          operations.push(operation)
          return operation.action === 'retire' ? { status: 'retired' } : { status: 'available', services: [] }
        },
      } as unknown as Parameters<typeof startManagerWeb>[0],
    )
    const origin = new URL(web.url).origin
    const post = async (route: string, value: unknown, token?: string) =>
      await fetch(`${origin}${route}`, {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(value),
      })
    const exchange = async (url: string) => {
      const response = await post('/api/session', { token: new URL(url).hash.slice(1) })
      return (await response.json() as { token: string }).token
    }
    try {
      const first = await exchange(web.url)
      expect((await post('/api/managed-services', { action: 'list', sessionId: 'forged' }, first)).status).toBe(400)
      expect(await (await post('/api/managed-services', { action: 'list' }, first)).json())
        .toEqual({ status: 'available', services: [] })
      const sessionId = operations[0]!.sessionId
      expect(sessionId).toMatch(/^[a-f0-9]{64}$/u)
      expect(sessionId).not.toBe(first)
      expect((await post('/api/channel-credentials', { action: 'view', sessionId: 'forged' }, first)).status).toBe(400)
      const captured = await post('/api/channel-credentials', {
        action: 'capture',
        purpose: 'create',
        expectedRevision: 1,
        serviceGeneration: 'generation',
        account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: '' },
        secret: 'test-only-secret',
      }, first)
      expect(captured.status).toBe(200)
      expect(await captured.text()).not.toContain('test-only-secret')
      expect(operations.at(-1)).toMatchObject({ kind: 'manager-channel-credentials', action: 'capture', sessionId })
      const toggled = await post('/api/channel-credentials', {
        action: 'set-enabled',
        enabled: false,
        expectedRevision: 1,
        serviceGeneration: 'generation',
        account: { adapterId: 'feishu', accountId: 'cli_fixture', tenantId: 'tenant' },
      }, first)
      expect(toggled.status).toBe(200)
      expect(operations.at(-1)).toMatchObject({ kind: 'manager-channel-credentials', action: 'set-enabled', sessionId })
      let last = ''
      for (let index = 0; index < 16; index++) last = await exchange(web.issueUrl())
      expect(operations).toContainEqual({ kind: 'manager-service-auth', action: 'retire', sessionId })
      expect(operations).toContainEqual({ kind: 'manager-channel-credentials', action: 'retire', sessionId })
      expect((await post('/api/managed-services', { action: 'list' }, first)).status).toBe(401)
      expect((await post('/api/managed-services', { action: 'list' }, last)).status).toBe(200)
      const lastId = operations.at(-1)!.sessionId
      await web.close()
      expect(operations).toContainEqual({ kind: 'manager-service-auth', action: 'retire', sessionId: lastId })
    } finally {
      await web.close().catch(() => undefined)
    }
  })

  it('keeps credentials out of the child and fences PID reuse', async () => {
    const environment = managerChildEnvironment({
      HOME: '/user',
      PATH: '/bin',
      CORDISX_HOME: '/user/.cordisx',
      MODEL_API_KEY: 'fixture-secret',
      CODEX_THREAD_ID: 'fixture-thread',
      NODE_OPTIONS: 'untrusted',
    }, 'bootstrap')
    expect(environment).toEqual({
      HOME: '/user',
      PATH: '/bin',
      CORDISX_HOME: '/user/.cordisx',
      CORDISX_MANAGER_CHILD_KEY: 'bootstrap',
    })
    const kill = vi.fn(() => true)
    const child = { pid: 42, exitCode: null, signalCode: null, kill }
    expect(await terminateCreatedManagerChild(child, undefined, async () => 'alive')).toBe(false)
    expect(await terminateCreatedManagerChild(child, 'old-start', async () => 'dead')).toBe(false)
    expect(await terminateCreatedManagerChild(child, 'old-start', async () => 'unknown')).toBe(false)
    expect(kill).not.toHaveBeenCalled()
    expect(await terminateCreatedManagerChild(child, 'actual-start', async () => 'alive')).toBe(true)
    expect(kill).toHaveBeenCalledOnce()
    expect(parseCordisXCli(['start', 'manager'])).toMatchObject({ action: 'start', app: 'manager' })
    const identify = vi.fn(async () => 'alive' as const)
    const endpoint = { pid: 42, processStartedAt: 'fixture' } as Parameters<typeof managerOwnerIsLocal>[0]
    expect(await managerOwnerIsLocal(endpoint, async () => true, identify)).toBe(false)
    expect(identify).not.toHaveBeenCalled()
    expect(await managerOwnerIsLocal(endpoint, async () => false, identify)).toBe(true)
    const launch = vi.fn(async () => undefined)
    await openManagerBrowser('/private/目录 # %/entry.html', 'darwin', launch)
    expect(launch).toHaveBeenCalledWith('open', ['/private/目录 # %/entry.html'])
    expect(JSON.stringify(launch.mock.calls)).not.toContain('127.0.0.1')
    await expect(openManagerBrowser('/private/entry.html', 'win32', launch)).rejects.toThrow('BROWSER_OPEN_UNAVAILABLE')
  })

  it('uses one owner, protects bootstrap and mutations, and saves model keys write-only', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-integration-'))
    const configPath = path.join(home, 'config.json')
    await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
    const service = await openPluginManagementService({
      configPath,
      homeDir: home,
      appId: 'codex',
      profileId: 'default',
    })
    const modelServices = createCodexModelServices({ configPath, environment: {} })
    const started = await processStartIdentity(process.pid)
    expect(started).toBeDefined()
    const rpc = await startPluginManagementRpcServer({
      homeDir: home,
      appId: 'codex',
      profileId: 'default',
      configPath,
      generation: 'test-generation',
      processStartedAt: started!,
      service,
      codex: async (operation, value) =>
        operation === 'model-services:read'
          ? await modelServices('read', value)
          : operation === 'model-services:save'
          ? await modelServices('save', value)
          : { status: 'unavailable' },
    })
    const owner = await openManagerOwner('default', { CORDISX_HOME: home })
    const web = await startManagerWeb(owner)
    const url = new URL(web.url), origin = url.origin, bootstrap = url.hash.slice(1)
    const post = (route: string, value: unknown, session?: string, source = origin) =>
      fetch(`${origin}${route}`, {
        method: 'POST',
        headers: {
          origin: source,
          'content-type': 'application/json',
          ...(session ? { authorization: `Bearer ${session}` } : {}),
        },
        body: JSON.stringify(value),
      })
    try {
      const index = await fetch(origin)
      expect(index.status).toBe(200)
      const indexHtml = await index.text()
      expect(indexHtml).toContain('/manager-standalone.js')
      expect(indexHtml).not.toContain('/manager.js')
      const previousHostEntry = await fetch(`${origin}/?host=1`)
      expect(await previousHostEntry.text()).toBe(indexHtml)
      const malformed = await new Promise<string>((resolve, reject) => {
        const socket = connect(Number(url.port), '127.0.0.1', () => {
          socket.write(`GET http://[ HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`)
        })
        let data = ''
        socket.on('data', chunk => {
          data += chunk.toString()
        })
        socket.on('end', () => resolve(data))
        socket.on('error', reject)
      })
      expect(malformed).toContain('400 Bad Request')
      expect(malformed).not.toContain('http://[')
      expect((await fetch(origin)).status).toBe(200)
      expect((await fetch(`${origin}/manager.js`)).status).toBe(200)
      expect((await fetch(`${origin}/manager-channel-ui.js`)).status).toBe(200)
      expect((await fetch(`${origin}/api/state`)).status).toBe(401)
      const entries = path.join(home, '目录 # %', 'entries')
      const entry = await createManagerEntry(entries, web)
      expect((await lstat(entries)).mode & 0o777).toBe(0o700)
      expect((await lstat(entry)).mode & 0o777).toBe(0o600)
      expect(await validateManagerEntry(entry, entries)).toBe(true)
      const html = await readFile(entry, 'utf8')
      const redirect = /location\.replace\("(http:\/\/127\.0\.0\.1:\d+\/#\w+)"\)/u.exec(html)?.[1]
      expect(redirect).toBeDefined()
      const privateUrl = new URL(redirect!)
      const entryExchange = await post('/api/session', { token: privateUrl.hash.slice(1) })
      expect(entryExchange.status).toBe(200)
      expect(await lstat(entry).then(() => true, () => false)).toBe(false)
      const secondEntry = await createManagerEntry(entries, web)
      expect(await lstat(secondEntry).then(() => true, () => false)).toBe(true)
      const secondHtml = await readFile(secondEntry, 'utf8')
      const secondLink = /location\.replace\("(http:\/\/127\.0\.0\.1:\d+\/#\w+)"\)/u.exec(secondHtml)?.[1]
      await web.revokeUrl(secondLink!)
      expect(await lstat(secondEntry).then(() => true, () => false)).toBe(false)
      const staleEntry = path.join(entries, `${'b'.repeat(32)}.html`)
      await writeFile(staleEntry, 'stale fixture', { mode: 0o600 })
      await recoverManagerEntries(entries)
      expect(await lstat(staleEntry).then(() => true, () => false)).toBe(false)
      expect((await post('/api/session', { token: bootstrap }, undefined, 'https://attacker.example')).status).toBe(403)
      const exchange = await post('/api/session', { token: bootstrap })
      expect(exchange.status).toBe(200)
      const { token } = await exchange.json() as { token: string }
      expect(token).not.toEqual(bootstrap)
      expect((await post('/api/session', { token: bootstrap })).status).toBe(401)
      expect((await post('/api/model-services', {}, token, 'https://attacker.example')).status).toBe(403)
      const read = async () =>
        await (await fetch(`${origin}/api/state`, {
          headers: { authorization: `Bearer ${token}` },
        })).json() as { services: { revision: string; services: Array<Record<string, unknown>> } }
      const model = {
        id: 'sample',
        displayName: 'Sample',
        baseUrl: 'https://example.com/v1',
        protocols: ['openai-responses'],
        codexModels: ['model-a'],
        claudeModels: ['model-b'],
        enabled: true,
      }
      const first = await read()
      const saved = await post('/api/model-services', {
        expectedRevision: first.services.revision,
        services: [{ ...model, apiKey: 'fixture-only-secret' }],
      }, token)
      expect(await saved.json()).toMatchObject({ status: 'applied', applies: 'app-restart' })
      const added = await read()
      expect(added.services.services).toEqual([expect.objectContaining({
        id: 'sample',
        keyConfigured: true,
        codexModels: ['model-a'],
        claudeModels: ['model-b'],
      })])
      expect(JSON.stringify(added)).not.toContain('fixture-only-secret')
      const edited = await post('/api/model-services', {
        expectedRevision: added.services.revision,
        services: [{ ...model, displayName: 'Renamed' }],
      }, token)
      expect(await edited.json()).toMatchObject({ status: 'applied' })
      const updated = await read()
      expect(updated.services.services[0]).toMatchObject({ displayName: 'Renamed', keyConfigured: true })
      const deleted = await post(
        '/api/model-services',
        { expectedRevision: updated.services.revision, services: [] },
        token,
      )
      expect(await deleted.json()).toMatchObject({ status: 'applied' })
      expect((await read()).services.services).toEqual([])
      // A plugin may still use the shared environment variable after deletion.
      expect(await readFile(configPath, 'utf8')).toContain('fixture-only-secret')
      const sourcePlan = await post('/api/management', {
        kind: 'plan',
        request: { kind: 'source-add', source: { url: 'https://example.com/catalog.json', enabled: true } },
      }, token)
      const planned = await sourcePlan.json() as { status: string; request: unknown; snapshot: { revision: number } }
      expect(planned.status).toBe('planned')
      const sourceSave = await post('/api/management', {
        kind: 'execute',
        request: planned.request,
        expectedRevision: planned.snapshot.revision,
      }, token)
      expect(await sourceSave.json()).toMatchObject({ status: 'applied' })
    } finally {
      await web.close()
      await rpc.close()
      service.close()
      await rm(home, { recursive: true, force: true })
    }
  })

  it('coalesces concurrent CLI starts and stops only the manager sidecar', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-sidecar-'))
    const configPath = path.join(home, 'config.json')
    const config = createDefaultHomeConfig()
    await writeFile(configPath, JSON.stringify({ ...config, apps: { ...config.apps, manager: config.apps.codex } }), {
      mode: 0o600,
    })
    const futureAdapterDir = path.join(home, 'run', 'manager', 'default')
    await mkdir(futureAdapterDir, { recursive: true })
    await writeFile(path.join(futureAdapterDir, 'state.json'), 'future-adapter-state')
    const service = await openPluginManagementService({
      configPath,
      homeDir: home,
      appId: 'codex',
      profileId: 'default',
    })
    const started = await processStartIdentity(process.pid)
    expect(started).toBeDefined()
    const rpc = await startPluginManagementRpcServer({
      homeDir: home,
      appId: 'codex',
      profileId: 'default',
      configPath,
      generation: 'test-generation',
      processStartedAt: started!,
      service,
    })
    const entry = path.resolve('packages/cli/src/cli.ts')
    const run = async (...args: string[]) =>
      await exec(process.execPath, ['--import', 'tsx', entry, 'manager', ...args], {
        cwd: process.cwd(),
        env: { ...process.env, CORDISX_HOME: home },
        timeout: 20_000,
      })
    try {
      const starts = await Promise.all([run('start'), run('start')])
      expect(starts.map(result => JSON.parse(result.stdout).status)).toEqual(['running', 'running'])
      expect(JSON.parse((await run('status')).stdout)).toEqual({ status: 'running', profile: 'default' })
      const first = (await run('open', '--print-url')).stdout.trim().split(' ').at(-1)!
      const second = (await run('open', '--print-url')).stdout.trim().split(' ').at(-1)!
      expect(new URL(first).origin).toEqual(new URL(second).origin)
      expect(new URL(first).hash).not.toEqual(new URL(second).hash)
      expect(JSON.parse((await run('stop')).stdout)).toEqual({ status: 'stopped' })
      expect(JSON.parse((await run('status')).stdout)).toEqual({ status: 'stopped', profile: 'default' })
      expect(await readFile(path.join(futureAdapterDir, 'state.json'), 'utf8')).toBe('future-adapter-state')
      expect((await service.query()).profileId).toEqual('default')
      expect((await openManagerOwner('default', { CORDISX_HOME: home })).appId).toEqual('codex')
    } finally {
      await run('stop').catch(() => undefined)
      await rpc.close()
      service.close()
      await rm(home, { recursive: true, force: true })
    }
  }, 45_000)
})
