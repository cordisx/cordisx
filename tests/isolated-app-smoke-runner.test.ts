import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

describe('isolated app smoke runner', () => {
  it('supports a fresh product-mode Home Config and does not mask a missing failure report', async () => {
    const source = await readFile(path.join(root, 'packages/cli/scripts/run-isolated-app-smoke.mjs'), 'utf8')
    expect(source).toContain("const homeConfig = optionalValue('--home-config')")
    expect(source).toContain("'--dev-config and --home-config are mutually exclusive'")
    expect(source).toContain("await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-home-'))")
    expect(source).toContain("await copyFile(homeConfig, path.join(homeRoot, '.cordisx', 'config.json'))")
    expect(source).toContain("if (error?.code === 'ENOENT') return undefined")
  })
})
