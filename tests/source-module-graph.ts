import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

export interface OwnedSourceGraph {
  readonly files: readonly string[]
  readonly executableSource: string
}

async function sourceModulePath(parent: string, specifier: string): Promise<string | undefined> {
  const candidate = path.resolve(path.dirname(parent), specifier.replace(/\.js$/u, ''))
  for (const extension of ['.ts', '.tsx'] as const) {
    const filename = candidate + extension
    if (await access(filename).then(() => true, () => false)) return filename
  }
  return undefined
}

/** Read one split module family through parsed local import/export declarations. */
export async function readOwnedSourceGraph(entry: string | URL): Promise<OwnedSourceGraph> {
  const entryPath = typeof entry === 'string' ? path.resolve(entry) : fileURLToPath(entry)
  const stem = path.basename(entryPath, path.extname(entryPath))
  const pending = [entryPath]
  const visited = new Set<string>()
  const executableSources: string[] = []
  const printer = ts.createPrinter({ removeComments: true, newLine: ts.NewLineKind.LineFeed })
  while (pending.length > 0) {
    const filename = pending.pop()!
    if (visited.has(filename)) continue
    visited.add(filename)
    const source = await readFile(filename, 'utf8')
    const module = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    executableSources.push(printer.printFile(module))
    for (const statement of module.statements) {
      if (!ts.isImportDeclaration(statement) && !ts.isExportDeclaration(statement)) continue
      const specifier = statement.moduleSpecifier
      if (specifier === undefined || !ts.isStringLiteral(specifier) || !specifier.text.startsWith('./')) continue
      if (!path.basename(specifier.text).startsWith(stem)) continue
      const dependency = await sourceModulePath(filename, specifier.text)
      if (dependency !== undefined) pending.push(dependency)
    }
  }
  return Object.freeze({
    files: Object.freeze([...visited].sort()),
    executableSource: executableSources.join('\n'),
  })
}
