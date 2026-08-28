import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('production Connector smoke harness isolation', () => {
  it('keeps the fixed fixture out of product runtime, config, and CLI surfaces', async () => {
    const [runtime, cli, bundle, runner, fixtureBuilder] = await Promise.all([
      readFile(path.join(root, 'packages/cli/src/renderer/runtime.ts'), 'utf8'),
      readFile(path.join(root, 'packages/cli/src/cli/run.ts'), 'utf8'),
      readFile(path.join(root, 'packages/cli/src/launcher/bundle.ts'), 'utf8'),
      readFile(path.join(root, 'packages/cli/scripts/run-isolated-app-smoke.mjs'), 'utf8'),
      readFile(path.join(root, 'tests/fixtures/connector-production-bundle.ts'), 'utf8'),
    ])
    for (const productSource of [runtime, cli, bundle]) {
      expect(productSource).not.toMatch(/connector-production|connector-harness|fixture installer/i)
    }
    expect(runner).toContain("process.argv.includes('--connector-harness')")
    expect(runner).toContain("'tests/fixtures/connector-production-smoke-cli.ts'")
    expect(fixtureBuilder).toContain("'connector-production-host-fixture.ts'")
    expect(fixtureBuilder).not.toMatch(/process\.env|process\.argv|--config|--fixture/i)
  })
})
