import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { prepareNativeManagedStartupCatalog } from '../packages/cli/assets/launcher/native-managed-startup-catalog.mjs'
import { type CodexAppServerRpc, startLocalCodexAppServer } from '../packages/cli/src/providers/codex-app-server.js'
import { prepareHeadlessManagedBaseCatalog } from '../packages/cli/src/launcher/headless-managed-base-catalog.js'
import { HeadlessManagedCatalogBindings } from '../packages/cli/src/launcher/headless-managed-catalog-bindings.js'
import { createHeadlessManagedProviders } from '../packages/cli/src/launcher/headless-managed-providers.js'
import type { ManagedServiceNativeActivation } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'

const executable = process.env.CORDISX_MANAGED_NATIVE_TEST_EXECUTABLE
it.skipIf(!executable)('runs headless managed credentials and model windows through native Codex', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-headless-native-'))
  const environment = {
    PATH: process.env.PATH,
    HOME: root,
    CODEX_HOME: root,
    NO_PROXY: '127.0.0.1,localhost',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
  }
  const auth: string[] = []
  const gateway = createServer((request, response) => {
    request.resume()
    if (request.method !== 'POST') return response.end('{"data":[]}')
    auth.push(request.headers.authorization ?? '')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const item = {
      id: 'fixture',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'fixture', annotations: [] }],
    }
    for (
      const event of [
        { type: 'response.created', response: { id: 'response', status: 'in_progress', output: [] } },
        { type: 'response.output_item.done', output_index: 0, item },
        {
          type: 'response.completed',
          response: {
            id: 'response',
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
    ) response.write('event: ' + event.type + '\ndata: ' + JSON.stringify(event) + '\n\n')
    response.end()
  })
  let native: CodexAppServerRpc | undefined
  let managed: ReturnType<typeof createHeadlessManagedProviders> | undefined
  let base: Awaited<ReturnType<typeof prepareHeadlessManagedBaseCatalog>>
  const bindings = new HeadlessManagedCatalogBindings(path.join(root, 'bindings.json'))
  try {
    await new Promise<void>(resolve => gateway.listen(0, '127.0.0.1', resolve))
    const address = gateway.address()
    if (!address || typeof address === 'string') throw new Error('NO_FIXTURE_GATEWAY')
    base = await prepareHeadlessManagedBaseCatalog({
      nativeVersion: '0.149.1',
      executable: executable!,
      codexHome: root,
      userHome: root,
      environment,
    })
    expect(base).toBeDefined()
    const model = JSON.parse(Buffer.from(base!.bytes).toString()).models[0].slug as string
    let window: number | undefined = 64_000
    const activation = {
      nativeProviderIds: ['fixture'],
      startup: { hasProvider: (id: string) => id === 'fixture' },
      prepareNativeConnection: () => ({
        value: {
          service: { pluginId: 'plugin', serviceId: 'gateway', generation: 'service-one' },
          endpoint: {
            origin: 'http://127.0.0.1:' + address.port,
            apiPath: '/v1',
            auth: { scheme: 'bearer', token: 'synthetic-fixture' },
          },
          models: {
            generation: 'catalog-one',
            defaultAlias: 'fixture',
            aliases: [{
              alias: 'fixture',
              gatewayModelId: model,
              ...(window === undefined ? {} : { contextWindow: window }),
            }],
          },
          cleanup: { authorityId: 'fixture' },
        },
        dispose() {},
      }),
    } as unknown as ManagedServiceNativeActivation
    const catalog = async (providerId: string) => {
      const snapshot = await managed!.snapshot(providerId)
      return await prepareNativeManagedStartupCatalog({ ...snapshot, nativeVersion: '0.149.1', baseBytes: base!.bytes })
    }
    managed = createHeadlessManagedProviders({
      activation,
      reservedProviderIds: new Set(['openai']),
      readThreadCatalog: id => bindings.read(id),
      recordThreadCatalog: (id, value) => bindings.record(id, value),
      verifyNativeProviderScope: async (id, cwd) => {
        const config = await native!.request<{ config: { model_providers: Record<string, unknown> } }>(
          'config/read',
          { cwd: cwd ?? root, includeLayers: false },
        )
        return !Object.hasOwn(config.config.model_providers, id)
      },
      verifyManagedCatalogRevision: async (id, revision) => {
        const current = await catalog(id)
        if (current.status !== 'ready') return false
        try {
          return current.revision === revision
        } finally {
          await current.close()
        }
      },
      report: () => {},
    })
    native = await startLocalCodexAppServer({
      id: 'fixture',
      kind: 'local-codex',
      displayName: 'fixture',
      sourceProviderId: 'codex',
      codexExecutable: executable!,
      codexHome: root,
      enabled: true,
      timeoutMs: 10_000,
    }, {
      environment,
      experimentalApi: true,
      modelCatalogPath: base!.path,
      modelCatalogPreserveProvider: true,
      managedCatalog: catalog,
      readThreadCatalog: id => bindings.read(id),
      recordThreadCatalog: (id, value) => bindings.record(id, value),
    })
    const updates: Array<{ method: string; params: any }> = []
    native.subscribeNotifications?.((method, params) => updates.push({ method, params }))
    const call = (method: 'thread/start' | 'turn/start', params: Record<string, unknown>) =>
      managed!.request(
        method,
        params,
        value => native!.request(method, value),
        id => native!.request('thread/read', { threadId: id, includeTurns: false }),
      )
    const start = async () => {
      const result = await call('thread/start', {
        modelProvider: 'fixture',
        model,
        cwd: root,
        approvalPolicy: 'never',
        sandbox: 'read-only',
      }) as { thread: { id: string } }
      expect((await bindings.read(result.thread.id))?.providerId).toBe('fixture')
      return result.thread.id
    }
    const turn = async (threadId: string, expected: number | null) => {
      const result = await call('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'fixture', text_elements: [] }],
      }) as { turn: { id: string } }
      await vi.waitFor(() => {
        expect(updates.some(row =>
          row.method === 'turn/completed' && row.params.threadId === threadId
          && row.params.turn.id === result.turn.id
        )).toBe(true)
      }, { timeout: 10_000 })
      expect(
        updates.find(row => row.method === 'thread/tokenUsage/updated' && row.params.threadId === threadId)
          ?.params.tokenUsage.modelContextWindow,
      ).toBe(expected)
    }
    const known = await start()
    await turn(known, 60_800)
    window = undefined
    const unknown = await start()
    await turn(unknown, null)
    await expect(call('turn/start', {
      threadId: known,
      input: [{ type: 'text', text: 'fixture', text_elements: [] }],
    })).rejects.toThrow('MANAGED_PROVIDER_CHANGED')
    const ordinary = await call('thread/start', {
      modelProvider: 'openai',
      model,
      cwd: root,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    }) as { thread: { id: string } }
    expect(await bindings.read(ordinary.thread.id)).toBeUndefined()
    expect(auth).toEqual(['Bearer synthetic-fixture', 'Bearer synthetic-fixture'])
  } finally {
    await native?.close()
    await managed?.close()
    await bindings.close()
    await base?.close()
    await new Promise<void>(resolve => gateway.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
}, 45_000)
