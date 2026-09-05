import { execFile } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const execute = promisify(execFile)
const runner = path.join(root, 'packages/cli/scripts/run-isolated-app-smoke.mjs')
const homeHelper = await import(pathToFileURL(path.join(root, 'packages/cli/scripts/isolated-smoke-home.mjs')).href)
const timeoutHelper = await import(
  pathToFileURL(path.join(root, 'packages/cli/scripts/isolated-smoke-timeout.mjs')).href
)

describe('isolated app smoke runner', () => {
  it('keeps existing renderer defaults and bounds an explicit custom-smoke timeout', () => {
    expect(timeoutHelper.resolveIsolatedSmokeRendererTimeoutMs(undefined, 30_000)).toBe(30_000)
    expect(timeoutHelper.resolveIsolatedSmokeRendererTimeoutMs(undefined, 300_000)).toBe(300_000)
    expect(timeoutHelper.resolveIsolatedSmokeRendererTimeoutMs('300000', 30_000)).toBe(300_000)
    expect(() => timeoutHelper.resolveIsolatedSmokeRendererTimeoutMs('slow', 30_000)).toThrow(
      '--renderer-timeout-ms must be an integer',
    )
    expect(() => timeoutHelper.resolveIsolatedSmokeRendererTimeoutMs('29999', 30_000)).toThrow(
      '--renderer-timeout-ms must be between 30000 and 600000',
    )
    expect(() => timeoutHelper.resolveIsolatedSmokeRendererTimeoutMs('600001', 30_000)).toThrow(
      '--renderer-timeout-ms must be between 30000 and 600000',
    )
  })

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
      await writeFile(
        homeConfig,
        JSON.stringify({
          plugins: [
            { id: 'local', entry: './plugins/local.ts' },
            { id: 'builtin', entry: 'cordisx:channel' },
          ],
        }),
      )
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

  it('copies a seed into the managed .cordisx directory before overriding its config', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
    try {
      const homeConfig = path.join(fixtureRoot, 'config.json')
      const homeSeed = path.join(fixtureRoot, 'seed')
      const seededPackage = path.join(homeSeed, 'packages', 'sha256', 'fixture')
      await mkdir(seededPackage, { recursive: true })
      await writeFile(path.join(homeSeed, 'config.json'), '{"source":"seed"}\n')
      await writeFile(path.join(seededPackage, 'artifact.js'), 'void 0\n')
      await writeFile(homeConfig, '{"source":"override","plugins":[]}\n')

      const homeRoot = await homeHelper.prepareIsolatedSmokeHome(homeConfig, homeSeed)
      await expect(readFile(path.join(homeRoot, '.cordisx', 'config.json'), 'utf8')).resolves.toBe(
        '{"source":"override","plugins":[]}\n',
      )
      await expect(
        readFile(path.join(homeRoot, '.cordisx', 'packages', 'sha256', 'fixture', 'artifact.js'), 'utf8'),
      ).resolves.toBe('void 0\n')
      await expect(readFile(path.join(homeSeed, 'config.json'), 'utf8')).resolves.toBe('{"source":"seed"}\n')
      await homeHelper.cleanupIsolatedSmokeHome(homeRoot)
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')('rejects symbolic links anywhere in a Home seed', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
    try {
      const homeConfig = path.join(fixtureRoot, 'config.json')
      const homeSeed = path.join(fixtureRoot, 'seed')
      await mkdir(homeSeed)
      await writeFile(homeConfig, '{"plugins":[]}\n')
      await writeFile(path.join(fixtureRoot, 'outside.json'), '{}\n')
      await symlink(path.join(fixtureRoot, 'outside.json'), path.join(homeSeed, 'linked.json'))

      await expect(homeHelper.prepareIsolatedSmokeHome(homeConfig, homeSeed)).rejects.toThrow(
        'isolated smoke Home seed must not contain symbolic links',
      )
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'rejects symlinked Home-seed roots and smoke entries before launch',
    async () => {
      const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
      try {
        const homeConfig = path.join(fixtureRoot, 'config.json')
        const homeSeed = path.join(fixtureRoot, 'seed')
        const homeSeedLink = path.join(fixtureRoot, 'seed-link')
        const smokeEntry = path.join(fixtureRoot, 'smoke.mjs')
        const smokeEntryLink = path.join(fixtureRoot, 'smoke-link.mjs')
        await mkdir(homeSeed)
        await writeFile(homeConfig, '{"plugins":[]}\n')
        await writeFile(smokeEntry, 'void 0\n')
        await symlink(homeSeed, homeSeedLink)
        await symlink(smokeEntry, smokeEntryLink)

        await expect(execute(process.execPath, [
          runner,
          '--port',
          '43123',
          '--profile-dir',
          path.join(fixtureRoot, 'profile'),
          '--home-config',
          homeConfig,
          '--home-seed',
          homeSeedLink,
          '--',
        ], { cwd: root })).rejects.toMatchObject({
          stderr: expect.stringContaining('--home-seed must be a real directory'),
        })
        await expect(execute(process.execPath, [
          runner,
          '--port',
          '43123',
          '--profile-dir',
          path.join(fixtureRoot, 'profile'),
          '--smoke-entry',
          smokeEntryLink,
          '--',
        ], { cwd: root })).rejects.toMatchObject({
          stderr: expect.stringContaining('--smoke-entry must be a real .mjs file'),
        })
      } finally {
        await rm(fixtureRoot, { recursive: true, force: true })
      }
    },
  )

  it('keeps fixed smoke children owned by their built-in harnesses', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
    try {
      const smokeEntry = path.join(fixtureRoot, 'smoke.mjs')
      await writeFile(smokeEntry, 'void 0\n')
      for (
        const harness of [
          '--connector-harness',
          '--plugin-bundle-harness',
          '--desktop-agent-session-harness',
        ]
      ) {
        await expect(execute(process.execPath, [
          runner,
          '--port',
          '43123',
          '--profile-dir',
          path.join(fixtureRoot, 'profile'),
          harness,
          '--smoke-entry',
          smokeEntry,
          '--',
        ], { cwd: root })).rejects.toMatchObject({
          stderr: expect.stringContaining('--smoke-entry cannot override a built-in smoke harness'),
        })
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('rejects a custom renderer timeout without a custom smoke before launch', async () => {
    const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), 'cordisx-isolated-smoke-test-'))
    try {
      await expect(execute(process.execPath, [
        runner,
        '--port',
        '43123',
        '--profile-dir',
        path.join(fixtureRoot, 'profile'),
        '--renderer-timeout-ms',
        '300000',
        '--',
      ], { cwd: root })).rejects.toMatchObject({
        stderr: expect.stringContaining('--renderer-timeout-ms requires --smoke-entry'),
      })
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true })
    }
  })

  it('keeps the product-mode invocation explicit', async () => {
    const source = await readFile(path.join(root, 'packages/cli/scripts/run-isolated-app-smoke.mjs'), 'utf8')
    const homeHelperSource = await readFile(path.join(root, 'packages/cli/scripts/isolated-smoke-home.mjs'), 'utf8')
    expect(source).toContain("const homeConfig = optionalValue('--home-config')")
    expect(source).toContain("'--dev-config and --home-config are mutually exclusive'")
    expect(source).toContain("const homeSeedInput = optionalValue('--home-seed')")
    expect(source).toContain("const smokeEntryInput = optionalValue('--smoke-entry')")
    expect(source).toContain("const rendererTimeoutInput = optionalValue('--renderer-timeout-ms')")
    expect(source).toContain("'--home-seed requires --home-config'")
    expect(source).toContain("'--smoke-entry must be a real .mjs file'")
    expect(source).toContain("'--smoke-entry cannot override a built-in smoke harness'")
    expect(source).toContain("'--renderer-timeout-ms requires --smoke-entry'")
    expect(source.indexOf('lstat(homeSeedInput)')).toBeLessThan(source.indexOf('realpath(homeSeedInput)'))
    expect(source.indexOf('lstat(smokeEntryInput)')).toBeLessThan(source.indexOf('realpath(smokeEntryInput)'))
    expect(source).toContain('const smokeEntry = customSmokeEntry ??')
    expect(source).toContain('prepareIsolatedSmokeHome(homeConfig, homeSeed)')
    expect(source).toContain('cleanupIsolatedSmokeHome(homeRoot)')
    expect(source.indexOf("child.kill('SIGINT')")).toBeLessThan(source.indexOf("signal(child, 'SIGTERM')"))
    expect(source.indexOf('cleanupIsolatedSmokeHome(homeRoot)')).toBeGreaterThan(
      source.lastIndexOf('profileProcesses()'),
    )
    expect(homeHelperSource).toContain('maxRetries: 20, retryDelay: 100')
  })
})
