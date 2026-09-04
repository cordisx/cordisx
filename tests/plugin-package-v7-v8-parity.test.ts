import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V7,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V8,
} from '../packages/cli/src/permission-contracts.js'
import {
  normalizePluginManifestV7,
  normalizePluginManifestV8,
} from '../packages/cli/src/permission-model-v4.js'
import {
  PLUGIN_PACKAGE_SCHEMA_V7,
  PLUGIN_PACKAGE_SCHEMA_V8,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7,
  PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8,
  PLUGIN_RUNTIME_MANIFEST_SCHEMAS,
} from '../packages/cli/src/launcher/packages/manifest.js'
import {
  cordisXConfigRoot,
  cordisXProjectRoot,
  parseConfigDocument,
  resolveCordisXProjectConfig,
} from '../packages/cli/src/launcher/config.js'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

describe('plugin package v7/v8 predecessor and successor parity', () => {
  it('keeps both public package and runtime schema exports available', () => {
    expect(PLUGIN_PACKAGE_SCHEMA_V7).toBe(CORDISX_PLUGIN_PACKAGE_SCHEMA_V7)
    expect(PLUGIN_PACKAGE_SCHEMA_V8).toBe(CORDISX_PLUGIN_PACKAGE_SCHEMA_V8)
    expect(PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7).toBe(CORDISX_PLUGIN_MANIFEST_SCHEMA_V7)
    expect(PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8).toBe(CORDISX_PLUGIN_MANIFEST_SCHEMA_V8)
    expect(PLUGIN_RUNTIME_MANIFEST_SCHEMAS).toEqual(expect.arrayContaining([
      PLUGIN_RUNTIME_MANIFEST_SCHEMA_V7,
      PLUGIN_RUNTIME_MANIFEST_SCHEMA_V8,
    ]))
  })

  it('normalizes the V7 predecessor and V8 successor without widening either contract', () => {
    const v7 = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
      schemaVersion: 7,
      id: 'canvas-v7',
      capabilities: [],
      services: [],
      execution: { realm: 'isolated-worker' as const, interfaces: ['ui.transient-canvas/v1'] as const },
    }
    const v8 = {
      $schema: CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
      schemaVersion: 8,
      id: 'approval-v8',
      capabilities: [{
        name: 'approvals.answer',
        required: false,
        scope: { authorityRequester: { kind: 'approval-authority-requester-route', requester: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' } } },
      }],
      services: [],
    }
    const catalog = { assertScope: () => {} }
    expect(normalizePluginManifestV7(v7, v7.id, catalog)).toEqual(v7)
    expect(normalizePluginManifestV8(v8, v8.id, catalog)).toEqual(v8)
  })

  it('retains the project-root and Vite local-development source routes while adding V8', async () => {
    const location = resolveCordisXProjectConfig('.cordisx/config.json', root)
    const config = parseConfigDocument({ version: 1, plugins: [] }, location.configPath)
    expect(cordisXProjectRoot(config)).toBe(location.projectRoot)
    expect(cordisXConfigRoot(config)).toBe(location.configRoot)
    for (const relative of [
      'packages/cli/src/launcher/development.ts',
      'packages/cli/src/launcher/plugin-package.ts',
      'packages/cli/src/launcher/plugin-lifecycle.ts',
      'packages/cli/src/launcher/vite-development.ts',
      'packages/cli/src/renderer/runtime.ts',
    ]) {
      const source = await readFile(path.join(root, relative), 'utf8')
      expect(source).toContain('V7')
      expect(source).toContain('V8')
    }
    const runtime = await readFile(path.join(root, 'packages/cli/src/renderer/runtime.ts'), 'utf8')
    expect(runtime).toContain('prepareCordisXViteReactRuntime')
    expect(runtime).toContain('manifestUsesTransientCanvas')
  })
})
