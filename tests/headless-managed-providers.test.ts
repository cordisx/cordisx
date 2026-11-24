import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { describe, expect, it, vi } from 'vitest'
import type { ManagedServiceNativeActivation } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { createHeadlessManagedProviders } from '../packages/cli/src/launcher/headless-managed-providers.js'
import { headlessManagedWorkerEnvironment } from '../packages/cli/src/launcher/headless-managed-worker-environment.js'
import type { NativeManagedGatewayConnectionSession } from '../packages/cli/src/launcher/managed-service-native-connection.js'

const exec = promisify(execFile)
type Row = { model: string; generation: string; token?: string; contextWindow?: number }
function fixture(
  initial: Record<string, Row>,
  reserved: readonly string[] = [],
  onDispose?: (rows: Map<string, Row>) => void,
  evidence = new Map<string, { providerId: string; revision: string }>(),
  failRecord = false,
  refresh?: (reserved: Set<string>) => Promise<boolean>,
  verify?: (providerId: string, revision: string) => Promise<boolean>,
  failRead = false,
  verifyScope?: (providerId: string, cwd: string | undefined) => Promise<boolean>,
) {
  const providers = new Map(Object.entries(initial))
  const known = new Set(providers.keys())
  const report = vi.fn()
  const activation = {
    get nativeProviderIds() {
      return [...providers.keys()]
    },
    startup: { hasProvider: (id: string) => known.has(id) },
    prepareNativeConnection(id: string): NativeManagedGatewayConnectionSession {
      const value = providers.get(id)
      if (!value) throw new Error('unavailable')
      return {
        value: {
          service: { pluginId: 'synthetic-plugin', serviceId: id, generation: value.generation },
          endpoint: {
            origin: 'http://127.0.0.1:1234',
            apiPath: '/v1',
            auth: value.token ? { scheme: 'bearer', token: value.token } : { scheme: 'none' },
          },
          models: {
            generation: value.generation,
            defaultAlias: 'model',
            aliases: [{
              alias: 'model',
              gatewayModelId: value.model,
              ...(value.contextWindow === undefined ? {} : { contextWindow: value.contextWindow }),
            }],
          },
          cleanup: { authorityId: 'synthetic' },
        },
        dispose() {
          onDispose?.(providers)
        },
      }
    },
  } as unknown as ManagedServiceNativeActivation
  const reservedSet = new Set(['openai', ...reserved])
  const sources = createHeadlessManagedProviders({
    activation,
    reservedProviderIds: reservedSet,
    readThreadCatalog: async id => {
      if (failRead) throw new Error('synthetic read failure')
      return evidence.get(id)
    },
    recordThreadCatalog: async (id, binding) => {
      if (failRecord) throw new Error('synthetic failure')
      const previous = evidence.get(id)
      if (previous && JSON.stringify(previous) !== JSON.stringify(binding)) throw new Error('binding conflict')
      evidence.set(id, binding)
    },
    ...(refresh === undefined ? {} : { refreshProviderScope: () => refresh(reservedSet) }),
    ...(verify === undefined ? {} : { verifyManagedCatalogRevision: verify }),
    ...(verifyScope === undefined ? {} : { verifyNativeProviderScope: verifyScope }),
    report,
  })
  return { providers, sources, report, evidence }
}

