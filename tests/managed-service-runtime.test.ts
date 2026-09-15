import type { spawn as nodeSpawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { prepareNativeManagedGatewayConnection } from '../packages/cli/src/launcher/managed-service-native-connection.js'
import { ManagedServiceSchemaRegistry } from '../packages/cli/src/launcher/managed-service-schema.js'
import { readManagedBoundedFile } from '../packages/cli/src/launcher/managed-service-runtime-support.js'
import {
  cliDefinition,
  declaration,
  deferred,
  definition,
  fixture,
  MODELS_SCHEMA,
  owner,
  restrictedPortDefinition,
  runtime,
  schemaRegistry,
  SOURCES_SCHEMA,
  syntheticChild,
} from './managed-service-runtime-fixture.js'

describe('managed service runtime', () => {
  it('rejects an invalid health failure threshold', async () => {
    const { home } = await fixture()
    expect(() => runtime(home, { failuresBeforeUnhealthy: Number.NaN })).toThrow('threshold is invalid')
  })

  it('applies declared non-secret environment values without replacing Host-owned HOME', async () => {
    const { root, home } = await fixture()
    const environments: NodeJS.ProcessEnv[] = []
    const host = runtime(home, {
      spawn: ((
        _executable: string,
        _arguments: readonly string[],
        options: { readonly env?: NodeJS.ProcessEnv },
      ) => {
        environments.push(options.env ?? {})
        return syntheticChild({ exitOnKill: 'SIGTERM' }).child
      }) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const binding = host.bind({
      owner: owner('env-plugin', 'env-one'),
      source: 'https://plugins.example.test/env',
      declaration: declaration('env-service', 'env-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const value = definition('env-service')
    value.environment = [
      { variable: 'SERVICE_MODE', source: 'literal', value: 'synthetic' },
      { variable: 'SERVICE_HOME_FILE', source: 'service-home-relative-path', path: './environment.json' },
    ]
    const registration = await binding.registry.register(value, {
      revision: `sha256:${'1'.repeat(64)}`,
    })
    const serviceHome = path.join(home, 'managed-services', 'env-plugin', 'env-service')
    const declaredFile = path.join(serviceHome, 'environment.json')
    await expect(access(declaredFile)).rejects.toThrow()
    const ready = await registration.ensureReady()
    expect(ready.status).toBe('ready')
    expect(environments).toHaveLength(1)
    expect(environments[0]?.HOME).toBe(serviceHome)
    expect(environments[0]?.SERVICE_MODE).toBe('synthetic')
    expect(environments[0]?.SERVICE_HOME_FILE).toBe(declaredFile)
    await expect(access(declaredFile)).rejects.toThrow()
    await binding.dispose()
  })

  it('rejects definition-level HOME overrides before launch', async () => {
    const { root, home } = await fixture()
    const host = runtime(home, { fetch: async () => new Response(null, { status: 204 }) })
    const binding = host.bind({
      owner: owner('home-plugin', 'home-one'),
      source: 'https://plugins.example.test/home',
      declaration: declaration('home-service', 'home-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const value = definition('home-service', { fixedPort: 41_231 })
    value.environment = [{ variable: 'HOME', source: 'literal', value: '/tmp/not-allowed' }]
    const registration = await binding.registry.register(value, { revision: `sha256:${'2'.repeat(64)}` })
    expect((await registration.ensureReady()).status).toBe('failed')
    await binding.dispose()
  })

  it('uses one profile-scoped environment for status, login, and refresh', async () => {
    const { root, home } = await fixture()
    const userHome = path.join(root, 'user-home')
    const explicitXdg = path.join(root, 'explicit-xdg')
    const syntheticAuthRoot = path.join(home, 'synthetic-auth')
    const environments: NodeJS.ProcessEnv[] = []
    let projectionCount = 0
    const spawn = ((
      _executable: string,
      _arguments: readonly string[],
      options: { readonly env?: NodeJS.ProcessEnv },
    ) => {
      const controlled = syntheticChild()
      environments.push(options.env ?? {})
      void writeFile(path.join(options.env?.HOME ?? userHome, `auth-${environments.length}`), 'ok').then(
        () => controlled.exit(0),
        controlled.fail,
      )
      return controlled.child
    }) as typeof nodeSpawn
    const host = runtime(home, {
      environment: {
        HOME: userHome,
        XDG_CONFIG_HOME: explicitXdg,
        SERVICE_TOKEN: 'inherited-secret',
        PATH: process.env.PATH,
      },
      projectEnvironment: async () => {
        projectionCount += 1
        return { SYNTHETIC_AUTH_ROOT: syntheticAuthRoot }
      },
      spawn,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const binding = host.bind({
      owner: owner('auth-plugin', 'auth-one'),
      source: 'https://plugins.example.test/auth',
      declaration: declaration('auth-service', 'auth-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(cliDefinition('auth-service'), {
      revision: `sha256:${'7'.repeat(64)}`,
    })

    expect((await registration.ensureReady()).status).toBe('ready')
    expect((await registration.authenticate('login')).status).toBe('accepted')
    expect((await registration.authenticate('refresh')).status).toBe('accepted')

    const serviceHome = path.join(home, 'managed-services', 'auth-plugin', 'auth-service')
    expect(environments).toHaveLength(3)
    expect(projectionCount).toBe(1)
    expect(environments[1]).toBe(environments[0])
    expect(environments[2]).toBe(environments[0])
    for (const [index, environment] of environments.entries()) {
      expect(environment.HOME).toBe(serviceHome)
      expect(environment.XDG_CONFIG_HOME).toBeUndefined()
      expect(environment.SERVICE_TOKEN).toBeUndefined()
      expect(environment.PATH).toBe(process.env.PATH)
      expect(environment.SYNTHETIC_AUTH_ROOT).toBe(syntheticAuthRoot)
      if (process.platform === 'win32') expect(environment.USERPROFILE).toBe(serviceHome)
      expect(await readFile(path.join(serviceHome, `auth-${index + 1}`), 'utf8')).toBe('ok')
    }
    await expect(access(path.join(userHome, 'auth-1'))).rejects.toThrow()
    await binding.dispose()
  })

  it('runs only a declared logout helper and revokes the authenticated runtime generation', async () => {
    const { root, home } = await fixture()
    const service = syntheticChild({ exitOnKill: 'SIGTERM' })
    let authenticationActions = 0
    const host = runtime(home, {
      spawn: ((executable: string) => {
        if (executable === 'synthetic-auth') {
          authenticationActions += 1
          const action = syntheticChild()
          queueMicrotask(() => action.exit(0))
          return action.child
        }
        return service.child
      }) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const identity = {
      source: 'https://plugins.example.test/logout' as const,
      pluginId: 'logout-plugin',
      serviceId: 'logout-service',
    }
    const binding = host.bind({
      owner: owner(identity.pluginId, 'logout-one'),
      source: identity.source,
      declaration: declaration(identity.serviceId, identity.pluginId, [
        { pluginId: identity.pluginId, operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const value = cliDefinition(identity.serviceId)
    value.discovery = { kind: 'host-assigned-loopback' }
    value.launch = {
      executable: { kind: 'package-relative', path: './server.mjs' },
      arguments: [{ kind: 'host-assigned-loopback', serialization: 'port' }],
      startupTimeoutMs: 5_000,
    }
    const registration = await binding.registry.register(value, { revision: `sha256:${'6'.repeat(64)}` })
    expect(host.supportsLogout(identity)).toBe(true)
    expect((await registration.ensureReady()).status).toBe('ready')
    const before = await registration.inspect()
    expect(before).toMatchObject({
      state: 'ready',
      authentication: { state: 'configured' },
      health: 'ready',
    })
    expect(before.connection).toBeDefined()
    const lease = await binding.client.acquire(identity)
    expect(lease.status).toBe('ready')

    const result = await registration.authenticate('logout')
    expect(result.status).toBe('accepted')
    expect(authenticationActions).toBe(2)
    expect(service.signals).toEqual(['SIGTERM'])
    const after = await registration.inspect()
    expect(after).toMatchObject({
      state: 'authentication-required',
      authentication: { state: 'missing' },
      health: 'stopped',
    })
    expect(after.connection).toBeUndefined()
    expect(after.binding.serviceGeneration).not.toBe(before.binding.serviceGeneration)
    if (lease.status === 'ready') {
      expect((await binding.client.invoke(lease.lease, 'models.list')).status).not.toBe('accepted')
    }

    const noLogout = definition('no-logout-service')
    expect(host.supportsLogout({ ...identity, serviceId: noLogout.serviceId })).toBe(false)
    await binding.dispose()
  })

  it('recovers record state from authentication-required after successful login so ensureReady can proceed', async () => {
    const { root, home } = await fixture()
    let spawnCalls = 0
    const host = runtime(home, {
      spawn: ((executable: string) => {
        spawnCalls += 1
        if (executable === 'synthetic-auth') {
          const auth = syntheticChild()
          if (spawnCalls === 1) queueMicrotask(() => auth.exit(2))
          else queueMicrotask(() => auth.exit(0))
          return auth.child
        }
        const server = syntheticChild()
        queueMicrotask(() => server.exit(0))
        return server.child
      }) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const binding = host.bind({
      owner: owner('recover-plugin', 'recover-one'),
      source: 'https://plugins.example.test/recover',
      declaration: declaration('recover-service', 'recover-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(cliDefinition('recover-service'), {
      revision: 'sha256:9999999999999999999999999999999999999999999999999999999999999999',
    })

    const first = await registration.ensureReady()
    expect(first.status).toBe('authentication-required')
    const beforeLogin = await registration.inspect()
    expect(beforeLogin.state).toBe('authentication-required')
    expect(beforeLogin.authentication.state).toBe('missing')

    const login = await registration.authenticate('login')
    expect(login.status).toBe('accepted')
    const afterLogin = await registration.inspect()
    expect(afterLogin.state).toBe('registered')
    expect(afterLogin.authentication.state).toBe('configured')

    const second = await registration.ensureReady()
    expect(second.status).toBe('ready')

    const generation = registration.binding.serviceGeneration
    const defaultAlias = 'aiden/gpt-5.6-sol'
    const routes = [{ alias: defaultAlias, gatewayModelId: 'gpt-5.6-sol' }]
    const digest = `sha256:${
      createHash('sha256').update(
        JSON.stringify([generation, defaultAlias, routes.map(route => [route.alias, route.gatewayModelId])]),
      ).digest('hex')
    }` as const
    const published = await registration.publishNativeProvider({
      providerId: 'aiden',
      compositionOrigin: 'api',
      catalog: { generation, digest, defaultAlias, routes },
    })
    expect(published.status).toBe('accepted')
    expect(host.listNativeProviderIds()).toEqual(['aiden'])

    await binding.dispose()
  })
  it('stops authentication before spawn when already aborted and reaps a non-responsive child on abort', async () => {
    const { root, home } = await fixture()
    let spawnCount = 0
    let spawnedResolve!: () => void
    const spawned = new Promise<void>(resolve => {
      spawnedResolve = resolve
    })
    const controlled = syntheticChild({ exitOnKill: 'SIGKILL' })
    const host = runtime(home, {
      spawn: (() => {
        spawnCount += 1
        spawnedResolve()
        return controlled.child
      }) as typeof nodeSpawn,
      childTerminationTimeouts: { gracefulMs: 5, forceMs: 20 },
    })
    const binding = host.bind({
      owner: owner('abort-plugin', 'abort-one'),
      source: 'https://plugins.example.test/abort',
      declaration: declaration('abort-service', 'abort-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(cliDefinition('abort-service'), {
      revision: `sha256:${'8'.repeat(64)}`,
    })
    const preAborted = new AbortController()
    preAborted.abort(new Error('already cancelled'))
    expect((await registration.authenticate('login', { signal: preAborted.signal })).status).toBe('cancelled')
    expect(spawnCount).toBe(0)

    const controller = new AbortController()
    const authenticating = registration.authenticate('login', { signal: controller.signal })
    await spawned
    controller.abort(new Error('cancelled during login'))
    expect((await authenticating).status).toBe('cancelled')
    expect(spawnCount).toBe(1)
    expect(controlled.signals).toEqual(['SIGTERM', 'SIGKILL'])
    await binding.dispose()
  })

  it('clears authentication timeout state after a synthetic child failure', async () => {
    vi.useFakeTimers()
    try {
      const { root, home } = await fixture()
      const controlled = syntheticChild()
      Object.assign(controlled.child, { pid: undefined })
      const host = runtime(home, {
        spawn: (() => {
          Promise.resolve().then(() => controlled.fail(new Error('synthetic spawn failure')))
          return controlled.child
        }) as typeof nodeSpawn,
      })
      const binding = host.bind({
        owner: owner('failure-plugin', 'failure-one'),
        source: 'https://plugins.example.test/failure',
        declaration: declaration('failure-service', 'failure-plugin', []),
        artifactDirectory: root,
      }, new AbortController().signal)
      const registration = await binding.registry.register(cliDefinition('failure-service', 60_000), {
        revision: `sha256:${'9'.repeat(64)}`,
      })
      expect((await registration.authenticate('login')).status).toBe('failed')
      expect(vi.getTimerCount()).toBe(0)
      await binding.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails a named-command spawn error without an unhandled child error', async () => {
    const { root, home } = await fixture()
    const controlled = syntheticChild()
    Object.assign(controlled.child, { pid: undefined })
    const host = runtime(home, {
      spawn: (() => {
        queueMicrotask(() => controlled.fail(Object.assign(new Error('missing command'), { code: 'ENOENT' })))
        return controlled.child
      }) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 503 }),
    })
    const binding = host.bind({
      owner: owner('missing-plugin', 'missing-one'),
      source: 'https://plugins.example.test/missing',
      declaration: declaration('missing-service', 'missing-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const value = definition('missing-service', { fixedPort: 41_231 })
    value.launch = {
      executable: { kind: 'named-command', command: 'missing-managed-service-command' },
      arguments: [],
      startupTimeoutMs: 1_000,
    }
    const registration = await binding.registry.register(value, { revision: `sha256:${'e'.repeat(64)}` })
    expect((await registration.ensureReady()).status).toBe('failed')
    expect((await registration.inspect()).state).toBe('failed')
    await binding.dispose()
  })

  it('bounds a file that grows after its initial stat', async () => {
    let stats = 0
    let requested = 0
    const handle = {
      stat: async () => ({ isFile: () => true, size: stats++ === 0 ? 1 : 33 }),
      read: async (buffer: Buffer, offset: number, length: number) => {
        requested = length
        buffer.fill(49, offset, offset + length)
        return { bytesRead: length, buffer }
      },
    }
    await expect(readManagedBoundedFile(handle as never, 32)).rejects.toThrow('bounded readback')
    expect(requested).toBe(33)
  })

  it('shares disposal, cancels preparation, and never spawns after revocation', async () => {
    const { root, home } = await fixture()
    const entered = deferred<void>()
    const port = deferred<number>()
    let spawnCount = 0
    const host = runtime(home, {
      findFreePort: async () => {
        entered.resolve()
        return await port.promise
      },
      spawn: (() => {
        spawnCount += 1
        return syntheticChild().child
      }) as typeof nodeSpawn,
    })
    const binding = host.bind({
      owner: owner('race-plugin', 'race-one'),
      source: 'https://plugins.example.test/race',
      declaration: declaration('race-service', 'race-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(definition('race-service'), {
      revision: `sha256:${'f'.repeat(64)}`,
    })
    const preparing = registration.ensureReady()
    await entered.promise
    const first = registration.dispose()
    const second = registration.dispose()
    expect(second).toBe(first)
    port.resolve(41_231)
    expect((await preparing).status).toBe('stale-generation')
    await first
    expect(spawnCount).toBe(0)
    expect((await registration.inspect()).state).toBe('disposed')
    await binding.dispose()
  })

  it('cancels and awaits an authentication child during record disposal', async () => {
    const { root, home } = await fixture()
    const spawned = deferred<void>()
    const controlled = syntheticChild({ exitOnKill: 'SIGTERM' })
    const host = runtime(home, {
      spawn: (() => {
        spawned.resolve()
        return controlled.child
      }) as typeof nodeSpawn,
    })
    const binding = host.bind({
      owner: owner('auth-dispose-plugin', 'auth-dispose-one'),
      source: 'https://plugins.example.test/auth-dispose',
      declaration: declaration('auth-dispose-service', 'auth-dispose-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(cliDefinition('auth-dispose-service'), {
      revision: `sha256:${'a'.repeat(64)}`,
    })
    const authenticating = registration.authenticate('login')
    await spawned.promise
    const disposing = registration.dispose()
    expect((await authenticating).status).toBe('stale-generation')
    await disposing
    expect(controlled.signals).toEqual(['SIGTERM'])
    await binding.dispose()
  })

  it('cancels restart preparation before a replacement child can spawn', async () => {
    const { root, home } = await fixture()
    const restartPreparing = deferred<void>()
    const restartPort = deferred<number>()
    const owned = syntheticChild({ exitOnKill: 'SIGTERM' })
    let ports = 0
    let spawns = 0
    const host = runtime(home, {
      findFreePort: async () => {
        ports += 1
        if (ports === 1) return 41_231
        restartPreparing.resolve()
        return await restartPort.promise
      },
      spawn: (() => {
        spawns += 1
        return owned.child
      }) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const binding = host.bind({
      owner: owner('restart-plugin', 'restart-one'),
      source: 'https://plugins.example.test/restart',
      declaration: declaration('restart-service', 'restart-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(definition('restart-service'), {
      revision: `sha256:${'b'.repeat(64)}`,
    })
    expect((await registration.ensureReady()).status).toBe('ready')
    const restarting = registration.restart()
    await restartPreparing.promise
    const disposing = registration.dispose()
    restartPort.resolve(41_232)
    expect((await restarting).status).toBe('stale-generation')
    await disposing
    expect(spawns).toBe(1)
    expect((await registration.inspect()).state).toBe('disposed')
    await binding.dispose()
  })

  it('waits for concurrent registration and removes a late record after plugin disposal', async () => {
    const { root, home } = await fixture()
    const entered = deferred<void>()
    const release = deferred<void>()
    class DelayedDefinitionRegistry extends ManagedServiceSchemaRegistry {
      override async validateDefinition(value: unknown): Promise<void> {
        entered.resolve()
        await release.promise
        await super.validateDefinition(value)
      }
    }
    const host = runtime(home, { schemas: new DelayedDefinitionRegistry() })
    const access_ = {
      owner: owner('registration-plugin', 'registration-one'),
      source: 'https://plugins.example.test/registration' as const,
      declaration: declaration('registration-service', 'registration-plugin', []),
      artifactDirectory: root,
    }
    const binding = host.bind(access_, new AbortController().signal)
    const registering = binding.registry.register(definition('registration-service'), {
      revision: `sha256:${'1'.repeat(64)}`,
    })
    await entered.promise
    const first = binding.dispose()
    expect(binding.dispose()).toBe(first)
    release.resolve()
    await expect(registering).rejects.toThrow('disposed during registration')
    await first

    const replacement = host.bind({
      ...access_,
      owner: owner('registration-plugin', 'registration-two'),
    }, new AbortController().signal)
    await expect(replacement.registry.register(definition('registration-service'), {
      revision: `sha256:${'2'.repeat(64)}`,
    })).resolves.toBeDefined()
    await replacement.dispose()
  })

  it('finishes revocation when owned child termination fails', async () => {
    const { root, home } = await fixture()
    const controlled = syntheticChild()
    const host = runtime(home, {
      spawn: (() => controlled.child) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 204 }),
      childTerminationTimeouts: { gracefulMs: 1, forceMs: 1 },
    })
    const binding = host.bind({
      owner: owner('cleanup-plugin', 'cleanup-one'),
      source: 'https://plugins.example.test/cleanup',
      declaration: declaration('cleanup-service', 'cleanup-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(definition('cleanup-service'), {
      revision: `sha256:${'3'.repeat(64)}`,
    })
    expect((await registration.ensureReady()).status).toBe('ready')
    binding.client.dispose()
    const first = binding.dispose()
    expect(binding.dispose()).toBe(first)
    await expect(first).rejects.toThrow('did not exit after SIGKILL')
    expect((await registration.inspect()).state).toBe('disposed')
    expect(controlled.signals).toEqual(['SIGTERM', 'SIGKILL'])
  })

  it('uses the stored lease grant and cancels an overflowing response stream', async () => {
    const { root, home } = await fixture()
    const controlled = syntheticChild({ exitOnKill: 'SIGTERM' })
    let operationFetches = 0
    let cancelled = false
    const host = runtime(home, {
      spawn: (() => controlled.child) as typeof nodeSpawn,
      fetch: async input => {
        if (new URL(input).pathname === '/health') return new Response(null, { status: 204 })
        operationFetches += 1
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(600_000))
              controller.enqueue(new Uint8Array(600_000))
            },
            cancel() {
              cancelled = true
            },
          }),
          { status: 200 },
        )
      },
    })
    const binding = host.bind({
      owner: owner('broker-plugin', 'broker-one'),
      source: 'https://plugins.example.test/broker',
      declaration: declaration('broker-service', 'broker-plugin', [
        { pluginId: 'broker-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const service = definition('broker-service')
    service.operations = [
      ...service.operations,
      { operationId: 'admin.read', method: 'GET', path: '/v1/admin', responseSchema: MODELS_SCHEMA, timeoutMs: 2_000 },
    ]
    const registration = await binding.registry.register(service, { revision: `sha256:${'4'.repeat(64)}` })
    expect((await registration.ensureReady()).status).toBe('ready')
    const acquired = await binding.client.acquire(registration.binding.identity)
    expect(acquired.status).toBe('ready')
    if (acquired.status !== 'ready') throw new Error('lease unavailable')
    const forged = { ...acquired.lease, operations: [...acquired.lease.operations, 'admin.read'] }
    expect((await binding.client.invoke(forged, 'admin.read')).status).toBe('unavailable')
    expect(operationFetches).toBe(0)
    expect((await binding.client.invoke(acquired.lease, 'models.list')).status).toBe('failed')
    expect(cancelled).toBe(true)
    expect(operationFetches).toBe(1)
    await binding.dispose()
  })

  it('rejects an invocation whose authoritative lease is revoked during fetch', async () => {
    const { root, home } = await fixture()
    const controlled = syntheticChild({ exitOnKill: 'SIGTERM' })
    const operationStarted = deferred<void>()
    const response = deferred<Response>()
    const host = runtime(home, {
      spawn: (() => controlled.child) as typeof nodeSpawn,
      fetch: async input => {
        if (new URL(input).pathname === '/health') return new Response(null, { status: 204 })
        operationStarted.resolve()
        return await response.promise
      },
    })
    const binding = host.bind({
      owner: owner('invoke-plugin', 'invoke-one'),
      source: 'https://plugins.example.test/invoke',
      declaration: declaration('invoke-service', 'invoke-plugin', [
        { pluginId: 'invoke-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(definition('invoke-service'), {
      revision: `sha256:${'5'.repeat(64)}`,
    })
    expect((await registration.ensureReady()).status).toBe('ready')
    const acquired = await binding.client.acquire(registration.binding.identity)
    if (acquired.status !== 'ready') throw new Error('lease unavailable')
    const invoking = binding.client.invoke(acquired.lease, 'models.list')
    await operationStarted.promise
    await registration.dispose()
    response.resolve(Response.json({ models: [{ id: 'late' }] }))
    expect((await invoking).status).toBe('stale-generation')
    await binding.dispose()
  })

  it('degrades on interval health failures and revokes the stale ready generation', async () => {
    vi.useFakeTimers()
    try {
      const { root, home } = await fixture()
      const controlled = syntheticChild({ exitOnKill: 'SIGTERM' })
      let healthChecks = 0
      const host = runtime(home, {
        spawn: (() => controlled.child) as typeof nodeSpawn,
        fetch: async () => new Response(null, { status: healthChecks++ === 0 ? 204 : 503 }),
        failuresBeforeUnhealthy: 2,
      })
      const binding = host.bind({
        owner: owner('health-plugin', 'health-one'),
        source: 'https://plugins.example.test/health',
        declaration: declaration('health-service', 'health-plugin', [
          { pluginId: 'health-plugin', operations: ['models.list'] },
        ]),
        artifactDirectory: root,
      }, new AbortController().signal)
      const registration = await binding.registry.register(definition('health-service'), {
        revision: `sha256:${'6'.repeat(64)}`,
      })
      expect((await registration.ensureReady()).status).toBe('ready')
      await vi.advanceTimersByTimeAsync(250)
      expect((await registration.inspect()).health).toBe('degraded')
      await vi.advanceTimersByTimeAsync(250)
      expect(await registration.inspect()).toMatchObject({ state: 'failed', health: 'unhealthy' })
      expect((await binding.client.acquire(registration.binding.identity)).status).toBe('unavailable')
      await binding.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not take over a borrowed service after health failure', async () => {
    vi.useFakeTimers()
    try {
      const { root, home } = await fixture()
      let healthChecks = 0
      let spawns = 0
      const host = runtime(home, {
        fetch: async () => new Response(null, { status: healthChecks++ === 0 ? 204 : 503 }),
        failuresBeforeUnhealthy: 1,
        spawn: (() => {
          spawns += 1
          return syntheticChild().child
        }) as typeof nodeSpawn,
      })
      const binding = host.bind({
        owner: owner('borrowed-health-plugin', 'borrowed-health-one'),
        source: 'https://plugins.example.test/borrowed-health',
        declaration: declaration('borrowed-health-service', 'borrowed-health-plugin', []),
        artifactDirectory: root,
      }, new AbortController().signal)
      const registration = await binding.registry.register(
        definition('borrowed-health-service', { fixedPort: 41_231 }),
        { revision: `sha256:${'d'.repeat(64)}` },
      )
      expect((await registration.ensureReady()).status).toBe('ready')
      await vi.advanceTimersByTimeAsync(250)
      expect(await registration.inspect()).toMatchObject({
        state: 'failed',
        health: 'unhealthy',
        processOwnership: 'borrowed',
      })
      const retry = await registration.ensureReady()
      expect(retry.status).toBe('unavailable')
      expect(await registration.inspect()).toMatchObject({
        state: 'failed',
        health: 'unhealthy',
        processOwnership: 'borrowed',
        diagnostic: { code: 'borrowed-service', retryable: false },
      })
      expect((await registration.restart()).status).toBe('unavailable')
      expect(spawns).toBe(0)
      await binding.dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  it('drains bounded health response bodies', async () => {
    const { root, home } = await fixture()
    let pulls = 0
    const host = runtime(home, {
      fetch: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              pulls += 1
              controller.enqueue(Uint8Array.of(111, 107))
              controller.close()
            },
          }),
          { status: 200 },
        ),
    })
    const binding = host.bind({
      owner: owner('health-body-plugin', 'health-body-one'),
      source: 'https://plugins.example.test/health-body',
      declaration: declaration('health-body-service', 'health-body-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(definition('health-body-service', { fixedPort: 41_231 }), {
      revision: `sha256:${'f'.repeat(64)}`,
    })
    expect((await registration.ensureReady()).status).toBe('ready')
    expect(pulls).toBe(1)
    await binding.dispose()
  })

  it('invalidates a ready generation immediately when its owned child exits', async () => {
    const { root, home } = await fixture()
    const controlled = syntheticChild()
    const host = runtime(home, {
      spawn: (() => controlled.child) as typeof nodeSpawn,
      fetch: async () => new Response(null, { status: 204 }),
    })
    const binding = host.bind({
      owner: owner('exit-plugin', 'exit-one'),
      source: 'https://plugins.example.test/exit',
      declaration: declaration('exit-service', 'exit-plugin', [
        { pluginId: 'exit-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(definition('exit-service'), {
      revision: `sha256:${'7'.repeat(64)}`,
    })
    expect((await registration.ensureReady()).status).toBe('ready')
    controlled.exit(1)
    await Promise.resolve()
    expect(await registration.inspect()).toMatchObject({ state: 'failed', health: 'unhealthy' })
    expect((await binding.client.acquire(registration.binding.identity)).status).toBe('unavailable')
    await binding.dispose()
  })

  it('rejects materialization when its owned target is disposed during schema validation', async () => {
    const { root, home } = await fixture()
    const schemas = schemaRegistry()
    const validating = deferred<void>()
    const release = deferred<void>()
    const validate = schemas.validate.bind(schemas)
    vi.spyOn(schemas, 'validate').mockImplementation(async (schema, value, label) => {
      if (schema === SOURCES_SCHEMA) {
        validating.resolve()
        await release.promise
      }
      await validate(schema, value, label)
    })
    const host = runtime(home, { schemas })
    const binding = host.bind({
      owner: owner('materialize-plugin', 'materialize-one'),
      source: 'https://plugins.example.test/materialize',
      declaration: declaration('materialize-service', 'materialize-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(
      definition('materialize-service', { configured: true, assignedInConfiguration: true }),
      { revision: `sha256:${'8'.repeat(64)}` },
    )
    const materializing = binding.client.materialize({
      target: registration.binding,
      revision: `sha256:${'9'.repeat(64)}`,
      sources: [],
      bindings: [{
        targetSlot: 'sources',
        source: { kind: 'safe-literal', value: { id: 'late', baseUrl: null, apiKey: null } },
      }],
    })
    await validating.promise
    await registration.dispose()
    release.resolve()
    expect((await materializing).status).toBe('stale-generation')
    await binding.dispose()
  })

  it('discovers a child-written port only from the stable service home', async () => {
    const { root, home } = await fixture()
    const userHome = path.join(root, 'user-home')
    await mkdir(userHome)
    const syntheticAuthRoot = path.join(home, 'synthetic-auth')
    const host = runtime(home, {
      environment: { ...process.env, HOME: userHome },
      projectEnvironment: async () => ({ SYNTHETIC_AUTH_ROOT: syntheticAuthRoot }),
    })
    const binding = host.bind({
      owner: owner('port-plugin', 'port-one'),
      source: 'https://plugins.example.test/port',
      declaration: declaration('port-service', 'port-plugin', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await binding.registry.register(restrictedPortDefinition('port-service'), {
      revision: `sha256:${'b'.repeat(64)}`,
    })
    expect((await registration.ensureReady()).status).toBe('ready')
    const serviceHome = path.join(home, 'managed-services', 'port-plugin', 'port-service')
    expect(Number(await readFile(path.join(serviceHome, 'service.port'), 'utf8'))).toBeGreaterThan(0)
    expect(JSON.parse(await readFile(path.join(serviceHome, 'environment.json'), 'utf8'))).toEqual({
      home: serviceHome,
      authRoot: syntheticAuthRoot,
    })
    await expect(access(path.join(userHome, 'service.port'))).rejects.toThrow()
    const generationDirectory = path.join(serviceHome, registration.binding.serviceGeneration)
    await mkdir(generationDirectory)
    await writeFile(path.join(generationDirectory, 'private.json'), '{}')
    await writeFile(path.join(serviceHome, 'credential.json'), '{"session":"preserved"}')
    await binding.dispose()
    await expect(access(generationDirectory)).rejects.toThrow()
    expect(await readFile(path.join(serviceHome, 'credential.json'), 'utf8')).toContain('preserved')
  }, 20_000)

  it.skipIf(process.platform === 'win32')('rejects unsafe service-home port files before spawn', async () => {
    const { root, home } = await fixture()
    let spawnCount = 0
    const host = runtime(home, {
      spawn: (() => {
        spawnCount += 1
        return syntheticChild().child
      }) as typeof nodeSpawn,
    })
    for (
      const [serviceId, prepare] of [
        ['symlink-port', async (serviceHome: string) => {
          const target = path.join(root, 'outside.port')
          await writeFile(target, '41231')
          await symlink(target, path.join(serviceHome, 'service.port'))
        }],
        ['oversized-port', async (serviceHome: string) => {
          await writeFile(path.join(serviceHome, 'service.port'), '1'.repeat(33))
        }],
      ] as const
    ) {
      const serviceHome = path.join(home, 'managed-services', 'unsafe-plugin', serviceId)
      await mkdir(serviceHome, { recursive: true })
      await prepare(serviceHome)
      const binding = host.bind({
        owner: owner('unsafe-plugin', serviceId),
        source: 'https://plugins.example.test/unsafe',
        declaration: declaration(serviceId, 'unsafe-plugin', []),
        artifactDirectory: root,
      }, new AbortController().signal)
      const registration = await binding.registry.register(restrictedPortDefinition(serviceId), {
        revision: `sha256:${serviceId === 'symlink-port' ? 'c' : 'd'}`.padEnd(
          71,
          serviceId === 'symlink-port' ? 'c' : 'd',
        ) as `sha256:${string}`,
      })
      expect((await registration.ensureReady()).status).toBe('failed')
      await binding.dispose()
    }
    expect(spawnCount).toBe(0)
  })

  it('runs authenticated sources, enforces explicit grants, materializes a gateway, and fences cleanup', async () => {
    const { root, home } = await fixture()
    const host = runtime(home)
    const sourceController = new AbortController()
    const gatewayController = new AbortController()
    const deniedController = new AbortController()
    const source = host.bind({
      owner: owner('source-plugin', 'source-one'),
      source: 'https://plugins.example.test/source',
      declaration: declaration('source-service', 'source-plugin', [
        { pluginId: 'source-plugin', operations: ['models.list'] },
        { pluginId: 'gateway-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, sourceController.signal)
    const gateway = host.bind({
      owner: owner('gateway-plugin', 'gateway-one'),
      source: 'https://plugins.example.test/gateway',
      declaration: declaration('gateway-service', 'gateway-plugin', [
        { pluginId: 'gateway-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, gatewayController.signal)
    const denied = host.bind({
      owner: owner('denied-plugin', 'denied-one'),
      source: 'https://plugins.example.test/denied',
      declaration: declaration('denied-service', 'denied-plugin', []),
      artifactDirectory: root,
    }, deniedController.signal)
    const sourceRegistration = await source.registry.register(definition('source-service'), {
      revision: `sha256:${'1'.repeat(64)}`,
    })
    expect((await sourceRegistration.ensureReady()).status).toBe('ready')

    const selfLease = await source.client.acquire(sourceRegistration.binding.identity)
    expect(selfLease.status).toBe('ready')
    if (selfLease.status !== 'ready') throw new Error('source self lease unavailable')
    expect((await source.client.invoke(selfLease.lease, 'models.list')).status).toBe('accepted')
    source.client.release(selfLease.lease)

    expect((await denied.client.acquire(sourceRegistration.binding.identity)).status).toBe('unavailable')
    const sourceForGateway = await gateway.client.acquire(sourceRegistration.binding.identity)
    expect(sourceForGateway.status).toBe('ready')
    if (sourceForGateway.status !== 'ready') throw new Error('gateway source lease unavailable')

    const gatewayDefinition = definition('gateway-service', { configured: true, assignedInConfiguration: true })
    const gatewayRegistration = await gateway.registry.register(gatewayDefinition, {
      revision: `sha256:${'2'.repeat(64)}`,
    })
    expect(
      (await denied.client.materialize({
        target: gatewayRegistration.binding,
        revision: `sha256:${'a'.repeat(64)}`,
        sources: [],
        bindings: [{
          targetSlot: 'sources',
          source: { kind: 'safe-literal', value: [] },
        }],
      })).status,
    ).toBe('stale-generation')
    const materialization = await gateway.client.materialize({
      target: gatewayRegistration.binding,
      revision: `sha256:${'3'.repeat(64)}`,
      sources: [{ source: 'source', lease: sourceForGateway.lease }],
      bindings: [
        {
          targetSlot: 'sources',
          targetPointer: '/0',
          source: { kind: 'safe-literal', value: { id: 'source', baseUrl: null, apiKey: null } },
        },
        {
          targetSlot: 'sources',
          targetPointer: '/0/baseUrl',
          source: { kind: 'source-origin', source: 'source', origin: 'api' },
        },
        {
          targetSlot: 'sources',
          targetPointer: '/0/apiKey',
          source: { kind: 'source-authorization', source: 'source' },
        },
      ],
    })
    expect(materialization.status).toBe('accepted')
    if (materialization.status !== 'accepted') throw new Error('gateway materialization failed')
    const gatewayReady = await gatewayRegistration.ensureReady({
      materialization: {
        materializationHandle: materialization.materializationHandle,
        revision: materialization.revision,
      },
    })
    expect(gatewayReady.status).toBe('ready')

    const configPath = path.join(
      home,
      'managed-services',
      'gateway-plugin',
      'gateway-service',
      gatewayRegistration.binding.serviceGeneration,
      'config.json',
    )
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      port: number
      sources: { baseUrl: string; apiKey: string }[]
    }
    expect(config.sources[0]?.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/)
    expect(config.sources[0]?.apiKey).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(config.port).toBeGreaterThan(0)
    expect(JSON.stringify(gatewayReady)).not.toContain(config.sources[0]?.apiKey)
    expect(JSON.stringify(gatewayReady)).not.toContain(configPath)

    const native = prepareNativeManagedGatewayConnection(host, {
      binding: gatewayRegistration.binding,
      compositionOrigin: 'api',
      models: {
        generation: 'catalog-one',
        defaultAlias: 'provider-two',
        aliases: [
          { alias: 'provider-one', gatewayModelId: 'first/shared-model' },
          { alias: 'provider-two', gatewayModelId: 'second/shared-model' },
        ],
      },
    })
    expect(native.value).toMatchObject({
      service: { pluginId: 'gateway-plugin', serviceId: 'gateway-service' },
      endpoint: { apiPath: '/v1', auth: { scheme: 'bearer' } },
      models: {
        generation: 'catalog-one',
        defaultAlias: 'provider-two',
        aliases: [
          { alias: 'provider-one', gatewayModelId: 'first/shared-model' },
          { alias: 'provider-two', gatewayModelId: 'second/shared-model' },
        ],
      },
    })
    expect(native.value.models.aliases[0]?.gatewayModelId).toBe('first/shared-model')
    expect(native.value.models.aliases[1]?.gatewayModelId).toBe('second/shared-model')
    expect(Number(new URL(native.value.endpoint.origin).port)).toBe(config.port)
    native.dispose()

    await expect(denied.registry.register({
      ...definition('denied-service', { configured: true, assignedInConfiguration: true }),
      launch: {
        ...gatewayDefinition.launch,
        arguments: [{ kind: 'host-assigned-loopback', serialization: 'port' }],
      },
    }, { revision: `sha256:${'6'.repeat(64)}` })).rejects.toThrow()

    gateway.client.release(sourceForGateway.lease)
    await source.dispose()
    expect((await gateway.client.acquire(sourceRegistration.binding.identity)).status).toBe('unavailable')
    await Promise.all([gateway.dispose(), denied.dispose()])
  }, 20_000)

  it('never terminates a healthy borrowed fixed-port process', async () => {
    const { root, home } = await fixture()
    const bootstrap = runtime(home)
    const controller = new AbortController()
    const owned = bootstrap.bind({
      owner: owner('borrowed-plugin', 'bootstrap'),
      source: 'https://plugins.example.test/borrowed',
      declaration: declaration('borrowed-service', 'borrowed-plugin', [
        { pluginId: 'borrowed-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, controller.signal)
    const first = await owned.registry.register(definition('borrowed-service', { hostSecret: true }), {
      revision: `sha256:${'4'.repeat(64)}`,
    })
    const ready = await first.ensureReady()
    expect(ready.status).toBe('ready')
    if (ready.status !== 'ready') throw new Error('bootstrap service failed')
    const native = prepareNativeManagedGatewayConnection(bootstrap, {
      binding: first.binding,
      compositionOrigin: 'api',
      models: { generation: 'one', defaultAlias: 'one', aliases: [{ alias: 'one', gatewayModelId: 'one/one' }] },
    })
    const port = Number(new URL(native.value.endpoint.origin).port)

    const borrower = runtime(path.join(home, 'borrower'))
    const borrowed = borrower.bind({
      owner: owner('borrowed-plugin', 'borrower'),
      source: 'https://plugins.example.test/borrowed',
      declaration: declaration('borrowed-service', 'borrowed-plugin', [
        { pluginId: 'borrowed-plugin', operations: ['models.list'] },
      ]),
      artifactDirectory: root,
    }, new AbortController().signal)
    const registration = await borrowed.registry.register(
      definition('borrowed-service', {
        fixedPort: port,
        hostSecret: true,
      }),
      {
        revision: `sha256:${'5'.repeat(64)}`,
      },
    )
    const borrowedReady = await registration.ensureReady()
    expect(borrowedReady.status).toBe('ready')
    if (borrowedReady.status !== 'ready') throw new Error('borrowed service failed')
    expect(borrowedReady.projection.processOwnership).toBe('borrowed')
    expect((await registration.restart()).status).toBe('unavailable')
    await borrowed.dispose()
    const response = await fetch(`${native.value.endpoint.origin}/health`, {
      headers: { Authorization: `Bearer ${native.value.endpoint.auth.token}` },
    })
    expect(response.status).toBe(204)
    native.dispose()
    await owned.dispose()
  }, 20_000)

  it(
    'restarts the gateway with additional upstreams after a new materialization while keeping the registration handle stable',
    async () => {
      // Mirrors the CLIProxy activation order: gateway registers synchronously,
      // first upstream (Aiden) registers and the gateway materializes+starts,
      // then a second upstream (TraeX) arrives and a new materialization must
      // restart the gateway process with the updated configuration.
      const { root, home } = await fixture()
      const host = runtime(home)
      const sourceA = host.bind({
        owner: owner('source-a-plugin', 'source-a-one'),
        source: 'https://plugins.example.test/source-a',
        declaration: declaration('source-a-service', 'source-a-plugin', [
          { pluginId: 'gateway-plugin', operations: ['models.list'] },
        ]),
        artifactDirectory: root,
      }, new AbortController().signal)
      const sourceB = host.bind({
        owner: owner('source-b-plugin', 'source-b-one'),
        source: 'https://plugins.example.test/source-b',
        declaration: declaration('source-b-service', 'source-b-plugin', [
          { pluginId: 'gateway-plugin', operations: ['models.list'] },
        ]),
        artifactDirectory: root,
      }, new AbortController().signal)
      const gateway = host.bind({
        owner: owner('gateway-plugin', 'gateway-one'),
        source: 'https://plugins.example.test/gateway',
        declaration: declaration('gateway-service', 'gateway-plugin', [
          { pluginId: 'gateway-plugin', operations: ['models.list'] },
        ]),
        artifactDirectory: root,
      }, new AbortController().signal)

      // Register upstream A first.
      const regA = await sourceA.registry.register(definition('source-a-service'), {
        revision: `sha256:${'a'.repeat(64)}`,
      })
      expect((await regA.ensureReady()).status).toBe('ready')
      const leaseA = await gateway.client.acquire(regA.binding.identity)
      expect(leaseA.status).toBe('ready')
      if (leaseA.status !== 'ready') throw new Error('lease A unavailable')

      // Register gateway.
      const gatewayDefinition = definition('gateway-service', { configured: true, assignedInConfiguration: true })
      const gatewayReg = await gateway.registry.register(gatewayDefinition, {
        revision: `sha256:${'c'.repeat(64)}`,
      })
      const registrationHandle = gatewayReg.binding.registrationHandle

      // Materialize with upstream A only -> gateway process starts.
      const matA = await gateway.client.materialize({
        target: gatewayReg.binding,
        revision: `sha256:${'1'.repeat(64)}`,
        sources: [{ source: 'source-a', lease: leaseA.lease }],
        bindings: [
          {
            targetSlot: 'sources',
            targetPointer: '/0',
            source: { kind: 'safe-literal', value: { id: 'source-a', baseUrl: null, apiKey: null } },
          },
          {
            targetSlot: 'sources',
            targetPointer: '/0/baseUrl',
            source: { kind: 'source-origin', source: 'source-a', origin: 'api' },
          },
          {
            targetSlot: 'sources',
            targetPointer: '/0/apiKey',
            source: { kind: 'source-authorization', source: 'source-a' },
          },
        ],
      })
      expect(matA.status).toBe('accepted')
      if (matA.status !== 'accepted') throw new Error('matA rejected')
      const readyA = await gatewayReg.ensureReady({
        materialization: { materializationHandle: matA.materializationHandle, revision: matA.revision },
      })
      expect(readyA.status).toBe('ready')
      const genA = gatewayReg.binding.serviceGeneration
      const cfgPathA = path.join(home, 'managed-services', 'gateway-plugin', 'gateway-service', genA, 'config.json')
      const cfgA = JSON.parse(await readFile(cfgPathA, 'utf8')) as { sources: { id: string }[] }
      expect(cfgA.sources).toHaveLength(1)
      expect(cfgA.sources[0]?.id).toBe('source-a')

      // Now upstream B registers (TraeX). Acquire lease and re-materialize with
      // both sources; ensureReady must restart the gateway with a new
      // serviceGeneration and write the merged configuration. Registration
      // handle stays stable.
      const regB = await sourceB.registry.register(definition('source-b-service'), {
        revision: `sha256:${'b'.repeat(64)}`,
      })
      expect((await regB.ensureReady()).status).toBe('ready')
      const leaseB = await gateway.client.acquire(regB.binding.identity)
      expect(leaseB.status).toBe('ready')
      if (leaseB.status !== 'ready') throw new Error('lease B unavailable')

      const matAB = await gateway.client.materialize({
        target: gatewayReg.binding,
        revision: `sha256:${'2'.repeat(64)}`,
        sources: [
          { source: 'source-a', lease: leaseA.lease },
          { source: 'source-b', lease: leaseB.lease },
        ],
        bindings: [
          {
            targetSlot: 'sources',
            targetPointer: '/0',
            source: { kind: 'safe-literal', value: { id: 'source-a', baseUrl: null, apiKey: null } },
          },
          {
            targetSlot: 'sources',
            targetPointer: '/0/baseUrl',
            source: { kind: 'source-origin', source: 'source-a', origin: 'api' },
          },
          {
            targetSlot: 'sources',
            targetPointer: '/0/apiKey',
            source: { kind: 'source-authorization', source: 'source-a' },
          },
          {
            targetSlot: 'sources',
            targetPointer: '/1',
            source: { kind: 'safe-literal', value: { id: 'source-b', baseUrl: null, apiKey: null } },
          },
          {
            targetSlot: 'sources',
            targetPointer: '/1/baseUrl',
            source: { kind: 'source-origin', source: 'source-b', origin: 'api' },
          },
          {
            targetSlot: 'sources',
            targetPointer: '/1/apiKey',
            source: { kind: 'source-authorization', source: 'source-b' },
          },
        ],
      })
      expect(matAB.status).toBe('accepted')
      if (matAB.status !== 'accepted') throw new Error('matAB rejected')
      const readyAB = await gatewayReg.ensureReady({
        materialization: { materializationHandle: matAB.materializationHandle, revision: matAB.revision },
      })
      expect(readyAB.status).toBe('ready')
      // Registration handle is stable; serviceGeneration rotates (invalidating leases).
      expect(gatewayReg.binding.registrationHandle).toBe(registrationHandle)
      expect(gatewayReg.binding.serviceGeneration).not.toBe(genA)
      // New config contains both upstreams.
      const cfgPathAB = path.join(
        home,
        'managed-services',
        'gateway-plugin',
        'gateway-service',
        gatewayReg.binding.serviceGeneration,
        'config.json',
      )
      expect(cfgPathAB).not.toBe(cfgPathA)
      const cfgAB = JSON.parse(await readFile(cfgPathAB, 'utf8')) as { sources: { id: string }[] }
      expect(cfgAB.sources).toHaveLength(2)
      expect(cfgAB.sources.map(s => s.id)).toEqual(['source-a', 'source-b'])
      // Old generation directory was cleaned up.
      await expect(import('node:fs/promises').then(m => m.access(cfgPathA))).rejects.toBeTruthy()
      gateway.client.release(leaseA.lease)
      gateway.client.release(leaseB.lease)
      await Promise.all([sourceA.dispose(), sourceB.dispose(), gateway.dispose()])
    },
    20_000,
  )
})
