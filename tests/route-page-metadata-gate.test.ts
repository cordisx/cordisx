import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

type RegistrationKind = 'page' | 'route'

interface Registration {
  readonly file: string
  readonly kind: RegistrationKind
  readonly id: string
  readonly fields: ReadonlySet<string>
  readonly schemaExpression?: string
  readonly versionExpression?: string
  readonly titleExpression?: string
  readonly descriptionExpression?: string
  readonly line: number
}

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const bundledRoots = [
  'examples/plugins',
  'packages/agent-trace-showcase/src',
  'packages/cli/src/plugins',
  'packages/create-cordisx-plugin/template/src',
  'tests/fixtures',
] as const
const bundledFiles = ['packages/cli/scripts/live-smoke.mjs'] as const

const expectedRegistrations = [
  'examples/plugins/lifecycle-smoke/index.ts|page|overview',
  'examples/plugins/lifecycle-smoke/index.ts|route|overview',
  'examples/plugins/settings-tab-demo/index.ts|page|settings',
  'examples/plugins/settings-tab-demo/index.ts|route|settings',
  'examples/plugins/slot-showcase/index.ts|page|app.overview',
  'examples/plugins/slot-showcase/index.ts|page|main.analytics',
  'examples/plugins/slot-showcase/index.ts|page|session.analytics',
  'examples/plugins/slot-showcase/index.ts|route|app.overview',
  'examples/plugins/slot-showcase/index.ts|route|main.analytics',
  'examples/plugins/slot-showcase/index.ts|route|session.analytics',
  'packages/agent-trace-showcase/src/index.ts|page|session.timeline',
  'packages/agent-trace-showcase/src/index.ts|route|session.timeline',
  'packages/cli/scripts/live-smoke.mjs|page|overview',
  'packages/cli/scripts/live-smoke.mjs|route|overview',
  'packages/cli/src/plugins/channel/index.ts|page|settings',
  'packages/cli/src/plugins/channel/index.ts|route|settings',
  'packages/cli/src/plugins/cli-proxy-api/index.ts|page|providers.sessions',
  'packages/cli/src/plugins/cli-proxy-api/index.ts|route|providers.sessions',
  'tests/fixtures/generation-base-plugin.ts|page|generation-base',
  'tests/fixtures/generation-base-plugin.ts|route|generation-base',
  'tests/fixtures/lifecycle-smoke-update/index.ts|page|overview',
  'tests/fixtures/lifecycle-smoke-update/index.ts|route|overview',
  'tests/fixtures/session-header-sibling-plugin.ts|page|session.sibling',
  'tests/fixtures/session-header-sibling-plugin.ts|route|session.sibling',
] as const

async function sourceFiles(root: string): Promise<string[]> {
  const absolute = path.join(projectRoot, root)
  const entries = await readdir(absolute, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async entry => {
    const item = path.join(root, entry.name)
    if (entry.isDirectory()) return sourceFiles(item)
    return /\.(?:ts|mjs)$/.test(entry.name) ? [item] : []
  }))
  return nested.flat()
}

function propertyName(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return undefined
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | undefined {
  return object.properties.find((candidate): candidate is ts.PropertyAssignment => (
    ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === name
  ))
}

function registrationKind(expression: ts.LeftHandSideExpression): RegistrationKind | undefined {
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== 'register') return undefined
  if (!ts.isPropertyAccessExpression(expression.expression)) return undefined
  if (expression.expression.name.text === 'pages') return 'page'
  if (expression.expression.name.text === 'routes') return 'route'
  return undefined
}

function registrations(file: string, source: string, lineOffset = 0): Registration[] {
  const scriptKind = file.endsWith('.mjs') ? ts.ScriptKind.JS : ts.ScriptKind.TS
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKind)
  const declarations = new Map<string, ts.Expression>()
  const result: Registration[] = []

  const collectObjects = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      declarations.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, collectObjects)
  }
  collectObjects(sourceFile)

  const resolveObject = (expression: ts.Expression, seen = new Set<string>()): ts.ObjectLiteralExpression | undefined => {
    if (ts.isObjectLiteralExpression(expression)) return expression
    if (ts.isParenthesizedExpression(expression) || ts.isAsExpression(expression) || ts.isSatisfiesExpression(expression)) {
      return resolveObject(expression.expression, seen)
    }
    if (ts.isCallExpression(expression)
      && ts.isPropertyAccessExpression(expression.expression)
      && ts.isIdentifier(expression.expression.expression)
      && expression.expression.expression.text === 'Object'
      && expression.expression.name.text === 'freeze'
      && expression.arguments[0] !== undefined) {
      return resolveObject(expression.arguments[0], seen)
    }
    if (ts.isIdentifier(expression) && !seen.has(expression.text)) {
      const declaration = declarations.get(expression.text)
      if (declaration !== undefined) return resolveObject(declaration, new Set([...seen, expression.text]))
    }
    return undefined
  }

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
        const kind = registrationKind(node.expression)
      if (kind !== undefined) {
        const input = node.arguments[0]
        const metadata = input === undefined ? undefined : resolveObject(input)
        if (metadata === undefined) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          throw new Error(`${file}:${line} ${kind} registration metadata is not a statically enumerable object`)
        }
        const idProperty = property(metadata, 'id')
        if (idProperty === undefined || !ts.isStringLiteral(idProperty.initializer)) {
          const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1
          throw new Error(`${file}:${line} ${kind} registration requires a literal id for the repository gate`)
        }
        const fields = new Set(metadata.properties.flatMap(item => {
          if (ts.isSpreadAssignment(item)) return []
          const name = propertyName(item.name)
          return name === undefined ? [] : [name]
        }))
        const title = property(metadata, 'title')?.initializer
        const description = property(metadata, 'description')?.initializer
        const schema = property(metadata, '$schema')?.initializer
        const version = property(metadata, 'schemaVersion')?.initializer
        result.push({
          file,
          kind,
          id: idProperty.initializer.text,
          fields,
          ...(schema === undefined ? {} : { schemaExpression: schema.getText(sourceFile) }),
          ...(version === undefined ? {} : { versionExpression: version.getText(sourceFile) }),
          ...(title === undefined ? {} : { titleExpression: title.getText(sourceFile) }),
          ...(description === undefined ? {} : { descriptionExpression: description.getText(sourceFile) }),
          line: sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1 + lineOffset,
        })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return result
}

