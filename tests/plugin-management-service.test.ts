import { createHash } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { c as createTar } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ensureHomeConfig, updateHomeConfigAtomic } from '../packages/cli/src/config/home-config.js'
import { updatePluginManagementConfig } from '../packages/cli/src/management/persistence.js'
import { openPluginManagementService } from '../packages/cli/src/management/service.js'
import { createPermissionPolicyRecord } from '../packages/cli/src/permissions.js'
import { removeStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import { FakeRuntime, localPackage, localPackageV4 } from './suites/plugin-lifecycle.fixtures.js'

const roots: string[] = []
const servers: Server[] = []

async function fixture(watch = false) {
  const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-management-service-'))
  roots.push(homeDir)
  const configPath = path.join(homeDir, 'config.json')
  await ensureHomeConfig(configPath)
  const service = await openPluginManagementService({ configPath, homeDir, profileId: 'default', watch })
  return { homeDir, configPath, service }
}

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(
    roots.splice(0).map(async root => {
      const digests = await readdir(path.join(root, 'packages', 'sha256')).catch(() => [])
      await Promise.all(digests.map(async digest => {
        await removeStagedPluginPackage(root, `sha256:${digest}`)
      }))
      await rm(root, { recursive: true, force: true })
    }),
  )
})

async function executePlan(
  service: Awaited<ReturnType<typeof openPluginManagementService>>,
  request: Parameters<typeof service.plan>[0],
) {
  const planned = await service.plan(request)
  expect(planned.status).toBe('planned')
  expect(planned.executionRequest).toMatchObject({ kind: 'plugin-execute-plan' })
  return await service.execute(planned.executionRequest!)
}

async function listen(
  handler: Parameters<typeof createServer>[0],
): Promise<{ readonly server: Server; readonly url: string }> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('test server did not bind')
  return { server, url: `http://127.0.0.1:${address.port}` }
}

