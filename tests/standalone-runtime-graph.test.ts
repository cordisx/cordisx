import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildRendererCompositionSource } from '../packages/cli/src/launcher/bundle.js'
import {
  createStandaloneRuntimeGraph,
  isStandaloneRuntimeGraph,
} from '../packages/cli/src/launcher/standalone-runtime-graph.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'

const origin = 'http://127.0.0.1:43123'
const baseUrl = `${origin}/api/renderer/graphs/${'b'.repeat(64)}/`
const descriptor = {
  leaseId: 'a'.repeat(64),
  pluginId: 'generation-base',
  moduleGeneration: 'generation-1',
  baseUrl,
  entryUrl: baseUrl + 'module.js',
  initialStyleUrls: [baseUrl + 'style.css'],
}

it('issues a frozen same-origin runtime graph without original lease source or URLs', () => {
  const graph = createStandaloneRuntimeGraph(descriptor, origin)
  const scope = { origin, pluginId: descriptor.pluginId, generation: descriptor.moduleGeneration }
  expect(isStandaloneRuntimeGraph(graph, scope)).toBe(true)
  expect(Object.isFrozen(graph)).toBe(true)
  expect(graph.loadSource).toContain(descriptor.entryUrl)
  expect(graph.loadSource).not.toContain('cordisx-plugin-artifacts')
  expect(graph.loadSource).not.toMatch(/\beval\s*\(/u)
  expect(isStandaloneRuntimeGraph({ ...graph }, scope)).toBe(false)
  expect(isStandaloneRuntimeGraph(graph, { ...scope, pluginId: 'other' })).toBe(false)
  expect(() => createStandaloneRuntimeGraph({ ...descriptor, entryUrl: 'http://127.0.0.1:9999/module.js' }, origin))
    .toThrow()
  expect(() => createStandaloneRuntimeGraph(descriptor, 'https://example.test')).toThrow()
})

it('accepts only owner-issued graph values matching the active package and manager origin', async () => {
  const graph = createStandaloneRuntimeGraph(descriptor, origin)
  const digest = `sha256:${'c'.repeat(64)}` as const
  const item = {
    id: descriptor.pluginId,
    version: '1.0.0',
    digest,
    moduleGeneration: descriptor.moduleGeneration,
    enabled: true,
    dependencies: [],
  }
  const plugin = {
    id: item.id,
    entry: path.resolve('tests/fixtures/generation-base-plugin.ts'),
    enabled: true,
    config: {},
    package: { version: item.version, digest, moduleGeneration: item.moduleGeneration, dependencies: [] },
    runtimeGraph: graph,
  }
  const config = {
    version: 1 as const,
    rootDir: path.resolve('.'),
    codex: { debugPort: 9229 },
    providers: [],
    plugins: [plugin],
  }
  const activation = {
    $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
    schemaVersion: 1 as const,
    recordKind: 'active' as const,
    profileId: 'work',
    revision: 1,
    lastGoodRevision: 1,
    runtimeGeneration: 'owner-test',
    plugins: [item],
  }
  const owner = {
    rendererId: 'd'.repeat(64),
    profileId: 'work',
    generation: 'owner-test',
    managerOrigin: origin,
    isCurrent: vi.fn(() => true),
  }
  const options = {
    managerPresentationMode: 'standalone' as const,
    standaloneOwner: owner,
    profileId: 'work',
    generation: 'owner-test',
    pluginActivation: activation,
    initialRegistryEpoch: 0,
    permission: { profileId: 'work', policies: [] },
  }
  const composition = await buildRendererCompositionSource(config, options)
  expect(composition.metadataSource).toContain('hostKind: "standalone"')
  expect(composition.source).toContain(descriptor.entryUrl)
  expect(composition.source).not.toContain('cordisx-plugin-artifacts')
  expect(owner.isCurrent).toHaveBeenCalledTimes(2)
  await expect(buildRendererCompositionSource({
    ...config,
    plugins: [{ ...plugin, runtimeGraph: { ...graph } }],
  }, options)).rejects.toThrow('plugin graph projection is unavailable')
  await expect(buildRendererCompositionSource({
    ...config,
    plugins: [{ ...plugin, runtimeGraph: undefined }],
  } as never, options)).rejects.toThrow('plugin graph projection is unavailable')
  await expect(buildRendererCompositionSource(config, {
    ...options,
    standaloneOwner: { ...owner, managerOrigin: 'http://127.0.0.1:43124' },
  })).rejects.toThrow('plugin graph projection is unavailable')
})
