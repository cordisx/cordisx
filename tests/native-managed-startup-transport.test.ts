import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { expect, it, vi } from 'vitest'
import { createNativeProviderTransport } from '../packages/cli/assets/launcher/native-provider-transport.mjs'
import { prepareNativeManagedStartupCatalog } from '../packages/cli/assets/launcher/native-managed-startup-catalog.mjs'

it('binds new provider workers to immutable catalog revisions without moving existing sessions', async () => {
  const args = [path.resolve('tests/fixtures/native-catalog-provider-process.mjs'), 'app-server']
  const primary = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const primaryClosed = once(primary, 'close')
  const events: any[] = [], paths: string[] = [], uncertain: unknown[] = []
  const records = new Map<string, { providerId: string; revision: string }>()
  let window: number | undefined = 64_000
  let available = true
  const baseBytes = Buffer.from(JSON.stringify({
    models: [{
      slug: 'fixture-model',
      display_name: 'Fixture',
      supported_in_api: true,
      supported_reasoning_levels: [],
      shell_type: 'shell_command',
      visibility: 'list',
      priority: 1,
      support_verbosity: false,
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      experimental_supported_tools: [],
    }],
  }))
  const transport = createNativeProviderTransport(primary, {
    executable: process.execPath,
    args,
    env: { ...process.env, FIXTURE_UNRELATED_SECRET: 'must-not-leak' },
    workerEnvironment: () => ({ PATH: process.env.PATH, FIXTURE_CATALOG_DELAY: '100' }),
    onlyManagedRouting: true,
    readThreadCatalog: async (threadId: string) => records.get(threadId),
    recordThreadCatalog: async (threadId: string, value: { providerId: string; revision: string }) => {
      const previous = records.get(threadId)
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('CATALOG_RECORD_MISMATCH')
      records.set(threadId, value)
    },
    diagnostic: (event: unknown) => events.push(event),
    uncertain: (id: unknown) => uncertain.push(id),
    managedCatalog: async (providerId: string) => {
      if (providerId === 'configured') return undefined
      if (!available) return { status: 'unavailable', reason: 'model-metadata-unavailable' }
      const result = await prepareNativeManagedStartupCatalog({
        nativeVersion: '0.149.1',
        providerId,
        pluginId: 'plugin',
        serviceId: 'gateway',
        serviceGeneration: 'service-one',
        catalogGeneration: 'catalog-one',
        baseBytes,
        routes: [{
          gatewayModelId: 'fixture-model',
          aliases: ['fixture'],
          ...(window === undefined ? {} : { contextWindow: window }),
        }],
      })
      if (result.status === 'ready') paths.push(result.path)
      return result
    },
  })
  const lines = createInterface({ input: transport.stdout })
  const replies: any[] = [], waiting: ((value: any) => void)[] = []
  lines.on('line', line => {
    const reply = JSON.parse(line), receive = waiting.shift()
    if (receive) receive(reply)
    else replies.push(reply)
  })
  const read = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiting.push(resolve))
  const send = (message: unknown) => transport.stdin.write(JSON.stringify(message) + '\n')
  const start = async (id: string) => {
    send({
      id,
      method: 'thread/start',
      params: {
        modelProvider: 'plugin',
        model: 'fixture-model',
        config: { 'model_providers.plugin': { wire_api: 'responses' } },
      },
    })
    return await read()
  }
  try {
    send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect((await read()).id).toBe('init')
    send({
      id: 'configured',
      method: 'thread/start',
      params: {
        modelProvider: 'configured',
        config: { 'model_providers.configured': { wire_api: 'responses' } },
      },
    })
    expect((await read()).result.pid).toBe(primary.pid)
    const [first, same] = await Promise.all([start('first'), start('same')])
    expect(first.result).toMatchObject({ contextWindow: 64_000, unrelatedSecretPresent: false, catalogVerified: true })
    expect(same.result.catalogVerified).toBe(true)
    expect(same.result.pid).toBe(first.result.pid)
    expect(existsSync(paths[1]!)).toBe(false)
    send({
      id: 'unknown-history',
      method: 'thread/resume',
      params: {
        threadId: 'unknown-history',
        modelProvider: 'plugin',
        model: 'fixture-model',
        config: { 'model_providers.plugin': { wire_api: 'responses' } },
      },
    })
    expect((await read()).error.message)
      .toBe("This conversation's model metadata cannot be verified. Contact an administrator.")
    send({ id: 'same-unload', method: 'thread/unsubscribe', params: { threadId: first.result.thread.id } })
    expect((await read()).result.status).toBe('unsubscribed')
    send({
      id: 'same-resume',
      method: 'thread/resume',
      params: {
        threadId: first.result.thread.id,
        modelProvider: 'plugin',
        model: 'fixture-model',
        config: { 'model_providers.plugin': { wire_api: 'responses' } },
      },
    })
    expect((await read()).result).toMatchObject({ pid: first.result.pid, contextWindow: 64_000 })
    window = 32_000
    const updated = await start('updated')
    expect(updated.result.contextWindow).toBe(32_000)
    expect(updated.result.pid).not.toBe(first.result.pid)
    send({ id: 'old-turn', method: 'turn/start', params: { threadId: first.result.thread.id } })
    expect((await read()).error.message)
      .toBe('Model metadata changed; this conversation cannot safely continue with its previous catalog.')
    send({ id: 'unload', method: 'thread/unsubscribe', params: { threadId: first.result.thread.id } })
    expect((await read()).result.status).toBe('unsubscribed')
    send({
      id: 'resume',
      method: 'thread/resume',
      params: {
        threadId: first.result.thread.id,
        modelProvider: 'plugin',
        model: 'fixture-model',
        config: { 'model_providers.plugin': { wire_api: 'responses' } },
      },
    })
    expect((await read()).error.message)
      .toBe('Model metadata changed; this conversation cannot safely continue with its previous catalog.')
    send({ id: 'unload-sibling', method: 'thread/unsubscribe', params: { threadId: same.result.thread.id } })
    expect((await read()).result.status).toBe('unsubscribed')
    send({
      id: 'resume-after-unload',
      method: 'thread/resume',
      params: {
        threadId: first.result.thread.id,
        modelProvider: 'plugin',
        model: 'fixture-model',
        config: { 'model_providers.plugin': { wire_api: 'responses' } },
      },
    })
    expect((await read()).error.message)
      .toBe('Model metadata changed; this conversation cannot safely continue with its previous catalog.')
    window = undefined
    const unknown = await start('unknown')
    expect(unknown.result.contextWindow).toBeNull()
    expect(unknown.result.pid).not.toBe(updated.result.pid)
    available = false
    const legacy = await start('unavailable')
    expect(legacy.error.message).toBe('Model metadata is unavailable. Contact an administrator or try again later.')
    expect(uncertain).not.toContain('unavailable')
    expect(events).toContainEqual({
      phase: 'managed-catalog-unavailable',
      provider: 'plugin',
      reason: 'model-metadata-unavailable',
    })
  } finally {
    lines.close()
    transport.close()
    primary.kill('SIGTERM')
    await primaryClosed
    await vi.waitFor(() => expect(paths.every(file => !existsSync(file))).toBe(true))
  }
}, 20_000)

