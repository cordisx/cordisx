import { execFile } from 'node:child_process'
import { generateKeyPairSync, randomBytes } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { managerChildEnvironment } from '../packages/cli/src/cli/manager-supervisor.js'
import { installIndependentHostBindings } from '../packages/cli/src/independent-manager/host-bindings.js'
import { BrowserPluginManagementBinding } from '../packages/cli/src/renderer/management-binding.js'
import { localPackageV5 } from './suites/plugin-lifecycle.fixtures.js'
import {
  pluginManagementRpcPaths,
  readPluginManagementRpcEndpoint,
  requestPluginManagementRpc,
  usesNamespacedManagementRpc,
} from '../packages/cli/src/launcher/management-rpc.js'
import { managerRendererGatewayPaths } from '../packages/cli/src/cli/manager-renderer-gateway.js'
import { requestSupervisorStop } from '../packages/cli/src/cli/supervisor-control.js'
import { readSupervisorState } from '../packages/cli/src/cli/supervisor-state.js'
import { decodeManagerRendererBundle } from '../packages/cli/src/cli/manager-renderer-bundle-codec.js'
import { MAX_STANDALONE_CONSOLE_ORIGINS } from '../packages/cli/src/launcher/managed-console-browser-gateway.js'
import { assertOwnedServicesStopped, captureOwnedService } from './fixtures/owned-service-cleanup.js'

const exec = promisify(execFile)

