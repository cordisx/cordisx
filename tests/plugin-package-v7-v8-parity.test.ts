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
import { readOwnedSourceGraph } from './source-module-graph.js'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')

const routeFiles = {
  development: path.join(root, 'packages/cli/src/launcher/development.ts'),
  package: path.join(root, 'packages/cli/src/launcher/plugin-package.ts'),
  lifecycle: path.join(root, 'packages/cli/src/launcher/plugin-lifecycle-core.ts'),
  vite: path.join(root, 'packages/cli/src/launcher/vite-development.ts'),
  runtime: path.join(root, 'packages/cli/src/renderer/runtime.ts'),
} as const

const routeProgram = ts.createProgram(Object.values(routeFiles), {
  target: ts.ScriptTarget.ES2022,
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  skipLibCheck: true,
  noEmit: true,
})
const routeChecker = routeProgram.getTypeChecker()

function sourceFile(filename: string): ts.SourceFile {
  const source = routeProgram.getSourceFile(filename)
  if (source === undefined) throw new Error(`missing source route ${filename}`)
  return source
}

function symbolSource(node: ts.Identifier): string | undefined {
  let symbol = routeChecker.getSymbolAtLocation(node)
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    symbol = routeChecker.getAliasedSymbol(symbol)
  }
  return symbol?.declarations?.[0]?.getSourceFile().fileName
}

function importedCalls(filename: string, declarationFile: string): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && symbolSource(node.expression)?.endsWith(declarationFile) === true
    ) names.add(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(filename))
  return names
}

function ownedCalls(filenames: readonly string[]): Set<string> {
  const owned = new Set(filenames.map(filename => path.resolve(filename)))
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && owned.has(path.resolve(symbolSource(node.expression) ?? ''))
    ) names.add(node.expression.text)
    ts.forEachChild(node, visit)
  }
  for (const filename of filenames) visit(sourceFile(filename))
  return names
}

function typeReferences(filename: string, declarationFile: string): Set<string> {
  const names = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (
      ts.isTypeReferenceNode(node)
      && ts.isIdentifier(node.typeName)
      && symbolSource(node.typeName)?.endsWith(declarationFile) === true
    ) names.add(node.typeName.text)
    ts.forEachChild(node, visit)
  }
  visit(sourceFile(filename))
  return names
}

function schemaVersions(filenames: readonly string[], functionName: string): Set<number> {
  const versions = new Set<number>()
  const declaration = filenames.flatMap(filename => sourceFile(filename).statements).find(statement => (
    ts.isFunctionDeclaration(statement) && statement.name?.text === functionName
  ))
  if (declaration === undefined || !ts.isFunctionDeclaration(declaration)) {
    throw new Error(`missing function ${functionName}`)
  }
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && node.left.name.text === 'schemaVersion'
      && ts.isNumericLiteral(node.right)
    ) versions.add(Number(node.right.text))
    ts.forEachChild(node, visit)
  }
  visit(declaration)
  return versions
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
    for (const filename of [routeFiles.development, routeFiles.package, routeFiles.lifecycle]) {
      const calls = importedCalls(filename, '/permission-model-v4.ts')
      expect(calls).toContain('normalizePluginManifestV7')
      expect(calls).toContain('normalizePluginManifestV8')
    }
    const viteTypes = typeReferences(routeFiles.vite, '/permission-contracts.ts')
    expect(viteTypes).toContain('CordisXPluginManifestV7')
    expect(viteTypes).toContain('CordisXPluginManifestV8')

    const runtimeFiles = (await readOwnedSourceGraph(routeFiles.runtime)).files
    const runtimeCalls = ownedCalls(runtimeFiles)
    expect(runtimeCalls).toContain('prepareCordisXViteReactRuntime')
    expect(runtimeCalls).toContain('manifestUsesTransientCanvas')
    expect(schemaVersions(runtimeFiles, 'manifestUsesHostDom')).toContain(8)
    expect(schemaVersions(runtimeFiles, 'manifestUsesTransientCanvas')).toContain(7)
  })
})
