import { createHash } from 'node:crypto'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import type { ManagedServiceRegistrationHandleV1 } from '@cordisx/protocol/managed-service-runtime/v1'
import type { ManagedServiceWebEntryUIRegistryV1 } from '@cordisx/protocol/managed-service-web-entry/v1'
import { ManagedServicePluginLifecycleRuntime } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'
import { activateManagedServiceCandidate } from '../packages/cli/src/launcher/managed-service-candidate.js'
import { buildRendererBundle } from '../packages/cli/src/launcher/bundle.js'
import { declaration, definition } from './managed-service-runtime-fixture.js'

declare global {
  var __webEntryTestRegistrations: Map<string, ManagedServiceRegistrationHandleV1> | undefined
}

/** Real Node modules, owned child listeners, production fleet/tokens, built renderer DI and serialized RPC. */
it(
  'delivers each automatic console through the production managed-service composition and revokes it on disposal',
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-web-entry-'))
    const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const server = await readFile(path.join(repository, 'tests/fixtures/managed-service-web-entry-server.mjs'), 'utf8')
    const source = path.join(root, 'server.mjs')
    await writeFile(source, server)
    await chmod(source, 0o700)
    const ids = ['console-one', 'console-two', 'without-console']
    globalThis.__webEntryTestRegistrations = new Map()
    const accesses = []
    for (const pluginId of ids) {
      const value = definition('gateway')
      value.launch = {
        executable: { kind: 'package-relative', path: './server.mjs' },
        arguments: [{ kind: 'host-assigned-loopback', serialization: 'port' }],
        startupTimeoutMs: 5000,
      }
      value.health = { path: '/health', intervalMs: 30_000, timeoutMs: 500 }
      value.operations = [{
        operationId: 'console.info',
        method: 'GET',
        path: '/console',
        requestEncoding: 'query',
        responseSchema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/managed-service-web-entry-source-result.v1.schema.json',
        timeoutMs: 2000,
      }]
      const moduleSource = `
export async function apply(ctx) {
  const registration = await ctx.managedServices.register(${JSON.stringify(value)}, {revision:'sha256:${
        'a'.repeat(64)
      }'})
  if ((await registration.ensureReady()).status !== 'ready') throw new Error('fixture startup failed')
  globalThis.__webEntryTestRegistrations.set('${pluginId}', registration)
}
apply.inject = ['managedServices']
${
        pluginId === 'without-console' ? '' : `export const managedServiceWebEntry = {
  contract:'cordisx.managed-service-web-entry-source/v1', serviceId:'gateway', operationId:'console.info',
  verification:{kind:'shared-instance-hmac-sha256',path:'/proof'}
}`
      }
`
      await writeFile(path.join(root, `${pluginId}.mjs`), moduleSource)
      const serviceDeclaration = {
        ...declaration('gateway', pluginId, []),
        entry: `./${pluginId}.mjs` as const,
        runtimeResources: [{
          path: './server.mjs' as const,
          mode: 'executable' as const,
          byteLength: Buffer.byteLength(server),
          digest: `sha256:${createHash('sha256').update(server).digest('hex')}` as const,
        }],
      }
      accesses.push({
        packageIdentity: { pluginId, version: '1.0.0', integrity: `sha256:${'a'.repeat(64)}` as const },
        pluginIdentity: { source: `https://plugins.example.test/${pluginId}`, pluginId, generation: `${pluginId}-one` },
        serviceId: 'gateway',
        hostGeneration: 'host-one',
        serviceKind: 'managed-backend' as const,
        declaration: serviceDeclaration,
        artifactDirectory: root,
        runtimeEntry: `./${pluginId}.mjs` as const,
      })
    }
    const plugins = ids.map(id => ({
      id,
      enabled: true,
      config: {},
      entry: path.join(repository, 'tests/fixtures/managed-service-ui-plugin.ts'),
      package: {
        version: '1.0.0',
        digest: `sha256:${'a'.repeat(64)}` as const,
        moduleGeneration: `${id}-one`,
        dependencies: [],
      },
    }))
    const record = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/plugin-activation.v1.schema.json',
      schemaVersion: 1 as const,
      recordKind: 'active' as const,
      profileId: 'isolated',
      revision: 1,
      lastGoodRevision: 1,
      runtimeGeneration: 'host-one',
      plugins: plugins.map(plugin => ({ id: plugin.id, ...plugin.package, enabled: true })),
    }
    const lifecycle = new ManagedServicePluginLifecycleRuntime({
      runtime: {} as never,
      profileId: 'isolated',
      runtimeGeneration: 'host-one',
      activate: async (_record, options) =>
        activateManagedServiceCandidate(accesses, {
          ...options,
          homeDir: path.join(root, 'home'),
          environment: { PATH: process.env.PATH },
          profileId: 'isolated',
          runtimeGeneration: 'host-one',
          requireOwnedProcess: true,
        }),
    })
    let dom: JSDOM | undefined
    let renderer: { dispose(): Promise<void> } | undefined
    try {
      await (await lifecycle.initialize(record as never)).adopted
      const bundle = await buildRendererBundle({
        version: 1,
        rootDir: repository,
        codex: { debugPort: 9229 },
        providers: [],
        plugins,
      }, {
        profileId: 'isolated',
        generation: 'host-one',
        pluginActivation: record as never,
        managedServiceUICapabilities: lifecycle.capabilities(),
      })
      dom = new JSDOM('<html><body></body></html>', { runScripts: 'dangerously', url: 'https://codex.local/' })
      Object.assign(dom.window, { structuredClone: globalThis.structuredClone })
      Object.defineProperty(dom.window.HTMLElement.prototype, 'getClientRects', { value: () => ({ length: 1 }) })
      const window = dom.window as unknown as {
        __cordisxManagedServiceUIRequestV1: (payload: string) => void
        __cordisxManagedServiceUIReceiveV1?: (payload: string) => void
        __cordisxBoot: Promise<unknown>
        __cordisxRuntime: { dispose(): Promise<void> }
        __cordisxManagedServiceUIFixtures: { managedServices: ManagedServiceWebEntryUIRegistryV1 }[]
      }
      const requests: string[] = []
      window.__cordisxManagedServiceUIRequestV1 = payload => {
        requests.push(payload)
        void lifecycle.managedServiceUI.handleBindingValue(payload).then(response =>
          window.__cordisxManagedServiceUIReceiveV1?.(JSON.stringify(response))
        )
      }
      dom.window.eval(bundle)
      await window.__cordisxBoot
      renderer = window.__cordisxRuntime
      const services = await Promise.all(window.__cordisxManagedServiceUIFixtures.map(async fixture => {
        const result = await fixture.managedServices.get({ serviceId: 'gateway' })
        expect(result.status).toBe('available')
        if (result.status !== 'available') throw new Error('fixture service unavailable')
        return result.service
      }))
      expect(services).toHaveLength(3)
      const capable = services.filter(service => service.webEntry)
      expect(capable).toHaveLength(2)
      const results = await Promise.all(capable.map(service => service.webEntry!.read()))
      expect(results.every(result => result.status === 'available')).toBe(true)
      const origins = results.flatMap(result => result.status === 'available' ? [result.origin] : [])
      expect(new Set(origins).size).toBe(2)
      expect(await Promise.all(origins.map(origin => fetch(origin).then(response => response.text())))).toEqual([
        'owned-console',
        'owned-console',
      ])
      expect(JSON.stringify(results)).not.toMatch(/instance|proof|challenge|registrationHandle|SERVICE_TOKEN|pid/u)
      const readEnvelope = JSON.parse(requests.find(payload => JSON.parse(payload).operation === 'readWebEntry')!)
      const foreign = await lifecycle.managedServiceUI.handleBindingValue(
        JSON.stringify({
          ...readEnvelope,
          token: lifecycle.capabilities().find(item => item.pluginId !== readEnvelope.binding.identity.pluginId)!.token,
        }),
      )
      expect(foreign.ok).toBe(false)
      const forged = await lifecycle.managedServiceUI.handleBindingValue(
        JSON.stringify({ ...readEnvelope, origin: origins[1] }),
      )
      expect(forged.ok).toBe(false)
      const oldService = capable[0]!
      const pluginId = oldService.binding.identity.pluginId
      const registration = globalThis.__webEntryTestRegistrations!.get(pluginId)!
      expect((await registration.restart()).status).toBe('ready')
      expect(await oldService.webEntry!.read()).toMatchObject({ status: 'unavailable', code: 'stale-generation' })
      const registry = window.__cordisxManagedServiceUIFixtures[services.indexOf(oldService)]!.managedServices
      const reacquired = await registry.get({ serviceId: 'gateway' })
      expect(reacquired.status).toBe('available')
      if (reacquired.status !== 'available') throw new Error('restarted service unavailable')
      expect(reacquired.service.binding).toEqual(oldService.binding)
      expect(reacquired.service.webEntry!.binding.bindingId).not.toBe(oldService.webEntry!.binding.bindingId)
      expect(reacquired.service.webEntry!.serviceGeneration).not.toBe(oldService.webEntry!.serviceGeneration)
      const oldEnvelope = JSON.parse(
        requests.find(payload => {
          const parsed = JSON.parse(payload)
          return parsed.operation === 'readWebEntry' && parsed.binding.identity.pluginId === pluginId
        })!,
      )
      const retarget = await lifecycle.managedServiceUI.handleBindingValue(
        JSON.stringify({
          ...oldEnvelope,
          request: { ...oldEnvelope.request, serviceGeneration: reacquired.service.webEntry!.serviceGeneration },
        }),
      )
      expect(retarget).toMatchObject({ ok: true, value: { status: 'unavailable', code: 'binding-replaced' } })
      const freshEntry = await reacquired.service.webEntry!.read()
      expect(freshEntry.status).toBe('available')
      if (freshEntry.status === 'available') {
        expect(freshEntry.origin).not.toBe(origins[0])
        origins.push(freshEntry.origin)
      }
      await registration.dispose()
      expect((await reacquired.service.webEntry!.read()).status).toBe('unavailable')
      await lifecycle.dispose()
      for (const service of capable) expect((await service.webEntry!.read()).status).toBe('unavailable')
      for (const origin of origins) await expect(fetch(origin, { signal: AbortSignal.timeout(1000) })).rejects.toThrow()
    } finally {
      await renderer?.dispose()
      dom?.window.close()
      await lifecycle.dispose()
      delete globalThis.__webEntryTestRegistrations
      await rm(root, { recursive: true, force: true })
    }
  },
  30_000,
)
