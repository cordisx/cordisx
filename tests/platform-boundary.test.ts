import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('Platform current-connection boundary', () => {
  it('contains no private Desktop transport or second-server implementation', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
    const sources = await Promise.all([
      readFile(path.join(root, 'packages/cli/src/platform-contracts.ts'), 'utf8'),
      readFile(path.join(root, 'packages/cli/src/renderer/platform.ts'), 'utf8'),
    ])
    const implementation = sources.join('\n')
    for (const forbidden of [
      'electron' + 'Bridge',
      'mcp-' + 'request',
      'connect-' + 'app-host',
      'node:child_' + 'process',
      'new Web' + 'Socket',
    ]) {
      expect(implementation).not.toContain(forbidden)
    }
  })
})
