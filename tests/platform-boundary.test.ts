import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

async function readPlatformModuleGraph(entry: string, directory: string): Promise<readonly string[]> {
  const pending = [entry]
  const visited = new Set<string>()
  const sources: string[] = []
  while (pending.length > 0) {
    const filename = pending.pop()!
    if (visited.has(filename)) continue
    visited.add(filename)
    const source = await readFile(filename, 'utf8')
    sources.push(source)
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+\.js)['"]/gu)) {
      const dependency = path.resolve(path.dirname(filename), match[1]!.replace(/\.js$/u, '.ts'))
      if (dependency.startsWith(`${directory}${path.sep}`)) pending.push(dependency)
    }
  }
  return sources
}

describe('Platform current-connection boundary', () => {
  it('contains no private Desktop transport or second-server implementation', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const platformDirectory = path.join(root, 'packages/cli/src/renderer/platform')
    const sources = await Promise.all([
      readFile(path.join(root, 'packages/cli/src/platform-contracts.ts'), 'utf8'),
      readPlatformModuleGraph(
        path.join(root, 'packages/cli/src/renderer/platform.ts'),
        platformDirectory,
      ).then(items => items.join('\n')),
    ])
    const implementation = sources.join('\n')
    for (
      const forbidden of [
        'electron' + 'Bridge',
        'mcp-' + 'request',
        'connect-' + 'app-host',
        'node:child_' + 'process',
        'new Web' + 'Socket',
      ]
    ) {
      expect(implementation).not.toContain(forbidden)
    }
  })
})
