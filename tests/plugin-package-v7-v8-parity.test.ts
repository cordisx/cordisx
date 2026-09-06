import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import {
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V7,
  CORDISX_PLUGIN_MANIFEST_SCHEMA_V8,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V7,
  CORDISX_PLUGIN_PACKAGE_SCHEMA_V8,
} from '../packages/cli/src/permission-contracts.js'
import { normalizePluginManifestV7, normalizePluginManifestV8 } from '../packages/cli/src/permission-model-v4.js'
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

async function readOwnedSourceRoute(relative: string): Promise<ts.SourceFile[]> {
  const pending = [path.join(root, relative)]
  const visited = new Set<string>()
  const sources: ts.SourceFile[] = []
  const stem = path.basename(relative, '.ts')
  while (pending.length > 0) {
    const filename = pending.pop()!
    if (visited.has(filename)) continue
    visited.add(filename)
    const source = await readFile(filename, 'utf8')
    sources.push(ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS))
    for (const match of source.matchAll(/from\s+['"](\.\/[^'"]+)['"]/gu)) {
      const specifier = match[1]!
      if (!path.basename(specifier).startsWith(stem)) continue
      pending.push(path.resolve(path.dirname(filename), specifier.replace(/\.js$/u, '.ts')))
    }
  }
  return sources
}

function calledIdentifiers(sources: readonly ts.SourceFile[]): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) names.add(node.expression.text)
    ts.forEachChild(node, visit)
  }
  for (const source of sources) visit(source)
  return names
}

function typeReferences(sources: readonly ts.SourceFile[]): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)) names.add(node.typeName.text)
    ts.forEachChild(node, visit)
  }
  for (const source of sources) visit(source)
  return names
}

function declaredFunction(sources: readonly ts.SourceFile[], name: string): ts.FunctionDeclaration {
  for (const source of sources) {
    for (const statement of source.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement
    }
  }
  throw new Error(`missing function ${name}`)
}

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
        scope: {
          authorityRequester: {
            kind: 'approval-authority-requester-route',
            requester: { kind: 'host-route-param', routeId: 'room-session-detail', param: 'sessionId' },
          },
        },
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
    for (
      const relative of [
        'packages/cli/src/launcher/development.ts',
        'packages/cli/src/launcher/plugin-package.ts',
        'packages/cli/src/launcher/plugin-lifecycle.ts',
      ]
    ) {
      const calls = calledIdentifiers(await readOwnedSourceRoute(relative))
      expect(calls).toContain('normalizePluginManifestV7')
      expect(calls).toContain('normalizePluginManifestV8')
    }
    const viteTypes = typeReferences(await readOwnedSourceRoute('packages/cli/src/launcher/vite-development.ts'))
    expect(viteTypes).toContain('CordisXPluginManifestV7')
    expect(viteTypes).toContain('CordisXPluginManifestV8')

    const runtime = await readOwnedSourceRoute('packages/cli/src/renderer/runtime.ts')
    const runtimeCalls = calledIdentifiers(runtime)
    expect(runtimeCalls).toContain('prepareCordisXViteReactRuntime')
    expect(runtimeCalls).toContain('manifestUsesTransientCanvas')
    expect(declaredFunction(runtime, 'manifestUsesHostDom').body?.getText()).toMatch(/schemaVersion\s*===\s*8/u)
    expect(declaredFunction(runtime, 'manifestUsesTransientCanvas').body?.getText()).toMatch(/schemaVersion\s*===\s*7/u)
  })
})