async function bundledRegistrations(): Promise<{ readonly items: readonly Registration[]; readonly sources: ReadonlyMap<string, string> }> {
  const discovered = (await Promise.all(bundledRoots.map(sourceFiles))).flat()
  const files = [...new Set([...discovered, ...bundledFiles])].sort()
  const sources = new Map<string, string>()
  const items: Registration[] = []
  for (const file of files) {
    const source = await readFile(path.join(projectRoot, file), 'utf8')
    sources.set(file, source)
    items.push(...registrations(file, source))
    if (file === 'packages/cli/scripts/live-smoke.mjs') {
      const start = source.indexOf('const candidateModuleFactory')
      const end = source.indexOf('const nativeNode', start)
      if (start < 0 || end < 0) throw new Error('live-smoke generation candidate source is unavailable')
      const lineOffset = source.slice(0, start).split('\n').length - 1
      items.push(...registrations(file, source.slice(start, end), lineOffset))
    }
  }
  return { items, sources }
}

describe('bundled route/page product metadata gate', () => {
  it('enumerates every bundled and Host-owned registration', async () => {
    const { items } = await bundledRegistrations()
    expect(items.map(item => `${item.file}|${item.kind}|${item.id}`).sort()).toEqual([...expectedRegistrations].sort())
  })

  it('requires complete route-v2/page-v3 product metadata and real en plus zh catalogs', async () => {
    const { items, sources } = await bundledRegistrations()
    for (const item of items) {
      const expectedSchema = item.kind === 'page' ? 'CORDISX_PAGE_SCHEMA_V3' : 'CORDISX_ROUTE_SCHEMA_V2'
      const expectedVersion = item.kind === 'page' ? '3' : '2'
      expect.soft(item.schemaExpression, `${item.file}:${item.line} ${item.kind} ${item.id} uses the wrong protocol schema`).toBe(expectedSchema)
      expect.soft(item.versionExpression, `${item.file}:${item.line} ${item.kind} ${item.id} uses the wrong schemaVersion`).toBe(expectedVersion)
      expect.soft(item.fields.has('title'), `${item.file}:${item.line} ${item.kind} ${item.id} is missing title`).toBe(true)
      expect.soft(item.fields.has('description'), `${item.file}:${item.line} ${item.kind} ${item.id} is missing description`).toBe(true)
      if (item.kind === 'page') {
        expect.soft(item.fields.has('localeNamespace'), `${item.file}:${item.line} page.v3 ${item.id} retains legacy localeNamespace`).toBe(false)
      }
      const source = sources.get(item.file)!
      expect.soft(/locale:\s*['"]en['"]/.test(source), `${item.file} has no real English catalog`).toBe(true)
      expect.soft(/locale:\s*['"]zh-CN['"]/.test(source), `${item.file} has no real Simplified Chinese catalog`).toBe(true)
    }
  })

  it('keeps route and page purpose metadata distinct for the same destination', async () => {
    const { items } = await bundledRegistrations()
    for (const route of items.filter(item => item.kind === 'route')) {
      const page = items.find(item => item.kind === 'page' && item.file === route.file && item.id === route.id)
      expect.soft(page, `${route.file}:${route.line} route ${route.id} has no same-file page registration`).toBeDefined()
      if (page === undefined) continue
      if (route.titleExpression !== undefined && page.titleExpression !== undefined) {
        expect.soft(route.titleExpression, `${route.file}:${route.line} route ${route.id} reuses its page title message`).not.toBe(page.titleExpression)
      }
      if (route.descriptionExpression !== undefined && page.descriptionExpression !== undefined) {
        expect.soft(route.descriptionExpression, `${route.file}:${route.line} route ${route.id} reuses its page description message`).not.toBe(page.descriptionExpression)
      }
    }
  })

  it('confines missing metadata behavior to the explicit third-party legacy compatibility test', async () => {
    const source = await readFile(path.join(projectRoot, 'tests/navigation.test.ts'), 'utf8')
    expect(source).toContain('diagnoses legacy omissions without inventing purpose')
    expect(source).toContain("pages.register('legacy'")
    expect(source).toContain("navigation.register('legacy'")
  })
})