describe('profile-owned headless managed providers', () => {
  it('checks both existing and requested workspace provider scopes before a managed operation', async () => {
    const scope = vi.fn(async (_id: string, cwd: string | undefined) => cwd !== '/other-project')
    const f = fixture(
      { alpha: { model: 'first', generation: 'one' } },
      [],
      undefined,
      new Map(),
      false,
      undefined,
      undefined,
      false,
      scope,
    )
    const next = vi.fn(async () => ({ thread: { id: 'thread-a' }, model: 'first' }))
    const read = async () => ({ thread: { id: 'thread-a', modelProvider: 'alpha', cwd: '/project' } })
    try {
      await f.sources.request('thread/start', { modelProvider: 'alpha', model: 'first', cwd: '/project' }, next, read)
      await expect(
        f.sources.request('thread/settings/update', { threadId: 'thread-a', cwd: '/other-project' }, next, read),
      )
        .rejects.toThrow('MANAGED_PROVIDER_SCOPE_UNAVAILABLE')
      expect(scope.mock.calls).toEqual([['alpha', '/project'], ['alpha', '/project'], ['alpha', '/other-project']])
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await f.sources.close()
    }
  })
  it('rejects a live catalog revision different from the recorded worker even after an ABA change', async () => {
    const evidence = new Map<string, { providerId: string; revision: string }>()
    const f = fixture(
      { alpha: { model: 'first', generation: 'one' } },
      [],
      undefined,
      evidence,
      false,
      undefined,
      async (_provider, revision) => revision === 'current-A',
    )
    const next = vi.fn(async () => {
      evidence.set('thread-a', { providerId: 'alpha', revision: 'worker-B' })
      return { thread: { id: 'thread-a' }, model: 'first' }
    })
    const read = async () => ({ thread: { id: 'thread-a', modelProvider: 'alpha', model: 'first' } })
    try {
      await f.sources.request('thread/start', { modelProvider: 'alpha', model: 'first' }, next, read)
      await expect(f.sources.request('turn/start', { threadId: 'thread-a' }, next, read))
        .rejects.toThrow('MANAGED_CATALOG_RECONCILIATION_REQUIRED')
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await f.sources.close()
    }
  })
  it('refuses an active plugin thread if native configuration becomes colliding or unreadable', async () => {
    let mode: 'clear' | 'collision' | 'invalid' = 'clear'
    const f = fixture(
      { alpha: { model: 'first', generation: 'one' } },
      [],
      undefined,
      new Map(),
      false,
      async reserved => {
        if (mode === 'invalid') return false
        if (mode === 'collision') reserved.add('alpha')
        else reserved.delete('alpha')
        return true
      },
    )
    const next = vi.fn(async () => ({ thread: { id: 'thread-a' }, model: 'first' }))
    const read = async () => ({ thread: { id: 'thread-a', modelProvider: 'alpha', model: 'first' } })
    try {
      await f.sources.request('thread/start', { modelProvider: 'alpha', model: 'first' }, next, read)
      mode = 'collision'
      await expect(f.sources.request('turn/start', { threadId: 'thread-a' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_COLLISION')
      mode = 'invalid'
      await expect(f.sources.request('turn/start', { threadId: 'thread-a' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_UNAVAILABLE')
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await f.sources.close()
    }
  })
  it('does not record unrelated static sessions and refuses a later ambiguous collision', async () => {
    const f = fixture({}, ['shared'])
    const read = async (id: string) => ({ thread: { id, modelProvider: 'shared' } })
    const next = vi.fn(async () => ({ thread: { id: 'static-thread' }, modelProvider: 'shared' }))
    try {
      await f.sources.request('thread/start', { modelProvider: 'shared', model: 'static-model' }, next, read)
      expect(f.evidence.size).toBe(0)
      f.providers.set('shared', { model: 'plugin-model', generation: 'one' })
      await expect(f.sources.request('thread/resume', { threadId: 'static-thread' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_COLLISION')
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await f.sources.close()
    }
  })
  it('does not turn a successful static creation into a retry when origin evidence cannot be saved', async () => {
    const f = fixture({ shared: { model: 'plugin-model', generation: 'one' } }, ['shared'], undefined, new Map(), true)
    const next = vi.fn(async () => ({ thread: { id: 'static-thread' }, modelProvider: 'shared' }))
    try {
      expect(await f.sources.request('thread/start', { modelProvider: 'shared' }, next, async () => ({})))
        .toMatchObject({ thread: { id: 'static-thread' } })
      expect(f.report).toHaveBeenCalledWith('HEADLESS_STATIC_CATALOG_EVIDENCE_UNAVAILABLE')
      expect(next).toHaveBeenCalledOnce()
      f.providers.set('shared', { model: 'plugin-model', generation: 'one' })
      await expect(f.sources.request('thread/resume', { threadId: 'static-thread' }, next, async () => ({
        thread: { id: 'static-thread', modelProvider: 'shared' },
      }))).rejects.toThrow('MANAGED_PROVIDER_COLLISION')
    } finally {
      await f.sources.close()
    }
  })
  it('does not read managed evidence for an OpenAI session', async () => {
    const f = fixture({}, [], undefined, new Map(), false, undefined, undefined, true)
    const next = vi.fn(async () => ({ turn: { id: 'turn' } }))
    try {
      await f.sources.request('turn/start', { threadId: 'openai-thread' }, next, async () => ({
        thread: { id: 'openai-thread', modelProvider: 'openai' },
      }))
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await f.sources.close()
    }
  })
  it('preserves a successful static fork if recording its collision evidence fails', async () => {
    const evidence = new Map([['source', { providerId: 'shared', revision: 'cordisx-static-provider/v1' }]])
    const f = fixture({ shared: { model: 'plugin-model', generation: 'one' } }, ['shared'], undefined, evidence, true)
    const next = vi.fn(async () => ({ thread: { id: 'forked' } }))
    try {
      expect(
        await f.sources.request('thread/fork', { threadId: 'source' }, next, async () => ({
          thread: { id: 'source', modelProvider: 'shared' },
        })),
      ).toEqual({ thread: { id: 'forked' } })
      expect(f.report).toHaveBeenCalledWith('HEADLESS_STATIC_CATALOG_EVIDENCE_UNAVAILABLE')
      await expect(f.sources.request('thread/resume', { threadId: 'forked' }, next, async () => ({
        thread: { id: 'forked', modelProvider: 'shared' },
      }))).rejects.toThrow('MANAGED_PROVIDER_COLLISION')
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await f.sources.close()
    }
  })
  it('preserves proven static threads and rejects ambiguous collision after restart or revocation', async () => {
    const evidence = new Map<string, { providerId: string; revision: string }>()
    const initial = { shared: { model: 'plugin-model', generation: 'one' } }
    const f = fixture(initial, ['shared'], undefined, evidence)
    const read = async (id: string) => ({ thread: { id, modelProvider: 'shared' } })
    const next = vi.fn(async () => ({ thread: { id: 'static-thread' }, modelProvider: 'shared' }))
    try {
      await f.sources.request('thread/start', { modelProvider: 'shared', model: 'static-model' }, next, read)
      expect(evidence.get('static-thread')).toEqual({ providerId: 'shared', revision: 'cordisx-static-provider/v1' })
      await f.sources.request('turn/start', { threadId: 'static-thread' }, next, read)
      await expect(f.sources.request('thread/resume', { threadId: 'unknown-thread' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_COLLISION')
      evidence.set('managed-thread', { providerId: 'shared', revision: 'managed-revision' })
      await expect(f.sources.request('thread/resume', { threadId: 'managed-thread' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_COLLISION')
    } finally {
      await f.sources.close()
    }
    const restarted = fixture(initial, ['shared'], undefined, evidence)
    try {
      await restarted.sources.request('thread/resume', { threadId: 'static-thread' }, next, read)
      restarted.providers.delete('shared')
      await expect(restarted.sources.request('thread/resume', { threadId: 'managed-thread' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_COLLISION')
    } finally {
      await restarted.sources.close()
    }
  })
  it('never falls back to a static service for a recorded managed thread after the plugin disappears', async () => {
    const evidence = new Map([['old-thread', { providerId: 'shared', revision: 'managed-revision' }]])
    const f = fixture({}, ['shared'], undefined, evidence)
    const next = vi.fn(async () => ({}))
    try {
      await expect(f.sources.request('thread/resume', { threadId: 'old-thread' }, next, async () => ({
        thread: { id: 'old-thread', modelProvider: 'shared' },
      }))).rejects.toThrow('MANAGED_PROVIDER_UNAVAILABLE')
      await f.sources.request('thread/resume', { threadId: 'unrelated' }, next, async () => ({
        thread: { id: 'unrelated', modelProvider: 'shared' },
      }))
      expect(next).toHaveBeenCalledOnce()
    } finally {
      await f.sources.close()
    }
  })
  it('rejects a capability change between catalog and endpoint reads even when generation and aliases match', async () => {
    let calls = 0
    const f = fixture({ alpha: { model: 'first', generation: 'one' } }, [], rows => {
      if (++calls === 1) rows.set('alpha', { model: 'first', generation: 'one', contextWindow: 16_000 })
    })
    try {
      await expect(f.sources.snapshot('alpha')).rejects.toThrow('MANAGED_PROVIDER_UNAVAILABLE')
    } finally {
      await f.sources.close()
    }
  })
  it('exposes current plugin routes, declines colliding static identities, and updates after revocation', async () => {
    const f = fixture({ alpha: { model: 'first', generation: 'one' }, reserved: { model: 'x', generation: 'one' } }, [
      'reserved',
    ])
    try {
      expect((await f.sources.catalog()).map(entry => entry.providerId)).toEqual(['alpha'])
      expect(f.report).toHaveBeenCalledWith('HEADLESS_MANAGED_PROVIDER_COLLISION')
      expect(f.sources.claimed('reserved')).toBe(false)
      f.providers.set('beta', { model: 'second', generation: 'two' })
      expect((await f.sources.catalog()).map(entry => entry.providerId)).toEqual(['alpha', 'beta'])
      f.providers.delete('alpha')
      expect(f.sources.claimed('alpha')).toBe(true)
      await expect(f.sources.snapshot('alpha')).rejects.toThrow('MANAGED_PROVIDER_UNAVAILABLE')
      expect((await f.sources.catalog()).map(entry => entry.providerId)).toEqual(['beta'])
    } finally {
      await f.sources.close()
    }
  })

  it('injects a provider lease only on an admitted exact model and retains it across turns', async () => {
    const f = fixture({ alpha: { model: 'first', generation: 'one', token: 'synthetic-alpha' } })
    let submitted: Record<string, unknown> | undefined
    const next = vi.fn(async (value: Readonly<Record<string, unknown>>) => {
      submitted = value as Record<string, unknown>
      return { thread: { id: 'thread-a' }, model: 'first', modelProvider: 'alpha' }
    })
    const read = async () => ({ thread: { id: 'thread-a', modelProvider: 'alpha', model: 'first' } })
    try {
      await f.sources.request('thread/start', { modelProvider: 'alpha', model: 'first' }, next, read)
      const config = submitted!.config as Record<string, Record<string, unknown>>
      const provider = config['model_providers.alpha']!
      expect(JSON.stringify(provider)).not.toContain('synthetic-alpha')
      const auth = provider.auth as { command: string; args: string[] }
      expect((await exec(auth.command, auth.args)).stdout.trim()).toBe('synthetic-alpha')
      expect(auth.args[1]).toBeTypeOf('string')
      const turn = vi.fn(async () => ({ turn: { id: 'turn-a' } }))
      await f.sources.request('turn/start', { threadId: 'thread-a', input: [] }, turn, read)
      expect(turn).toHaveBeenCalledWith({ threadId: 'thread-a', input: [] })
      f.providers.set('alpha', { model: 'first', generation: 'two', token: 'other' })
      await expect(f.sources.request('turn/start', { threadId: 'thread-a' }, turn, read))
        .rejects.toThrow('MANAGED_PROVIDER_CHANGED')
      expect(turn).toHaveBeenCalledTimes(1)
    } finally {
      await f.sources.close()
    }
  })

  it('retains an uncertain native write lease until close instead of invalidating a possibly started task', async () => {
    const f = fixture({ alpha: { model: 'first', generation: 'one', token: 'synthetic-alpha' } })
    let socket = ''
    try {
      await expect(f.sources.request('thread/start', { modelProvider: 'alpha', model: 'first' }, async value => {
        const config = value.config as Record<string, { auth: { args: string[] } }>
        socket = config['model_providers.alpha']!.auth.args[1]!
        throw new Error('uncertain transport')
      }, async () => ({}))).rejects.toThrow('uncertain transport')
      expect((await lstat(socket)).isSocket()).toBe(true)
    } finally {
      await f.sources.close()
    }
    await expect(lstat(socket)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('rejects missing models, provider spoofing, and an absent lease before a turn', async () => {
    const f = fixture({ alpha: { model: 'first', generation: 'one' }, beta: { model: 'second', generation: 'one' } })
    const next = vi.fn(async () => ({}))
    const read = async () => ({ thread: { id: 'thread-a', modelProvider: 'alpha' } })
    try {
      await expect(f.sources.request('thread/start', { modelProvider: 'alpha', model: 'nope' }, next, read))
        .rejects.toThrow('MANAGED_MODEL_UNAVAILABLE')
      await expect(f.sources.request('thread/resume', { threadId: 'thread-a', modelProvider: 'beta' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_MISMATCH')
      await expect(f.sources.request('turn/start', { threadId: 'thread-a' }, next, read))
        .rejects.toThrow('MANAGED_PROVIDER_CHANGED')
      await expect(
        f.sources.request(
          'thread/start',
          { modelProvider: 'alpha', model: 'first', config: { 'model_providers.alpha': {} } },
          next,
          read,
        ),
      )
        .rejects.toThrow('MANAGED_PROVIDER_CONFIG_CONFLICT')
      expect(next).not.toHaveBeenCalled()
    } finally {
      await f.sources.close()
    }
  })

  it('keeps each static provider worker environment limited to its own saved secrets', () => {
    const services = [
      {
        id: 'alpha',
        apiKeyEnv: 'ALPHA_KEY',
        runtimeOptions: { codex: { env_http_headers: { 'x-auth': 'ALPHA_HEADER' } } },
      },
      { id: 'beta', apiKeyEnv: 'BETA_KEY' },
    ] as Parameters<typeof headlessManagedWorkerEnvironment>[1]
    const environment = { PATH: '/bin', ALPHA_KEY: 'a', ALPHA_HEADER: 'ah', BETA_KEY: 'b', UNRELATED_KEY: 'other' }
    const privateNames = ['ALPHA_KEY', 'ALPHA_HEADER', 'BETA_KEY', 'UNRELATED_KEY']
    expect(headlessManagedWorkerEnvironment(environment, services, 'alpha', privateNames))
      .toEqual({ PATH: '/bin', ALPHA_KEY: 'a', ALPHA_HEADER: 'ah' })
    expect(headlessManagedWorkerEnvironment(environment, services, 'plugin', privateNames))
      .toEqual({ PATH: '/bin' })
  })
})
