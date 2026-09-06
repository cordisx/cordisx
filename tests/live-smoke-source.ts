import { readFile } from 'node:fs/promises'
import path from 'node:path'
import ts from 'typescript'

const liveSmokeEntry = 'packages/cli/scripts/live-smoke.mjs'

/** Reads the executable local module graph rooted at the live-smoke CLI entry. */
export async function readLiveSmokeSourceGraph(projectRoot: string): Promise<string> {
  const visited = new Set<string>()
  const sources: string[] = []

  const visit = async (relativePath: string): Promise<void> => {
    if (visited.has(relativePath)) return
    visited.add(relativePath)
    const source = await readFile(path.join(projectRoot, relativePath), 'utf8')
    sources.push(source)
    const sourceFile = ts.createSourceFile(relativePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    const imports = sourceFile.statements.flatMap(statement => {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
      const specifier = statement.moduleSpecifier.text
      if (!specifier.startsWith('.')) return []
      const imported = path.posix.normalize(path.posix.join(path.posix.dirname(relativePath), specifier))
      return imported.startsWith('packages/cli/scripts/live-smoke/') ? [imported] : []
    })
    for (const imported of imports) await visit(imported)
  }

  await visit(liveSmokeEntry)
  return sources.join('\n')
}
