import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { ManagedCatalogComposition } from '../packages/cli/src/launcher/model-catalog/managed-catalog-composition.js'
import type { ManagedServiceNativeActivation } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import type { LauncherKeychainBackend } from '../packages/cli/src/launcher/secret-store.js'
import { startServiceModelApi } from '../packages/cli/src/launcher/service-model-api.js'

class MemoryKeychain implements LauncherKeychainBackend {
  private readonly values = new Map<string, string>()
  async read(service: string, account: string) {
    const value = this.values.get(`${service}/${account}`)
    if (!value) throw new Error('missing')
    return value
  }
  async status(service: string, account: string): Promise<'set' | 'unset'> {
    return this.values.has(`${service}/${account}`) ? 'set' : 'unset'
  }
  async upsert(service: string, account: string, value: string) {
    this.values.set(`${service}/${account}`, value)
  }
  async remove(service: string, account: string) {
    this.values.delete(`${service}/${account}`)
  }
}

it('uses an admitted Host-managed model through the standalone model API', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'cx-managed-model-api-'))
  const configPath = path.join(home, 'config.json')
  const config = createDefaultHomeConfig()
  await writeFile(
    configPath,
    JSON.stringify({
      ...config,
      apps: {
        codex: { defaultProfile: 'fixture', profiles: { fixture: { displayName: 'Fixture', dataMode: 'shared' } } },
      },
    }),
    { mode: 0o600 },
  )
  let authorization: string | undefined
  let upstreamRequests = 0
  const upstream = createServer(async (request, response) => {
    upstreamRequests++
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(chunk)
    authorization = request.headers.authorization
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ model: JSON.parse(Buffer.concat(chunks).toString()).model, output: [] }))
  })
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve))
  let captured = 'fixture-provider-secret'
  const managed = await ManagedCatalogComposition.open({
    homeDir: home,
    profileId: 'fixture',
    keychain: new MemoryKeychain(),
    responsesAvailable: true,
    capture: async () => captured,
  })
  const nativeConnection = managed.nativeConnection.bind(managed)
  let staleScope = false
  let staleRevision = false
  let beforeReturn: (() => Promise<void>) | undefined
  let disposed = 0
  const replaceEndpoint = vi.spyOn(managed, 'nativeConnection').mockImplementation(async id => {
    const session = await nativeConnection(id)
    await beforeReturn?.()
    return {
      ...session,
      dispose() {
        disposed++
        session.dispose()
      },
      value: {
        ...session.value,
        service: {
          ...session.value.service,
          generation: staleScope ? 'stale-scope' : session.value.service.generation,
        },
        models: {
          ...session.value.models,
          generation: staleRevision ? 'stale-revision' : session.value.models.generation,
        },
        endpoint: {
          ...session.value.endpoint,
          origin: `http://127.0.0.1:${(upstream.address() as { port: number }).port}`,
        },
      },
    }
  })
  let api: Awaited<ReturnType<typeof startServiceModelApi>> | undefined
  try {
    expect(
      await managed.command({
        operation: 'createConnection',
        settings: {
          title: 'Fixture',
          endpoint: 'https://fixture.invalid/v1',
          protocol: 'responses',
          discoveryEnabled: false,
          strategy: { kind: 'manual', ids: ['fixture-model'] },
        },
      }, () => true),
    ).toMatchObject({ status: 'applied' })
    await vi.waitFor(() => expect(managed.snapshot().views[0]?.rows).toHaveLength(1))
    const providerId = managed.snapshot().views[0]!.providerId
    const activation = { nativeProviderIds: [] } as unknown as ManagedServiceNativeActivation
    api = await startServiceModelApi({
      homeDir: home,
      configPath,
      profileId: 'fixture',
      environment: { CORDISX_MODEL_API_PORT: '0' },
      activation,
      managed,
    })
    const key = (await readFile(api.accessKeyFile, 'utf8')).trim()
    const headers = { authorization: `Bearer ${key}`, 'content-type': 'application/json' }
    const catalog = await fetch(api.baseUrl + '/models', { headers }).then(response => response.json())
    expect(catalog.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: `${providerId}::fixture-model` })]),
    )
    const request = (model: string, route = '/responses') =>
      fetch(api!.baseUrl + route, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: `${providerId}::${model}`, input: 'synthetic' }),
      })
    expect((await request('not-admitted')).status).toBe(400)
    expect(upstreamRequests).toBe(0)
    staleScope = true
    const stale = await request('fixture-model')
    expect(stale.status).toBe(400)
    expect(await stale.json()).toMatchObject({ error: { message: 'Managed model is unavailable' } })
    expect(disposed).toBe(1)
    expect(upstreamRequests).toBe(0)
    staleScope = false
    staleRevision = true
    const oldRevision = await request('fixture-model')
    expect(oldRevision.status).toBe(400)
    expect(await oldRevision.json()).toMatchObject({ error: { message: 'Managed model is unavailable' } })
    expect(disposed).toBe(2)
    staleRevision = false
    const response = await request('fixture-model')
    expect(response.status, await response.clone().text()).toBe(200)
    expect(await response.json()).toMatchObject({ model: 'fixture-model' })
    expect(authorization).toBe('Bearer fixture-provider-secret')
    expect((await request('fixture-model', '/chat/completions')).status).toBe(400)
    expect(upstreamRequests).toBe(1)
    captured = 'fixture-rotated-secret'
    beforeReturn = async () => {
      const view = managed.snapshot().views[0]!
      expect(
        await managed.command({
          operation: 'requestCredentialReplacement',
          bindingRef: view.bindingRef,
          scopeRevision: view.scopeRevision,
          expectedRevision: view.revision,
        }, () => true),
      ).toMatchObject({ status: 'applied' })
    }
    const rotated = await request('fixture-model')
    expect(rotated.status).toBe(400)
    expect(await rotated.json()).toMatchObject({ error: { message: 'Managed model is unavailable' } })
    expect(upstreamRequests).toBe(1)
    beforeReturn = undefined
    await vi.waitFor(() => expect(managed.admits(providerId, 'fixture-model')).toBe(true))
    const retried = await request('fixture-model')
    expect(retried.status, await retried.clone().text()).toBe(200)
    await retried.text()
    expect(authorization).toBe('Bearer fixture-rotated-secret')
    expect(upstreamRequests).toBe(2)
    beforeReturn = async () => {
      const view = managed.snapshot().views[0]!
      expect(
        await managed.command({
          operation: 'setOverlay',
          bindingRef: view.bindingRef,
          scopeRevision: view.scopeRevision,
          expectedRevision: view.revision,
          modelId: 'fixture-model',
          blocked: true,
        }, () => true),
      ).toMatchObject({ status: 'applied' })
    }
    const blocked = await request('fixture-model')
    expect(blocked.status).toBe(400)
    expect(await blocked.json()).toMatchObject({ error: { message: 'Managed model is unavailable' } })
    expect(upstreamRequests).toBe(2)
    expect(disposed).toBe(7)
  } finally {
    await api?.close()
    replaceEndpoint.mockRestore()
    await managed.close()
    upstream.closeAllConnections()
    await new Promise<void>(resolve => upstream.close(() => resolve()))
    await rm(home, { recursive: true, force: true })
  }
}, 20_000)
