import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { createInterface } from 'node:readline'
import { promisify } from 'node:util'
import { expect, it, vi } from 'vitest'
import { createNativeProviderTransport } from '../packages/cli/assets/launcher/native-provider-transport.mjs'
import { prepareNativeManagedStartupCatalog } from '../packages/cli/assets/launcher/native-managed-startup-catalog.mjs'

const executable = process.env.CORDISX_MANAGED_CATALOG_NATIVE_EXECUTABLE
it.skipIf(!executable)("uses each provider worker's real startup catalog for known and unknown windows", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-managed-catalog-native-'))
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: root,
    TMPDIR: process.env.TMPDIR,
    NO_PROXY: '127.0.0.1,localhost',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
  }
  const server = createServer((request, response) => {
    request.resume()
    if (request.method !== 'POST') {
      response.end('{"data":[]}')
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const item = {
      id: 'fixture-message',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'fixture', annotations: [] }],
    }
    for (
      const event of [
        { type: 'response.created', response: { id: 'fixture-response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'fixture-response',
            object: 'response',
            status: 'completed',
            output: [item],
            usage: {
              input_tokens: 10,
              output_tokens: 2,
              total_tokens: 12,
              input_tokens_details: { cached_tokens: 0 },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          },
        },
      ]
    ) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })
  let primary: ReturnType<typeof spawn> | undefined
  let transport: ReturnType<typeof createNativeProviderTransport> | undefined
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('FIXTURE_SERVER_UNAVAILABLE')
    const run = promisify(execFile)
    const version = await run(executable!, ['--version'], { env })
    expect(version.stdout.trim()).toBe('codex-cli 0.149.1')
    const bundled = await run(executable!, ['debug', 'models', '--bundled'], { env, maxBuffer: 16 * 1024 * 1024 })
    const baseBytes = Buffer.from(bundled.stdout), model = JSON.parse(bundled.stdout).models[0].slug
    const args = ['app-server', '--stdio']
    primary = spawn(executable!, args, { env, cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    const primaryClosed = once(primary, 'close')
    let window: number | undefined = 64_000
    const records = new Map<string, { providerId: string; revision: string }>()
    transport = createNativeProviderTransport(primary, {
      executable,
      args,
      env,
      cwd: root,
      onlyManagedRouting: true,
      readThreadCatalog: async (threadId: string) => records.get(threadId),
      recordThreadCatalog: async (threadId: string, value: { providerId: string; revision: string }) => {
        const previous = records.get(threadId)
        if (previous && JSON.stringify(previous) !== JSON.stringify(value)) throw new Error('CATALOG_RECORD_MISMATCH')
        records.set(threadId, value)
      },
      managedCatalog: (providerId: string) =>
        prepareNativeManagedStartupCatalog({
          nativeVersion: '0.149.1',
          providerId,
          pluginId: 'plugin',
          serviceId: 'gateway',
          catalogGeneration: 'catalog-one',
          serviceGeneration: 'service-one',
          baseBytes,
          routes: [{
            gatewayModelId: model,
            aliases: ['fixture'],
            ...(window === undefined ? {} : {
              contextWindow: window,
              reasoningCapabilities: { efforts: ['low', 'high'] },
            }),
          }],
        }),
    })
    const lines = createInterface({ input: transport.stdout })
    const pending = new Map<string, (value: any) => void>(), notifications: any[] = []
    lines.on('line', line => {
      const value = JSON.parse(line), resolve = pending.get(value.id)
      if (resolve) {
        pending.delete(value.id)
        resolve(value)
      } else if (value.method) notifications.push(value)
    })
    let sequence = 0
    const request = (method: string, params: unknown) =>
      new Promise<any>(resolve => {
        const id = `fixture-${++sequence}`
        pending.set(id, resolve)
        transport!.stdin.write(JSON.stringify({ id, method, params }) + '\n')
      })
    expect((await request('initialize', { clientInfo: { name: 'fixture', version: '1' } })).error).toBeUndefined()
    transport.stdin.write(JSON.stringify({ method: 'initialized', params: {} }) + '\n')
    const start = async (configuredWindow?: number) => {
      const result = await request('thread/start', {
        modelProvider: 'fixture',
        model,
        cwd: root,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        config: {
          ...(configuredWindow === undefined ? {} : { model_context_window: configuredWindow }),
          'model_providers.fixture': {
            name: 'fixture',
            base_url: `http://127.0.0.1:${address.port}/v1`,
            wire_api: 'responses',
            requires_openai_auth: false,
          },
        },
      })
      expect(result.error).toBeUndefined()
      return result.result.thread.id as string
    }
    const turn = async (threadId: string, expected: number | null) => {
      const before = notifications.filter(event =>
        event.method === 'thread/tokenUsage/updated'
        && event.params.threadId === threadId
      ).length
      const result = await request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'fixture', text_elements: [] }],
      })
      expect(result.error).toBeUndefined()
      await vi.waitFor(() => {
        const updates = notifications.filter(event =>
          event.method === 'thread/tokenUsage/updated'
          && event.params.threadId === threadId
        )
        expect(updates.length).toBeGreaterThan(before)
        expect(updates.at(-1).params.tokenUsage.modelContextWindow).toBe(expected)
      }, { timeout: 10_000 })
      await vi.waitFor(() =>
        expect(notifications.some(event =>
          event.method === 'turn/completed'
          && event.params.threadId === threadId && event.params.turn.id === result.result.turn.id
        )).toBe(true), { timeout: 10_000 })
    }
    const known = await start()
    const knownList = await request('model/list', { threadId: known, limit: 100 })
    const knownModel = knownList.result.data.find((entry: { model: string }) => entry.model === model)
    expect(knownModel.defaultReasoningEffort).toBe('none')
    expect(knownModel.supportedReasoningEfforts.map((entry: { reasoningEffort: string }) => entry.reasoningEffort))
      .toEqual(['low', 'high'])
    await turn(known, 60_800)
    const limited = await start(16_000)
    await turn(limited, 15_200)
    window = undefined
    const unknown = await start()
    const unknownList = await request('model/list', { threadId: unknown, limit: 100 })
    const unknownModel = unknownList.result.data.find((entry: { model: string }) => entry.model === model)
    expect(unknownModel.defaultReasoningEffort).toBe('none')
    expect(unknownModel.supportedReasoningEfforts).toEqual([])
    await turn(unknown, null)
    const stale = await request('turn/start', {
      threadId: known,
      input: [{ type: 'text', text: 'fixture', text_elements: [] }],
    })
    expect(stale.error?.message)
      .toBe('Model metadata changed; this conversation cannot safely continue with its previous catalog.')
    expect((await request('thread/unsubscribe', { threadId: known })).error).toBeUndefined()
    const resumed = await request('thread/resume', {
      threadId: known,
      modelProvider: 'fixture',
      model,
      config: {
        'model_providers.fixture': {
          name: 'fixture',
          base_url: `http://127.0.0.1:${address.port}/v1`,
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    })
    expect(resumed.error?.message)
      .toBe('Model metadata changed; this conversation cannot safely continue with its previous catalog.')
    expect((await request('thread/unsubscribe', { threadId: limited })).error).toBeUndefined()
    const retried = await request('thread/resume', {
      threadId: known,
      modelProvider: 'fixture',
      model,
      config: {
        'model_providers.fixture': {
          name: 'fixture',
          base_url: `http://127.0.0.1:${address.port}/v1`,
          wire_api: 'responses',
          requires_openai_auth: false,
        },
      },
    })
    expect(retried.error?.message)
      .toBe('Model metadata changed; this conversation cannot safely continue with its previous catalog.')
    lines.close()
    transport.close()
    primary.kill('SIGTERM')
    await primaryClosed
    primary = undefined
  } finally {
    transport?.close()
    primary?.kill('SIGTERM')
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 40_000)
