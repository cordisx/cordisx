import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const homeHelper = await import(pathToFileURL(path.join(root, 'packages/cli/scripts/isolated-smoke-home.mjs')).href)

describe('isolated app smoke runner', () => {
  it('removes exactly the runner-created product-mode HOME after a successful smoke', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
    try {
      const homeConfig = path.join(fixtureRoot, 'config.json')
      await writeFile(homeConfig, '{"plugins":{}}\n')
      const homeRoot = await homeHelper.prepareIsolatedSmokeHome(homeConfig)
      const immutablePackage = path.join(homeRoot, '.cordisx', 'packages', 'sha256', 'fixture')
      await mkdir(immutablePackage, { recursive: true })
      await writeFile(path.join(immutablePackage, 'artifact.js'), 'void 0\n')
      if (process.platform !== 'win32') {
        await chmod(path.join(immutablePackage, 'artifact.js'), 0o444)
        await chmod(immutablePackage, 0o555)
      }

      await expect(readFile(path.join(homeRoot, '.cordisx', 'config.json'), 'utf8')).resolves.toBe('{"plugins":{}}\n')
      await expect(homeHelper.cleanupIsolatedSmokeHome(homeRoot)).resolves.toEqual({
        homeRoot,
        homeRootRemoved: true,
        homeRootExists: false,
      })
      await expect(access(homeRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('records cleanup when possible without masking a smoke failure that wrote no report', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
    try {
      const homeConfig = path.join(fixtureRoot, 'config.json')
      const reportPath = path.join(fixtureRoot, 'report.json')
      await writeFile(homeConfig, '{"plugins":{}}\n')
      const homeRoot = await homeHelper.prepareIsolatedSmokeHome(homeConfig)
      const cleanup = await homeHelper.cleanupIsolatedSmokeHome(homeRoot)

      await expect(homeHelper.appendRunnerCleanup(reportPath, cleanup)).resolves.toBe(false)
      await writeFile(reportPath, '{"result":"passed"}\n')
      await expect(homeHelper.appendRunnerCleanup(reportPath, cleanup)).resolves.toBe(true)
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('"homeRootRemoved": true')
      await expect(readFile(reportPath, 'utf8')).resolves.toContain('"homeRootExists": false')
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('materializes relative plugin entries before moving a Home template', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
    try {
      const homeConfig = path.join(fixtureRoot, 'ui-demo.json')
      await writeFile(homeConfig, JSON.stringify({
        plugins: [
          { id: 'local', entry: './plugins/local.ts' },
          { id: 'builtin', entry: 'cordisx:channel' },
        ],
      }))
      const homeRoot = await homeHelper.prepareIsolatedSmokeHome(homeConfig)
      const copied = JSON.parse(await readFile(path.join(homeRoot, '.cordisx', 'config.json'), 'utf8'))
      expect(copied.plugins).toEqual([
        { id: 'local', entry: path.join(fixtureRoot, 'plugins/local.ts') },
        { id: 'builtin', entry: 'cordisx:channel' },
      ])
      await homeHelper.cleanupIsolatedSmokeHome(homeRoot)
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('keeps the product-mode invocation explicit', async () => {
    const source = await readFile(path.join(root, 'packages/cli/scripts/run-isolated-app-smoke.mjs'), 'utf8')
    const homeHelperSource = await readFile(path.join(root, 'packages/cli/scripts/isolated-smoke-home.mjs'), 'utf8')
    expect(source).toContain("const homeConfig = optionalValue('--home-config')")
    expect(source).toContain("'--dev-config and --home-config are mutually exclusive'")
    expect(source).toContain('prepareIsolatedSmokeHome(homeConfig)')
    expect(source).toContain('cleanupIsolatedSmokeHome(homeRoot)')
    expect(source.indexOf('cleanupIsolatedSmokeHome(homeRoot)')).toBeGreaterThan(source.lastIndexOf('profileProcesses()'))
    expect(homeHelperSource).toContain('maxRetries: 20, retryDelay: 100')
  })
})
