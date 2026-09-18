import { describe, expect, it, vi } from 'vitest'
import { CORDISX_PLUGIN_MANIFEST_SCHEMA_V5 } from '../packages/cli/src/permission-contracts.js'
import type { RuntimeClosureScope } from '../packages/cli/src/renderer/runtime-closure-scope.js'
import { createRuntimeRegisterController } from '../packages/cli/src/renderer/runtime-foundation.js'
import type { PluginController } from '../packages/cli/src/renderer/runtime-shared.js'

const storeDigest = `sha256:${'a'.repeat(64)}` as const
const artifactIntegrity = `sha256:${'b'.repeat(64)}` as const

function register(artifactIntegrityValue?: `sha256:${string}`, development = false) {
  const permissionRegister = vi.fn(() => () => undefined)
  const extensionPointRegister = vi.fn(() => () => undefined)
  const scope = {
    broker: () => ({ register: permissionRegister }),
    extensionPointBroker: () => ({ register: extensionPointRegister }),
    moduleGenerationOf: () => () => 'module-1',
    agentRouteScopes: () => ({ install: vi.fn() }),
    agentOwnerForController: () => () => ({
      source: development ? 'file:///cordisx-local-dev/demo.js' : 'https://plugins.example/demo',
      pluginId: 'demo',
    }),
    configuration: () => ({ register: vi.fn() }),
    configBridge: () => undefined,
  } as unknown as RuntimeClosureScope
  const manifest = {
    $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V5,
    schemaVersion: 5 as const,
    id: 'demo',
    capabilities: [],
    services: [],
  }
  const controller = {
    identity: {
      source: development ? 'file:///cordisx-local-dev/demo.js' : 'https://plugins.example/demo',
      id: 'demo',
    },
    manifest,
    item: {
      id: 'demo',
      source: development ? 'file:///cordisx-local-dev/demo.js' : 'https://plugins.example/demo',
      enabled: true,
      config: {},
      revision: 0,
      manifest,
      package: {
        version: '1.2.3',
        digest: storeDigest,
        ...(artifactIntegrityValue === undefined ? {} : { artifactIntegrity: artifactIntegrityValue }),
        moduleGeneration: 'module-1',
        dependencies: [],
      },
      ...(development
        ? { development: { origin: 'local-dev', pluginId: 'demo', sourcePath: '/tmp/demo.ts', state: 'ready' } }
        : {}),
    },
  } as unknown as PluginController
  createRuntimeRegisterController(scope, controller)
  return permissionRegister
}

describe('renderer artifact certification provenance', () => {
  it('registers an exact downloaded artifact digest instead of the normalized store digest', () => {
    const permissionRegister = register(artifactIntegrity)
    expect(permissionRegister.mock.calls[0]?.[4]).toEqual({ version: '1.2.3', integrity: artifactIntegrity })
  })

  it('does not register a certification artifact for source-built packages', () => {
    const permissionRegister = register(undefined, true)
    expect(permissionRegister.mock.calls[0]?.[4]).toBeUndefined()
    expect(permissionRegister.mock.calls[0]?.[5]).toBe(true)
  })

  it('does not let a non-development package substitute its store digest for distribution provenance', () => {
    const permissionRegister = register()
    expect(permissionRegister.mock.calls[0]?.[4]).toBeUndefined()
    expect(permissionRegister.mock.calls[0]?.[5]).toBe(false)
  })
})