it('connects the independent manager to a real service owner without Channel or Desktop', async () => {
  const home = await mkdtemp('/tmp/cx-manager-service-owner-')
  await writeFile(path.join(home, 'config.json'), JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })
  const env = managerChildEnvironment(process.env, 'unused')
  delete env.CORDISX_MANAGER_CHILD_KEY
  env.CORDISX_HOME = home
  env.CORDISX_MODEL_API_PORT = '0'
  env.HOME = home
  env.CODEX_HOME = path.join(home, 'codex-home')
  // Simulate a CordisX agent shell whose one-shot parent bootstrap is spent.
  env.CORDISX_SUPERVISOR_HOME = path.join(home, 'stale-owner')
  env.CORDISX_SUPERVISOR_APP = 'other'
  env.CORDISX_SUPERVISOR_PROFILE = 'other'
  env.CORDISX_SUPERVISOR_DATA_MODE = 'shared'
  env.CORDISX_SUPERVISOR_FINGERPRINT = 'stale'
  env.CORDISX_SUPERVISOR_TOKEN_FILE = path.join(home, 'already-consumed')
  let cli: string | undefined
  let startupRequested = false
  const owners: Awaited<ReturnType<typeof captureOwnedService>>[] = []
  const run = async (...args: string[]) =>
    await exec(process.execPath, [cli!, ...args], { env, cwd: home, timeout: 30_000 })
  try {
    const fixturePackage = process.env.CORDISX_MANAGER_PACKAGE_FIXTURE
    if (fixturePackage !== undefined) {
      if (!path.isAbsolute(fixturePackage)) throw new Error('fixture package must be an absolute path')
      await symlink(fixturePackage, path.join(home, 'package'), 'dir')
    } else {
      const packed = await exec('npm', [
        'pack',
        '--workspace',
        'cordisx',
        '--ignore-scripts',
        '--json',
        '--pack-destination',
        home,
        '--cache',
        path.join(home, 'npm-cache'),
      ], { env, cwd: process.cwd(), timeout: 30_000 })
      const filename = (JSON.parse(packed.stdout) as Array<{ filename: string }>)[0]!.filename
      if (filename !== path.basename(filename)) throw new Error('invalid package filename')
      await exec('tar', ['-xzf', path.join(home, filename), '-C', home], { env, timeout: 30_000 })
      const packageModules = path.join(home, 'package', 'node_modules')
      await mkdir(packageModules, { recursive: true })
      for (const name of ['@vitejs', 'vite']) {
        await symlink(path.resolve('packages/cli/node_modules', name), path.join(packageModules, name), 'dir')
      }
    }
    // Resolve lockfile-installed dependencies without installing or changing the user's system.
    await symlink(path.resolve('node_modules'), path.join(home, 'node_modules'), 'dir')
    cli = path.join(home, 'package', 'dist', 'src', 'cli.js')
    startupRequested = true
    const service = JSON.parse((await run('start', '--mode', 'service', 'codex', 'default', '--json')).stdout)
    owners.push(await captureOwnedService(home))
    expect(service).toMatchObject({
      status: 'ready',
      mode: 'service',
      webStatus: 'ready',
      webOrigin: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+$/u),
      webEntry: expect.stringMatching(/^file:\/\//u),
      webEntryExpiresInSeconds: 60,
    })
    const serviceGateway = await readSupervisorState(managerRendererGatewayPaths(home, 'default'))
    expect(serviceGateway).toMatchObject({
      phase: 'ready',
      pid: service.pid,
      managerOwnedByService: true,
      managerPublicOrigin: service.webOrigin,
    })
    expect(await readFile(fileURLToPath(service.webEntry), 'utf8')).toContain('location.replace(')
    expect(
      await requestSupervisorStop(
        managerRendererGatewayPaths(home, 'default').socket,
        serviceGateway!.instanceToken,
      ),
    ).toBe(false)
    const endpoint = await readPluginManagementRpcEndpoint(pluginManagementRpcPaths(home, 'codex', 'default'))
    expect(endpoint?.mailboxId).toBeDefined()
    expect(endpoint?.managerConsoleOrigins).toHaveLength(MAX_STANDALONE_CONSOLE_ORIGINS)
    expect(await usesNamespacedManagementRpc(endpoint!)).toBe(false)
    const line = (await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!
    const url = new URL(line)
    for (
      const file of [
        'manager-standalone.html',
        'manager-standalone.js',
        'manager-resource-worker.js',
        'manager.js',
        'manager-shell.js',
        'manager-host.css',
        'manager-schema.js',
        'manager-channel-ui.js',
        'manager.css',
      ]
    ) {
      const packaged = await readFile(path.join(home, 'package', 'dist', 'assets', 'manager', file), 'utf8')
      expect(packaged.length).toBeGreaterThan(0)
      const response = await fetch(`${url.origin}/${file === 'manager-standalone.html' ? '' : file}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(packaged)
      const policy = response.headers.get('content-security-policy')!
      expect(policy).toContain("script-src 'self'")
      expect(policy).toContain("style-src 'self'")
      expect(policy).toContain("style-src-elem 'self' 'unsafe-inline'")
      expect(policy).toContain("img-src 'self' data:")
      expect(policy).toContain(`frame-src ${endpoint!.managerConsoleOrigins!.join(' ')};`)
      expect(policy).not.toMatch(/(?:script-src|style-src)\s+[^;]*'unsafe-inline'/u)
    }
    for (
      const [route, file] of [
        ['manager-navigation.css', 'manager/manager-navigation.css'],
        ['manager-content.css', 'manager/manager-content.css'],
        ['manager-browse.css', 'manager/manager-browse.css'],
        ['manager-catalog.css', 'manager/manager-catalog.css'],
        ['manager-compact-shell.css', 'manager/manager-compact-shell.css'],
        ['search.css', 'host-ui/search.css'],
        ['action-group.css', 'host-ui/action-group.css'],
      ]
    ) {
      const packaged = await readFile(path.join(home, 'package', 'dist', 'src', 'renderer', file!), 'utf8')
      const response = await fetch(`${url.origin}/shared/${route}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe(packaged)
    }
    const exchange = await fetch(`${url.origin}/api/session`, {
      method: 'POST',
      headers: { origin: url.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: url.hash.slice(1) }),
    })
    expect(exchange.status).toBe(200)
    let { token } = await exchange.json() as { token: string }
    const state = await (await fetch(`${url.origin}/api/state`, { headers: { authorization: `Bearer ${token}` } }))
      .json()
    expect(state).toMatchObject({
      management: { runtime: { mode: 'service' } },
      services: { status: 'ok', services: [] },
    })
    expect(state.rendererPlugins).toMatchObject({ status: 'unavailable' })
    const post = async (route: string, input: unknown) =>
      await (await fetch(`${url.origin}${route}`, {
        method: 'POST',
        headers: { origin: url.origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(input),
      })).json()
    const renderer = await post('/api/renderer/open', {})
    expect(renderer).toEqual({
      status: 'ok',
      profileId: 'default',
      channels: [
        'plugin-management',
        'owner-document',
        'managed-service-ui',
        'model-services',
        'native-catalog',
        'permission-policy',
        'permission-once',
        'permission-history',
        'marketplace',
      ],
      commands: true,
      generation: expect.stringMatching(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u),
      rendererId: expect.stringMatching(/^[a-f0-9]{64}$/u),
    })
    // A separate, authenticated browser session exercises the real
    // packaged owner's private bootstrap over its bounded Unix socket.
    const managerState = (await readSupervisorState(managerRendererGatewayPaths(home, 'default')))!
    const gateway = {
      pid: managerState.pid,
      processStartedAt: managerState.processStartedAt,
      instanceToken: managerState.instanceToken,
    }
    const rpcPaths = pluginManagementRpcPaths(home, 'codex', 'default')
    const browserSessionId = randomBytes(32).toString('hex')
    const opened = await requestPluginManagementRpc(rpcPaths, endpoint!, {
      kind: 'manager-renderer',
      action: 'open',
      gateway,
      browserSessionId,
    }) as { status: string; handle: { rendererId: string; ownerGeneration: string; grant: string } }
    expect(opened.status).toBe('ok')
    const callBootstrap = async (payload: unknown) =>
      await requestPluginManagementRpc(rpcPaths, endpoint!, {
        kind: 'manager-renderer',
        action: 'call',
        gateway,
        browserSessionId,
        handle: opened.handle,
        channel: 'manager-bootstrap',
        payload,
      }) as any
    expect(await callBootstrap({ action: 'status' })).toEqual({ status: 'ok', value: { status: 'ok', current: true } })
    expect(await callBootstrap({ action: 'prepare' })).toMatchObject({
      status: 'ok',
      value: { status: 'ok', privateGraphs: [] },
    })
    const publicJwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' })
    const permissionPublicKey = { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y }
    const boot = await callBootstrap({ action: 'complete', managerOrigin: url.origin, graphs: [], permissionPublicKey })
    expect(boot.status).toBe('ok')
    expect(boot.value.status).toBe('ok')
    expect(boot.value.bundle.encoding).toBe('brotli-base64')
    const bundle = await decodeManagerRendererBundle(boot.value.bundle)
    try {
      // The uncompressed production bundle exceeds the complete RPC limit.
      expect(bundle.byteLength).toBeGreaterThan(8 * 1024 * 1024)
      expect(bundle.includes(Buffer.from('renderer-binding-placeholder'))).toBe(true)
    } finally {
      bundle.fill(0)
    }
    expect(
      await requestPluginManagementRpc(rpcPaths, endpoint!, {
        kind: 'manager-renderer',
        action: 'close',
        gateway,
        browserSessionId,
        handle: opened.handle,
      }),
    ).toEqual({ status: 'ok' })
    const query = JSON.stringify({
      version: 1,
      requestId: 'test-real-owner-query',
      token: 'renderer-binding-placeholder',
      profileId: 'default',
      operation: { kind: 'query' },
    })
    expect(await post('/api/renderer/binding', { channel: 'plugin-management', payload: query }))
      .toMatchObject({ requestId: 'test-real-owner-query', ok: true, value: { runtime: { mode: 'service' } } })
    // Exercise the same Manager binding against the packaged sidecar and real
    // service owner. The fake Window supplies browser Origin; this is a
    // transport integration test, not a visual browser acceptance.
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
    const browser = {
      fetch: (target: string, options: RequestInit) =>
        fetch(new URL(target, url.origin), {
          ...options,
          headers: { ...Object.fromEntries(new Headers(options.headers)), origin: url.origin },
        }),
    } as unknown as Window
    Object.defineProperty(globalThis, 'window', { configurable: true, value: browser })
    let disposeBindings: (() => void) | undefined
    let management: BrowserPluginManagementBinding | undefined
    try {
      disposeBindings = installIndependentHostBindings({
        window: browser,
        sessionToken: token,
        channels: ['plugin-management'],
      })
      management = new BrowserPluginManagementBinding('renderer-binding-placeholder', 'default')
      expect(await management.query()).toMatchObject({ runtime: { mode: 'service' } })
    } finally {
      management?.dispose()
      disposeBindings?.()
      if (originalWindow === undefined) delete (globalThis as { window?: Window }).window
      else Object.defineProperty(globalThis, 'window', originalWindow)
    }
    expect(
      await post('/api/renderer/binding', {
        channel: 'plugin-management',
        payload: query,
        gateway: { pid: 1 },
      }),
    ).toEqual({ error: 'RENDERER_BINDING_UNAVAILABLE' })
    expect(await post('/api/renderer/binding', { channel: 'config', payload: query }))
      .toEqual({ error: 'RENDERER_BINDING_UNAVAILABLE' })
    expect(await post('/api/managed-services', { action: 'list' })).toEqual({ status: 'available', services: [] })
    expect(await post('/api/channel-credentials', { action: 'view' })).toMatchObject({
      status: 'unavailable',
      code: 'CHANNEL_OWNER_UNAVAILABLE',
    })
    const localPlugin = await localPackageV5(home)
    const planned = await post('/api/management', {
      kind: 'plan',
      request: { kind: 'plugin-plan-local', sourceDirectory: localPlugin },
    })
    expect(planned.status).toBe('planned')
    const review = await post('/api/management', {
      kind: 'execute',
      request: planned.executionRequest,
      expectedRevision: planned.snapshot.revision,
    })
    expect(review.status).toBe('permission-review-required')
    const plan = review.permissionPlan
    expect(plan.schemaVersion).toBe(7)
    const decision = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/permission-authorization-decision.v7.schema.json',
      schemaVersion: 7,
      origin: 'explicit-user',
      planId: plan.planId,
      operation: plan.operation,
      profileId: plan.profileId,
      identity: plan.identity,
      binding: plan.binding,
      decisions: plan.declarations.filter((item: { decisionRequired: boolean }) => item.decisionRequired)
        .map((item: { capability: string; scope: unknown; securityFingerprint: string; required: boolean }) => ({
          capability: item.capability,
          scope: item.scope,
          securityFingerprint: item.securityFingerprint,
          decision: item.required ? 'allow-once' : 'deny-once',
        })),
    }
    const withoutConfirmation = await fetch(`${url.origin}/api/permission-review`, {
      method: 'POST',
      headers: { origin: url.origin, 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ expectedRevision: review.snapshot.activationRevision, decision }),
    })
    expect(withoutConfirmation.status).toBe(400)
    expect(
      await post('/api/permission-review', {
        expectedRevision: review.snapshot.activationRevision,
        userConfirmed: true,
        decision,
      }),
    ).toEqual({ status: 'unavailable', reason: 'profile-coordination-unavailable' })
    expect(await post('/api/renderer/close', {})).toEqual({ closed: true })
    // A new browser session without a live renderer can apply the same review.
    const nextLine = (await run('manager', 'open', '--print-url')).stdout.trim().split(' ').at(-1)!
    const nextUrl = new URL(nextLine)
    expect(nextUrl.origin).toBe(url.origin)
    const nextExchange = await fetch(`${nextUrl.origin}/api/session`, {
      method: 'POST',
      headers: { origin: nextUrl.origin, 'content-type': 'application/json' },
      body: JSON.stringify({ token: nextUrl.hash.slice(1) }),
    })
    expect(nextExchange.status).toBe(200)
    token = (await nextExchange.json() as { token: string }).token
    expect(
      await post('/api/permission-review', {
        expectedRevision: review.snapshot.activationRevision + 1,
        userConfirmed: true,
        decision,
      }),
    ).toMatchObject({ status: 'rejected', reason: 'stale-revision' })
    expect(
      await post('/api/permission-review', {
        expectedRevision: review.snapshot.activationRevision,
        userConfirmed: true,
        decision,
      }),
    ).toMatchObject({ status: 'ok', result: { outcome: 'applied' } })
    await expect(run('manager', 'stop')).rejects.toMatchObject({
      stderr: expect.stringContaining('MANAGER_SERVICE_OWNED'),
    })
    expect(JSON.parse((await run('status', '--mode', 'service', 'codex', 'default', '--json')).stdout))
      .toMatchObject({ status: 'ready', mode: 'service' })
    await run('stop', '--mode', 'service', 'codex', 'default', '--json')
    expect(await readSupervisorState(managerRendererGatewayPaths(home, 'default'))).toBeUndefined()
    await expect(fetch(`${url.origin}/`)).rejects.toThrow()
  } finally {
    if (cli) {
      await run('manager', 'stop').catch(() => undefined)
      await run('stop', '--mode', 'service', 'codex', 'default', '--json').catch(() => undefined)
    }
    await assertOwnedServicesStopped(home, owners, startupRequested)
    const makeOwnedFixtureRemovable = async (directory: string): Promise<void> => {
      await chmod(directory, 0o700)
      for (const item of await readdir(directory, { withFileTypes: true })) {
        if (item.isDirectory()) await makeOwnedFixtureRemovable(path.join(directory, item.name))
      }
    }
    await makeOwnedFixtureRemovable(home)
    await rm(home, { recursive: true, force: true })
  }
}, 60_000)
