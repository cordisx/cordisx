import type { spawn as nodeSpawn } from 'node:child_process'
import { rm } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import { managedServiceStartupGroups } from '../packages/cli/src/launcher/managed-service-startup-groups.js'
import {
  declaration,
  deferred,
  definition,
  fixture,
  owner,
  runtime,
  syntheticChild,
} from './managed-service-runtime-fixture.js'

describe('managed startup boundaries', () => {
  it('cancels a pending readiness probe without reporting a timeout or retaining its child', async () => {
    const { root, home } = await fixture()
    const entered = deferred<void>()
    const diagnostic = vi.fn()
    const child = syntheticChild({ exitOnKill: 'SIGTERM' })
    const host = runtime(home, {
      onStartupDiagnostic: diagnostic,
      spawn: (() => child.child) as typeof nodeSpawn,
      fetch: async (_url, init) => {
        entered.resolve()
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
        })
      },
    })
    const binding = host.bind({
      owner: owner('cancel-test', 'one'),
      source: 'https://plugins.example.test/cancel',
      declaration: declaration('cancel', 'cancel-test', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    try {
      const registration = await binding.registry.register(definition('cancel'), {
        revision: `sha256:${'d'.repeat(64)}`,
      })
      const controller = new AbortController()
      const ready = registration.ensureReady({ signal: controller.signal })
      await entered.promise
      controller.abort()
      expect((await ready).status).toBe('cancelled')
      expect(diagnostic).not.toHaveBeenCalled()
      expect(child.signals).toContain('SIGTERM')
    } finally {
      await binding.dispose()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('groups same-plugin modules and transitive dependencies without grouping independent services', () => {
    const states = ['gateway', 'source', 'source-ui', 'independent']
    expect(managedServiceStartupGroups(
      states,
      state => state === 'source-ui' ? 'source' : state,
      state => state === 'gateway' ? ['source'] : [],
    )).toEqual([['gateway', 'source', 'source-ui'], ['independent']])
  })

  it.each(['timeout', 'exit', 'spawn', 'sync-spawn'] as const)(
    'reports %s safely and cleans the failed generation',
    async mode => {
      const { root, home } = await fixture()
      const diagnostic = vi.fn()
      const controlled = syntheticChild({ exitOnKill: 'SIGTERM' })
      if (mode === 'spawn') Object.assign(controlled.child, { pid: undefined })
      const host = runtime(home, {
        onStartupDiagnostic: diagnostic,
        spawn: (() => {
          if (mode === 'sync-spawn') throw new Error('secret-key /private/path')
          if (mode === 'exit') queueMicrotask(() => controlled.exit(7))
          if (mode === 'spawn') queueMicrotask(() => controlled.fail(new Error('secret-key /private/path')))
          return controlled.child
        }) as typeof nodeSpawn,
        fetch: async () => new Response(null, { status: 503 }),
      })
      const binding = host.bind({
        owner: owner('startup-test', 'one'),
        source: 'https://plugins.example.test/startup',
        declaration: declaration('startup', 'startup-test', []),
        artifactDirectory: root,
      }, new AbortController().signal)
      try {
        const value = definition('startup')
        value.launch = {
          executable: { kind: 'named-command', command: 'synthetic' },
          arguments: [{ kind: 'host-assigned-loopback', serialization: 'port' }],
          startupTimeoutMs: 100,
        }
        const registration = await binding.registry.register(value, { revision: `sha256:${'a'.repeat(64)}` })
        expect(await registration.ensureReady()).toMatchObject({
          status: 'failed',
          diagnostic: { code: 'launch-failed', retryable: true },
        })
        expect(diagnostic).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
          pluginId: 'startup-test',
          serviceId: 'startup',
          reason: mode === 'timeout' ? 'startup-timeout' : mode === 'exit' ? 'process-exited' : 'spawn-error',
          elapsedMs: expect.any(Number),
          timeoutMs: 100,
          ...(mode === 'exit' ? { exitCode: 7 } : {}),
        }))
        expect(JSON.stringify(diagnostic.mock.calls)).not.toMatch(/secret-key|private\/path/)
        if (mode === 'timeout') expect(controlled.signals).toContain('SIGTERM')
        expect(await registration.inspect()).toMatchObject({ state: 'failed', health: 'unhealthy' })
      } finally {
        await binding.dispose()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('bounds a hanging health probe by the remaining startup budget and retries successfully', async () => {
    const { root, home } = await fixture()
    const diagnostic = vi.fn()
    const children: ReturnType<typeof syntheticChild>[] = []
    let healthy = false
    const host = runtime(home, {
      onStartupDiagnostic: diagnostic,
      spawn: (() => {
        const controlled = syntheticChild({ exitOnKill: 'SIGTERM' })
        children.push(controlled)
        return controlled.child
      }) as typeof nodeSpawn,
      fetch: async (_url, init) => {
        if (healthy) return new Response(null, { status: 204 })
        return await new Promise<Response>((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
        })
      },
    })
    const binding = host.bind({
      owner: owner('startup-test', 'one'),
      source: 'https://plugins.example.test/startup',
      declaration: declaration('startup', 'startup-test', []),
      artifactDirectory: root,
    }, new AbortController().signal)
    try {
      const value = definition('startup')
      value.launch = {
        executable: { kind: 'named-command', command: 'synthetic' },
        arguments: [{ kind: 'host-assigned-loopback', serialization: 'port' }],
        startupTimeoutMs: 100,
      }
      value.health = { ...value.health, timeoutMs: 5_000 }
      const registration = await binding.registry.register(value, { revision: `sha256:${'b'.repeat(64)}` })
      const started = performance.now()
      expect((await registration.ensureReady()).status).toBe('failed')
      expect(performance.now() - started).toBeLessThan(2_000)
      expect(diagnostic.mock.calls[0]![0].reason).toBe('startup-timeout')
      expect(children[0]!.signals).toContain('SIGTERM')
      healthy = true
      expect((await registration.ensureReady()).status).toBe('ready')
      expect(children).toHaveLength(2)
      expect((await registration.inspect()).diagnostic).toBeUndefined()
    } finally {
      await binding.dispose()
      await rm(root, { recursive: true, force: true })
    }
    expect(children[1]!.signals).toContain('SIGTERM')
  })
})