describe('plugin management service', () => {
  it('plans config without persistence and executes through the shared home document', async () => {
    const { service } = await fixture()
    const request = {
      kind: 'source-add' as const,
      source: { url: 'http://localhost:4173/feed.json', enabled: true },
    }
    expect((await service.plan(request)).status).toBe('planned')
    expect((await service.query()).sources).toHaveLength(1)
    const applied = await service.execute(request)
    expect(applied).toMatchObject({ status: 'applied', pendingActivation: false })
    expect(applied.snapshot.sources.map(source => source.url)).toContain(request.source.url)
    service.close()
  })

  it('returns an inactive runtime snapshot without inventing a second plugin database', async () => {
    const { service } = await fixture()
    expect(await service.query()).toMatchObject({
      runtime: { kind: 'inactive', pendingActivation: false },
      activationRevision: 0,
      plugins: [],
    })
    service.close()
  })

  it('projects a missing immutable package as failed even with an active lifecycle', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-management-active-'))
    roots.push(homeDir)
    const configPath = path.join(homeDir, 'config.json')
    await ensureHomeConfig(configPath)
    const runtimeGeneration = 'active-test'
    const activeRoot = path.join(homeDir, 'state/profiles/default/plugins')
    await mkdir(activeRoot, { recursive: true })
    await writeFile(
      path.join(activeRoot, 'active.json'),
      JSON.stringify({
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1,
        recordKind: 'active',
        profileId: 'default',
        revision: 1,
        lastGoodRevision: 1,
        runtimeGeneration,
        plugins: [{
          id: 'missing-package',
          version: '1.0.0',
          digest: `sha256:${'0'.repeat(64)}`,
          moduleGeneration: 'missing-generation',
          enabled: true,
          dependencies: [],
        }],
      }),
    )
    const coordinator = new PluginLifecycleCoordinator({
      homeDir,
      profileId: 'default',
      runtimeGeneration,
      permissionPolicies: [],
      runtime: new FakeRuntime(),
    })
    await coordinator.prepareRecovery()
    const service = await openPluginManagementService({
      configPath,
      homeDir,
      profileId: 'default',
      watch: false,
      lifecycle: { coordinator, runtimeGeneration },
    })
    expect((await service.query()).plugins[0]).toMatchObject({
      id: 'missing-package',
      status: 'failed',
      error: { code: 'package-unavailable' },
    })
    service.close()
  })

  it('opens and plans against read-only defaults without materializing a fresh home', async () => {
    const homeDir = await mkdtemp(path.join(os.tmpdir(), 'cordisx-management-fresh-'))
    roots.push(homeDir)
    const configPath = path.join(homeDir, 'config.json')
    const service = await openPluginManagementService({ configPath, homeDir, profileId: 'default', watch: false })
    expect((await service.query()).revision).toBe(0)
    expect(
      (await service.plan({
        kind: 'source-add',
        source: { url: 'http://localhost:4173/feed.json', enabled: true },
      })).status,
    ).toBe('planned')
    await expect(stat(configPath)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(path.join(homeDir, 'state'))).rejects.toMatchObject({ code: 'ENOENT' })
    service.close()
  })

  it('persists offline install, disable, and uninstall with pending activation projection', async () => {
    const { homeDir, service } = await fixture()
    const packageRoot = await localPackage({ root: homeDir, id: 'offline-roundtrip' })
    const installed = await executePlan(service, { kind: 'plugin-plan-local', sourceDirectory: packageRoot })
    expect(installed).toMatchObject({ status: 'applied', pendingActivation: true })
    expect((await service.query()).plugins).toMatchObject([{
      id: 'offline-roundtrip',
      enabled: true,
      status: 'pending-activation',
    }])

    const disabled = await executePlan(service, { kind: 'plugin-disable', pluginId: 'offline-roundtrip' })
    expect(disabled).toMatchObject({ status: 'applied', pendingActivation: true })
    service.close()

    const reopened = await openPluginManagementService({
      configPath: path.join(homeDir, 'config.json'),
      homeDir,
      profileId: 'default',
      watch: false,
    })
    expect((await reopened.query()).plugins).toMatchObject([{
      id: 'offline-roundtrip',
      enabled: false,
      status: 'disabled',
    }])
    expect(await executePlan(reopened, { kind: 'plugin-uninstall', pluginId: 'offline-roundtrip' }))
      .toMatchObject({ status: 'applied', pendingActivation: true })
    expect((await reopened.query()).plugins).toEqual([])
    reopened.close()
  })

  it('exposes the dependent closure during destructive planning and executes that exact plan', async () => {
    const { homeDir, service } = await fixture()
    const dependency = await localPackage({ root: homeDir, id: 'dependency' })
    const dependent = await localPackage({
      root: homeDir,
      id: 'dependent',
      dependencies: [{ id: 'dependency', version: '1.0.0' }],
    })
    expect(await executePlan(service, { kind: 'plugin-plan-local', sourceDirectory: dependency }))
      .toMatchObject({ status: 'applied' })
    expect(await executePlan(service, { kind: 'plugin-plan-local', sourceDirectory: dependent }))
      .toMatchObject({ status: 'applied' })

    service.close()
    const authorityRoot = path.join(homeDir, 'state/profiles/default/package-authority')
    await rm(authorityRoot, { recursive: true, force: true })
    const reopened = await openPluginManagementService({
      configPath: path.join(homeDir, 'config.json'),
      homeDir,
      profileId: 'default',
      watch: false,
    })
    const activePath = path.join(homeDir, 'state/profiles/default/plugins/active.json')
    const activeBeforePlanning = await readFile(activePath, 'utf8')
    const activeMtimeBeforePlanning = (await stat(activePath)).mtimeMs
    const planned = await reopened.plan({ kind: 'plugin-disable', pluginId: 'dependency' })
    expect(planned).toMatchObject({
      status: 'planned',
      affectedPluginIds: ['dependency', 'dependent'],
    })
    expect(await readFile(activePath, 'utf8')).toBe(activeBeforePlanning)
    expect((await stat(activePath)).mtimeMs).toBe(activeMtimeBeforePlanning)
    await expect(stat(authorityRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await reopened.execute(planned.executionRequest!)).toMatchObject({ status: 'applied' })
    expect((await reopened.query()).plugins.map(plugin => [plugin.id, plugin.enabled])).toEqual([
      ['dependency', false],
      ['dependent', false],
    ])
    reopened.close()
  })

  it('auto-applies a previously allowed V1 declaration but stops for a new decision', async () => {
    const { homeDir, configPath, service } = await fixture()
    const allowedRoot = await localPackage({ root: homeDir, id: 'allowed-capability', requiredCapability: true })
    const inspected = await service.plan({ kind: 'plugin-plan-local', sourceDirectory: allowedRoot })
    const first = await service.execute(inspected.executionRequest!)
    expect(first).toMatchObject({ status: 'permission-review-required' })
    expect((await service.query()).activationRevision).toBe(0)
    service.close()

    const permissionPlan = first.status === 'permission-review-required' ? first.permissionPlan : undefined
    expect(permissionPlan?.schemaVersion).toBe(1)
    await updateHomeConfigAtomic(config => ({
      ...config,
      permissions: [createPermissionPolicyRecord({
        profileId: 'default',
        identity: {
          source: permissionPlan!.schemaVersion === 1 ? permissionPlan.identity.source : '',
          id: 'allowed-capability',
        },
        capability: 'models.read',
        scope: {},
        policy: 'allow',
      })],
    }), configPath)
    const reopened = await openPluginManagementService({ configPath, homeDir, profileId: 'default', watch: false })
    expect(await executePlan(reopened, { kind: 'plugin-plan-local', sourceDirectory: allowedRoot }))
      .toMatchObject({ status: 'applied' })
    expect((await reopened.query()).activationRevision).toBe(1)
    reopened.close()
  })

  it.each(['deny', 'ask'] as const)(
    'does not upgrade a persisted V1 %s policy during automatic execution',
    async policy => {
      const { homeDir, configPath, service } = await fixture()
      const sourceDirectory = await localPackage({
        root: homeDir,
        id: `persisted-${policy}`,
        requiredCapability: true,
      })
      const firstPlan = await service.plan({ kind: 'plugin-plan-local', sourceDirectory })
      const first = await service.execute(firstPlan.executionRequest!)
      expect(first).toMatchObject({ status: 'permission-review-required' })
      const permissionPlan = first.status === 'permission-review-required' ? first.permissionPlan : undefined
      expect(permissionPlan?.schemaVersion).toBe(1)
      await updateHomeConfigAtomic(config => ({
        ...config,
        permissions: [createPermissionPolicyRecord({
          profileId: 'default',
          identity: {
            source: permissionPlan!.schemaVersion === 1 ? permissionPlan.identity.source : '',
            id: `persisted-${policy}`,
          },
          capability: 'models.read',
          scope: {},
          policy,
        })],
      }), configPath)

      const planned = await service.plan({ kind: 'plugin-plan-local', sourceDirectory })
      const result = await service.execute(planned.executionRequest!)
      expect(result).toMatchObject({ status: 'rejected', error: { code: 'permission-denied' } })
      expect((await service.query()).activationRevision).toBe(0)
      service.close()
    },
  )

  it('refreshes one configured source and creates a verified marketplace candidate', async () => {
    const { homeDir, service } = await fixture()
    const source = await localPackageV4(homeDir)
    const archiveRoot = path.join(homeDir, 'archive')
    await mkdir(path.join(archiveRoot, 'package'), { recursive: true })
    await cp(source, path.join(archiveRoot, 'package'), { recursive: true })
    const canonicalSource = 'https://github.com/example/permission-v4'
    const cordisxPackagePath = path.join(archiveRoot, 'package', 'cordisx-package.json')
    const cordisxPackage = JSON.parse(await readFile(cordisxPackagePath, 'utf8')) as Record<string, unknown>
    await writeFile(cordisxPackagePath, JSON.stringify({ ...cordisxPackage, canonicalSource }))
    await writeFile(
      path.join(archiveRoot, 'package', 'package.json'),
      JSON.stringify({ name: '@example/permission-v4', version: '1.0.0' }),
    )
    const archive = path.join(homeDir, 'permission-v4.tgz')
    await createTar({ cwd: archiveRoot, file: archive, gzip: true }, ['package'])
    const bytes = await readFile(archive)
    const integrity = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
    const artifactUrl = 'https://registry.example/permission-v4-1.0.0.tgz'
    let feed: Record<string, unknown>
    const requests: string[] = []
    const http = await listen((request, response) => {
      requests.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(feed))
    })
    const sourceUrl = `${http.url}/marketplace.json`
    feed = {
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-feed.v3.schema.json',
      schemaVersion: 3,
      fallbackLocale: 'en',
      localizations: {},
      generatedAt: '2026-09-18T00:00:00.000Z',
      trust: {
        authority: 'cordisx.marketplace.codeowners/v1',
        root: 'https://example.com/marketplace.json',
        grantModel: 'protected-merge-chain-v1',
        cryptographicAttestation: 'unsupported',
      },
      name: 'Local test feed',
      homepage: 'https://example.com/marketplace',
      official: [],
      certifications: [],
      plugins: [{
        $schema:
          'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/marketplace-plugin.v3.schema.json',
        schemaVersion: 3,
        id: 'permission-v4',
        fallbackLocale: 'en',
        name: 'Permission V4',
        description: 'Exercises the management artifact pipeline.',
        localizations: {},
        version: '1.0.0',
        source: canonicalSource,
        artifact: {
          publisherIdentity: 'npm:@example',
          packageNamespace: '@example',
          packageName: '@example/permission-v4',
          downloadUrl: artifactUrl,
          integrity,
        },
        license: 'MIT',
        compatibility: { cordisx: '^0.1.0' },
        authors: [{ name: 'Example' }],
        keywords: ['example'],
      }],
    }
    await service.execute({ kind: 'source-add', source: { url: sourceUrl, enabled: true } })
    expect(await service.refreshCatalog(sourceUrl)).toMatchObject({
      sources: [{ url: sourceUrl, status: 'loaded', pluginCount: 1 }],
      plugins: [{ identity: { sourceUrl, pluginId: 'permission-v4' }, installable: true }],
    })
    expect(requests).toEqual(['/marketplace.json'])
    await expect(service.refreshCatalog(`${http.url}/unknown.json`)).rejects.toThrow('does not exist')
    expect(requests).toEqual(['/marketplace.json'])

    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: URL | string) => {
        expect(String(url)).toBe(artifactUrl)
        return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.byteLength) } })
      }),
    )
    const planned = await service.plan({
      kind: 'plugin-plan-marketplace',
      pluginId: 'permission-v4',
      sourceUrl,
    })
    const result = await service.execute(planned.executionRequest!)
    expect(result).toMatchObject({ status: 'permission-review-required', candidateId: expect.any(String) })
    expect((await service.query()).activationRevision).toBe(0)
    if (result.status === 'permission-review-required') {
      await expect(stat(path.join(homeDir, 'state/profiles/default/plugins/candidates', `${result.candidateId}.json`)))
        .resolves.toBeDefined()
    }
    service.close()
  })

  it('confirms legacy migration only after durable readback', async () => {
    const { service } = await fixture()
    const first = await service.migrateLegacySources({
      sources: [{ url: 'http://localhost:4173/legacy.json', enabled: true }],
    })
    expect(first).toMatchObject({ migrated: true, clearLegacyStorage: true })
    expect(first.snapshot.migrations.legacyBrowserSourcesV2).toBe(true)
    const second = await service.migrateLegacySources({
      sources: [{ url: 'http://localhost:5173/must-not-return.json', enabled: true }],
    })
    expect(second.migrated).toBe(false)
    expect(second.snapshot.sources.some(source => source.url.includes('must-not-return'))).toBe(false)
    service.close()
  })

  it('subscribes across consecutive atomic config replacements', async () => {
    const { service, configPath } = await fixture(true)
    const revisions: number[] = []
    const unsubscribe = service.subscribe(snapshot => revisions.push(snapshot.revision))
    await updatePluginManagementConfig({ configPath, profileId: 'default' }, {
      kind: 'source-add',
      source: { url: 'http://localhost:4173/first.json', enabled: true },
    })
    await expect.poll(() => revisions.at(-1)).toBe(1)
    await updatePluginManagementConfig({ configPath, profileId: 'default' }, {
      kind: 'source-edit',
      url: 'http://localhost:4173/first.json',
      source: { url: 'http://localhost:4173/second.json', enabled: false },
    })
    await expect.poll(() => revisions.at(-1)).toBe(2)
    unsubscribe()
    service.close()
  })

  it('does not emit unchanged snapshots while the fallback observer is idle', async () => {
    const { service } = await fixture(true)
    const snapshots: number[] = []
    const unsubscribe = service.subscribe(snapshot => snapshots.push(snapshot.revision))
    await new Promise(resolve => setTimeout(resolve, 300))
    expect(snapshots).toEqual([])
    unsubscribe()
    service.close()
  })
})