it('does not treat an unavailable catalog as an unchanged legacy catalog', async () => {
  const args = [path.resolve('tests/fixtures/native-catalog-provider-process.mjs'), 'app-server']
  const primary = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const primaryClosed = once(primary, 'close')
  let available = true
  const transport = createNativeProviderTransport(primary, {
    executable: process.execPath,
    args,
    env: process.env,
    managedCatalog: async () => available ? undefined : { status: 'unavailable', reason: 'catalog-unavailable' },
  })
  const lines = createInterface({ input: transport.stdout }),
    replies: any[] = [],
    waiting: ((value: any) => void)[] = []
  lines.on('line', line => {
    const reply = JSON.parse(line), receive = waiting.shift()
    if (receive) receive(reply)
    else replies.push(reply)
  })
  const read = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiting.push(resolve))
  const send = (value: unknown) => transport.stdin.write(JSON.stringify(value) + '\n')
  try {
    send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect((await read()).id).toBe('init')
    send({
      id: 'start',
      method: 'thread/start',
      params: {
        modelProvider: 'plugin',
        config: { 'model_providers.plugin': { wire_api: 'responses' } },
      },
    })
    const started = await read()
    available = false
    send({ id: 'turn', method: 'turn/start', params: { threadId: started.result.thread.id } })
    expect((await read()).error.message).toBe(
      'Model metadata is unavailable. Contact an administrator or try again later.',
    )
  } finally {
    lines.close()
    transport.close()
    primary.kill('SIGTERM')
    await primaryClosed
  }
}, 20_000)

