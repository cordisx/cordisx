import { beforeEach, expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V14 } from '../packages/cli/src/launcher/latest-runtime-manifest.js'
import { loadStagedPluginPackage } from '../packages/cli/src/launcher/plugin-package.js'
import {
  inspectServiceRendererInitialPackage,
  loadServiceRendererInitialPackage,
  loadServiceRendererPackage,
} from '../packages/cli/src/cli/service-renderer-projection.js'
import { prepareServiceRendererInstalledGraphs } from '../packages/cli/src/cli/service-renderer-installed-graphs.js'

vi.mock('../packages/cli/src/launcher/plugin-package.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/cli/src/launcher/plugin-package.js')>(),
  loadStagedPluginPackage: vi.fn(),
}))

const item = {
  id: 'fixture-plugin',
  version: '1.0.0',
  digest: `sha256:${'1'.repeat(64)}` as `sha256:${string}`,
  moduleGeneration: 'fixture-generation',
  enabled: true,
  dependencies: [],
}

function staged() {
  const service = { id: 'fixture-service', kind: 'managed-backend', owner: 'host' }
  return {
    manifest: {
      id: item.id,
      version: item.version,
      dependencies: [],
      runtimeManifest: {
        $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V14,
        schemaVersion: 14,
        capabilities: [] as unknown[],
        services: [service],
      },
    },
    serviceModules: [{ declaration: service }],
    managedServiceResources: [{ path: './fixture.mjs' }],
    entityTemplates: [] as unknown[],
    documents: [] as unknown[],
    browserArtifact: {},
  }
}

beforeEach(() => vi.mocked(loadStagedPluginPackage).mockReset())

it('admits the narrow initial managed slice while retaining the dynamic lifecycle gate', async () => {
  const value = staged()
  vi.mocked(loadStagedPluginPackage).mockResolvedValue(value as never)
  expect(await loadServiceRendererInitialPackage('/fixture', item)).toBe(value)
  await expect(loadServiceRendererPackage('/fixture', item)).rejects.toThrow('renderer-projection-plugin-unsupported')
})

it('classifies only owner-matched service-free packages as safe to omit', async () => {
  const safe = staged()
  safe.manifest.runtimeManifest.services = []
  safe.manifest.runtimeManifest.capabilities.push({ name: 'models.read', required: true, scope: {} })
  safe.serviceModules = []
  safe.managedServiceResources = []
  vi.mocked(loadStagedPluginPackage).mockResolvedValueOnce(safe as never)
  expect(await inspectServiceRendererInitialPackage('/fixture', item)).toMatchObject({
    supported: false,
    safeToOmit: true,
  })
  const service = staged()
  service.manifest.runtimeManifest.capabilities.push({ name: 'models.read', required: true, scope: {} })
  vi.mocked(loadStagedPluginPackage).mockResolvedValueOnce(service as never)
  expect(await inspectServiceRendererInitialPackage('/fixture', item)).toMatchObject({
    supported: false,
    safeToOmit: false,
  })
  safe.manifest.id = 'other-plugin'
  vi.mocked(loadStagedPluginPackage).mockResolvedValueOnce(safe as never)
  await expect(inspectServiceRendererInitialPackage('/fixture', item))
    .rejects.toThrow('renderer-projection-plugin-unsupported')
})

it('still rejects an unsupported managed package instead of omitting its service graph', async () => {
  const value = staged()
  value.manifest.runtimeManifest.capabilities.push({ name: 'models.read', required: true, scope: {} })
  vi.mocked(loadStagedPluginPackage).mockResolvedValue(value as never)
  const server = vi.fn()
  await expect(prepareServiceRendererInstalledGraphs({
    homeDir: '/fixture',
    plugins: [item],
    unprojectedConfigIds: new Set([item.id]),
    managedServiceUIAvailable: true,
    leases: [],
    server,
    current: () => true,
  })).rejects.toThrow('renderer-bootstrap-plugin-unsupported')
  expect(server).not.toHaveBeenCalled()
})

it('admits mixed Host services with optional Platform declarations only for the initial projection', async () => {
  const value = staged()
  const provider = { id: 'fixture-provider', kind: 'platform-provider', owner: 'host' }
  value.manifest.runtimeManifest.services.push(provider)
  value.serviceModules.push({ declaration: provider })
  value.manifest.runtimeManifest.capabilities.push(
    { name: 'models.read', required: false, scope: {} },
    { name: 'turns.submit', required: false, scope: { runtime: 'exact-request' } },
  )
  vi.mocked(loadStagedPluginPackage).mockResolvedValue(value as never)
  expect(await loadServiceRendererInitialPackage('/fixture', item)).toBe(value)
  await expect(loadServiceRendererPackage('/fixture', item)).rejects.toThrow('renderer-projection-plugin-unsupported')
})

it('rejects declared permissions, unrelated services, documents and mismatched owner metadata', async () => {
  const cases = [
    () => {
      const value = staged()
      value.manifest.runtimeManifest.capabilities.push({ id: 'fixture-permission' })
      return value
    },
    () => {
      const value = staged()
      value.manifest.runtimeManifest.capabilities.push({ name: 'models.read', required: true, scope: {} })
      return value
    },
    () => {
      const value = staged()
      value.manifest.runtimeManifest.capabilities.push({ name: 'connector.send', required: false, scope: {} })
      return value
    },
    () => {
      const value = staged()
      value.manifest.runtimeManifest.services[0]!.kind = 'platform-provider'
      return value
    },
    () => {
      const value = staged()
      value.manifest.runtimeManifest.services[0]!.owner = 'foreign'
      return value
    },
    () => {
      const value = staged()
      value.serviceModules = []
      return value
    },
    () => {
      const value = staged()
      value.entityTemplates.push({})
      return value
    },
    () => {
      const value = staged()
      value.documents.push({})
      return value
    },
    () => {
      const value = staged()
      value.manifest.id = 'other-plugin'
      return value
    },
  ]
  for (const create of cases) {
    vi.mocked(loadStagedPluginPackage).mockResolvedValueOnce(create() as never)
    await expect(loadServiceRendererInitialPackage('/fixture', item)).rejects.toThrow(
      'renderer-projection-plugin-unsupported',
    )
  }
})