it('fences new threads until their catalog record is durable and reports uncertain creation on failure', async () => {
  const args = [path.resolve('tests/fixtures/native-catalog-provider-process.mjs'), 'app-server']
  const primary = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  const primaryClosed = once(primary, 'close')
  const uncertain: unknown[] = [], records = new Map<string, unknown>()
  let releaseRecord = () => {}
  const gate = new Promise<void>(resolve => {
    releaseRecord = resolve
  })
  let failRecord = false
  const baseBytes = Buffer.from(JSON.stringify({
    models: [{
      slug: 'fixture-model',
      display_name: 'Fixture',
      supported_in_api: true,
      supported_reasoning_levels: [],
      shell_type: 'shell_command',
      visibility: 'list',
      priority: 1,
      support_verbosity: false,
      truncation_policy: { mode: 'tokens', limit: 10_000 },
      experimental_supported_tools: [],
    }],
  }))
  const transport = createNativeProviderTransport(primary, {
    executable: process.execPath,
    args,
    env: process.env,
    onlyManagedRouting: true,
    uncertain: (id: unknown) => uncertain.push(id),
    readThreadCatalog: async (threadId: string) => records.get(threadId),
    recordThreadCatalog: async (threadId: string, value: unknown) => {
      if (failRecord) throw new Error('synthetic-write-failure')
      await gate
      records.set(threadId, value)
    },
    managedCatalog: async (providerId: string) =>
      await prepareNativeManagedStartupCatalog({
        nativeVersion: '0.149.1',
        providerId,
        pluginId: 'plugin',
        serviceId: 'gateway',
        serviceGeneration: 'one',
        catalogGeneration: 'one',
        baseBytes,
        routes: [{ gatewayModelId: 'fixture-model', aliases: ['fixture'], contextWindow: 64_000 }],
      }),
  })
  const lines = createInterface({ input: transport.stdout }),
    replies: any[] = [],
    waiting: ((value: any) => void)[] = []
  lines.on('line', line => {
    const reply = JSON.parse(line), receive = waiting.shift()
    if (receive) receive(reply)
    else replies.push(reply)
  })
  const read = () => replies.length ? Promise.resolve(replies.shift()) : new Promise(resolve => waiting.push(resolve))
  const send = (value: unknown) => transport.stdin.write(JSON.stringify(value) + '\n')
  const start = (id: string) =>
    send({
      id,
      method: 'thread/start',
      params: {
        fixtureNotifyStart: true,
        modelProvider: 'plugin',
        model: 'fixture-model',
        config: { 'model_providers.plugin': { wire_api: 'responses' } },
      },
    })
  try {
    send({ id: 'init', method: 'initialize', params: { clientInfo: { name: 'fixture', version: '1' } } })
    expect((await read()).id).toBe('init')
    start('first')
    const started = await read()
    expect(started.method).toBe('thread/started')
    const firstId = started.params.thread.id
    send({ id: 'early-turn', method: 'turn/start', params: { threadId: firstId } })
    expect((await read()).error.message).toBe(
      "This conversation's model metadata cannot be verified. Contact an administrator.",
    )
    expect(records.has(firstId)).toBe(false)
    releaseRecord()
    expect((await read()).result.thread.id).toBe(firstId)
    expect(records.has(firstId)).toBe(true)
    failRecord = true
    start('second')
    const secondStarted = await read(), secondId = secondStarted.params.thread.id
    const failed = await read()
    expect(failed.error.data).toEqual({ type: 'managedCatalogReconciliationRequired', threadId: secondId })
    expect(failed.error.message).toContain('Check thread history before retrying')
    expect(uncertain).toContain('second')
    send({ id: 'failed-turn', method: 'turn/start', params: { threadId: secondId } })
    expect((await read()).error.message).toBe(
      "This conversation's model metadata cannot be verified. Contact an administrator.",
    )
  } finally {
    releaseRecord()
    lines.close()
    transport.close()
    primary.kill('SIGTERM')
    await primaryClosed
  }
}, 20_000)
