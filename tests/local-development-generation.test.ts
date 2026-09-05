import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { buildLocalDevelopmentPlugin, LocalDevelopmentController } from '../packages/cli/src/launcher/development.js'
import type { CordisXPluginActivationRecordV1 } from '../packages/cli/src/plugin-lifecycle-contracts.js'
import type { PluginRuntimeMutation } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import type { CordisXLocalDevelopmentSnapshot } from '../packages/cli/src/local-development-contracts.js'

async function eventually(assertion: () => void, timeout = 8_000): Promise<void> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    try {
      assertion()
      return
    } catch (error) {
      last = error
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  }
  throw last
}

class FixtureGenerationRuntime {
  epoch = 0
  failNextStatus = false
  closedRenderer = false
  readyRenderer = true
  staged: PluginRuntimeMutation | undefined
  active: CordisXPluginActivationRecordV1 | undefined
  readonly published: CordisXPluginActivationRecordV1[] = []
  readonly states: CordisXLocalDevelopmentSnapshot[] = []
  readonly rollbackTransactions: string[] = []

  currentRegistryEpoch(): number {
    return this.epoch
  }
  cancelPreparation(): void {}
  prepare(transactionId: string) {
    if (!this.readyRenderer) throw new Error('no ready CordisX renderer is available')
    return { transactionEpoch: `${transactionId}:fixture`, expectedRegistryEpoch: this.epoch }
  }
  async stage(mutation: PluginRuntimeMutation) {
    this.staged = mutation
    if (this.closedRenderer) throw new Error('fixture renderer session is closed')
    return {
      transactionId: mutation.transactionId,
      transactionEpoch: mutation.transactionEpoch,
      expectedRegistryEpoch: mutation.expectedRegistryEpoch,
      afterRegistryEpoch: mutation.afterRegistryEpoch,
      observation: mutation.candidate,
    }
  }
  async publish(transactionId: string) {
    if (this.staged?.transactionId !== transactionId) throw new Error('fixture transaction was not staged')
    this.epoch += 1
    this.active = this.staged.candidate
    this.published.push(this.active)
    return {
      transactionId,
      transactionEpoch: this.staged.transactionEpoch,
      registryEpoch: this.epoch,
      active: this.active,
    }
  }
  async complete(transactionId: string) {
    if (this.active === undefined || this.staged?.transactionId !== transactionId) {
      throw new Error('fixture transaction is not active')
    }
    return {
      transactionId,
      transactionEpoch: this.staged.transactionEpoch,
      registryEpoch: this.epoch,
      active: this.active,
      disposedAfter: this.staged.previous,
    }
  }
  async finalize(): Promise<void> {
    this.staged = undefined
  }
  async rollback(transactionId: string) {
    this.rollbackTransactions.push(transactionId)
    if (this.closedRenderer) throw new Error('fixture renderer session is closed')
    const mutation = this.staged
    this.staged = undefined
    const active = mutation?.previous ?? this.active
    if (active === undefined) throw new Error('fixture has no rollback activation')
    this.epoch = (mutation?.afterRegistryEpoch ?? this.epoch) + 1
    this.active = active
    return {
      transactionId,
      transactionEpoch: mutation?.transactionEpoch ?? `${transactionId}:fixture`,
      registryEpoch: this.epoch,
      active,
      disposedAfter: mutation?.candidate ?? active,
    }
  }
  async updateDevelopmentStatus(state: CordisXLocalDevelopmentSnapshot): Promise<void> {
    this.states.push(state)
    if (this.closedRenderer) throw new Error('fixture renderer session is closed')
    if (this.failNextStatus) {
      this.failNextStatus = false
      throw new Error('fixture renderer closed during status broadcast')
    }
  }
}

describe('local development generations', () => {
  it(
    'uses the transitive graph, retains last-good across build/activation failures, recovers, and stops cleanly',
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-test-'))
      const source = path.join(root, 'src')
      const entry = path.join(source, 'demo.ts')
      const dependency = path.join(source, 'value.ts')
      const englishReadme = path.join(root, 'README.md')
      const chineseReadme = path.join(root, 'README.zh-Hans.md')
      await mkdir(source)
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }))
      await writeFile(
        entry,
        "import { value } from './value.js'\nconsole.info('plugin-top-level')\nexport default { manifest: { id: 'demo', name: value }, apply() {} }\n",
      )
      await writeFile(dependency, "export const value = 'one'\n")
      await writeFile(englishReadme, '# Demo\n')
      await writeFile(chineseReadme, '# 演示\n')

      const firstBuild = await buildLocalDevelopmentPlugin(entry)
      expect(firstBuild.watchFiles).toContain(dependency)
      expect(firstBuild.watchFiles).toEqual(expect.arrayContaining([englishReadme, chineseReadme]))
      expect(firstBuild.readme).toBe('# Demo\n')
      expect(firstBuild.readmes).toEqual({ default: '# Demo\n', 'zh-hans': '# 演示\n' })
      expect(firstBuild.identitySource).toMatch(/^file:\/\/\/cordisx-local-dev\//u)
      expect(firstBuild.identitySource).not.toContain(root)
      expect(firstBuild.runtimeArtifactSource).toContain('__cordisxPendingPluginModuleFactoryV1 = (console) =>')
      expect(firstBuild.runtimeArtifactSource).not.toContain('__cordisxPendingPluginModuleV1 =')
      const artifactDom = new (await import('jsdom')).JSDOM('', { runScripts: 'dangerously' })
      const globalLogs: string[] = []
      const facadeLogs: string[] = []
      Object.defineProperty(artifactDom.window, 'console', {
        value: { info: (message: string) => globalLogs.push(message) },
      })
      artifactDom.window.eval(firstBuild.runtimeArtifactSource)
      expect(globalLogs).toEqual([])
      const dynamicFactory = (artifactDom.window as unknown as {
        __cordisxPendingPluginModuleFactoryV1: (console: { info(message: string): void }) => unknown
      }).__cordisxPendingPluginModuleFactoryV1
      dynamicFactory({ info: message => facadeLogs.push(message) })
      expect(facadeLogs).toEqual(['plugin-top-level'])
      artifactDom.window.close()

      const runtime = new FixtureGenerationRuntime()
      runtime.failNextStatus = true
      const bootstraps: string[] = []
      const output: string[] = []
      const controller = await LocalDevelopmentController.create({
        entry,
        runtimeGeneration: 'fixture-runtime',
        initialConfig: { version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [], plugins: [] },
        runtime,
        rebuildBootstrap: async (config, activation, epoch) => {
          const plugin = config.plugins[0]!
          expect(plugin.development).toMatchObject({ origin: 'local-dev', sourcePath: entry, state: 'ready' })
          expect(plugin.source).not.toContain(root)
          expect(plugin.readmes).toEqual({ default: '# Demo\n', 'zh-hans': '# 演示\n' })
          return JSON.stringify({ digest: plugin.package?.digest, revision: activation.revision, epoch })
        },
        setBootstrap: sourceText => {
          bootstraps.push(sourceText)
        },
        stdout: line => {
          output.push(line)
        },
      })

      try {
        await controller.start()
        await eventually(() => expect(runtime.published).toHaveLength(1))
        expect(output).toContainEqual(expect.stringContaining('status projection failed'))
        const firstDigest = runtime.published[0]!.plugins[0]!.digest

        await writeFile(dependency, "export const value = 'two'\n")
        await eventually(() => expect(runtime.published).toHaveLength(2))
        expect(runtime.published[1]!.plugins[0]!.digest).not.toBe(firstDigest)

        await writeFile(dependency, 'export const value =\n')
        await eventually(() => expect(runtime.states.at(-1)).toMatchObject({ state: 'failed' }))
        expect(runtime.published).toHaveLength(2)

        await writeFile(dependency, "export const value = 'repaired'\n")
        await eventually(() => expect(runtime.published).toHaveLength(3))
        expect(runtime.states.at(-1)).toMatchObject({ state: 'ready' })

        runtime.closedRenderer = true
        await writeFile(dependency, "export const value = 'activation-fails'\n")
        await eventually(() =>
          expect(runtime.states.at(-1)).toMatchObject({
            state: 'failed',
            error: expect.stringContaining('rollback failed: fixture renderer session is closed'),
          })
        )
        expect(runtime.published).toHaveLength(3)
        const failedTransaction = runtime.rollbackTransactions.at(-1)

        // watchAndInject prunes the closed session independently. No further
        // source write is required for the controller-owned rollback retry to
        // restore last-good and publish the already-current source fingerprint.
        runtime.closedRenderer = false
        runtime.readyRenderer = false
        await eventually(() =>
          expect(runtime.states.at(-1)).toMatchObject({
            state: 'failed',
            error: 'no ready CordisX renderer is available',
          })
        )
        expect(runtime.published).toHaveLength(3)
        runtime.readyRenderer = true
        await eventually(() => expect(runtime.published).toHaveLength(4))
        expect(runtime.rollbackTransactions.slice(-2)).toEqual([failedTransaction, failedTransaction])
        expect(JSON.parse(bootstraps.at(-2)!) as { epoch: number; digest: string }).toMatchObject({
          epoch: runtime.epoch - 1,
          digest: runtime.published.at(-2)!.plugins[0]!.digest,
        })
        expect(bootstraps).toHaveLength(5)

        await writeFile(dependency, "export const value = 'rapid-one'\n")
        await writeFile(dependency, "export const value = 'rapid-two'\n")
        await writeFile(dependency, "export const value = 'rapid-final'\n")
        await eventually(() => expect(runtime.published).toHaveLength(5))
        await new Promise(resolve => setTimeout(resolve, 400))
        expect(runtime.published).toHaveLength(5)

        await controller.stop()
        await writeFile(dependency, "export const value = 'after-stop'\n")
        await new Promise(resolve => setTimeout(resolve, 500))
        expect(runtime.published).toHaveLength(5)
      } finally {
        await controller.stop()
        await rm(root, { recursive: true, force: true })
      }
    },
    12_000,
  )

  it('reports an explicit source failure before any plugin becomes active and then recovers', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-first-failure-'))
    const source = path.join(root, 'src')
    const entry = path.join(source, 'first-failure.ts')
    await mkdir(source)
    await writeFile(path.join(root, 'package.json'), '{')
    await writeFile(entry, 'export default { apply() {} }\n')
    const runtime = new FixtureGenerationRuntime()
    const controller = await LocalDevelopmentController.create({
      entry,
      runtimeGeneration: 'fixture-runtime',
      initialConfig: { version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [], plugins: [] },
      runtime,
      rebuildBootstrap: async () => 'fixture-bootstrap',
      setBootstrap: () => undefined,
      stdout: () => undefined,
    })
    try {
      await controller.start()
      await eventually(() =>
        expect(runtime.states.at(-1)).toMatchObject({
          origin: 'local-dev',
          pluginId: 'first-failure',
          sourcePath: entry,
          state: 'failed',
        })
      )
      expect(runtime.published).toHaveLength(0)
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'first-failure', version: '1.0.0' }))
      await eventually(() => expect(runtime.published).toHaveLength(1))
      expect(runtime.states.at(-1)).toMatchObject({ state: 'ready' })
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('recovers when a previously missing transitive import is created', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-missing-import-'))
    const source = path.join(root, 'src')
    const entry = path.join(source, 'missing-import.ts')
    const missing = path.join(source, 'created-later.ts')
    await mkdir(source)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'missing-import', version: '1.0.0' }))
    await writeFile(entry, "import { value } from './created-later.js'\nexport default { name: value, apply() {} }\n")
    const runtime = new FixtureGenerationRuntime()
    const controller = await LocalDevelopmentController.create({
      entry,
      runtimeGeneration: 'fixture-runtime',
      initialConfig: { version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [], plugins: [] },
      runtime,
      rebuildBootstrap: async () => 'fixture-bootstrap',
      setBootstrap: () => undefined,
      stdout: () => undefined,
    })
    try {
      await controller.start()
      await eventually(() => expect(runtime.states.at(-1)).toMatchObject({ state: 'failed' }))
      expect(runtime.published).toHaveLength(0)
      await writeFile(missing, "export const value = 'created'\n")
      await eventually(() => expect(runtime.published).toHaveLength(1))
      expect(runtime.states.at(-1)).toMatchObject({ state: 'ready' })
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not install a late watcher when stop races the initial fingerprint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-start-stop-'))
    const entry = path.join(root, 'race.ts')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'race', version: '1.0.0' }))
    await writeFile(entry, 'export default { apply() {} }\n')
    const runtime = new FixtureGenerationRuntime()
    const controller = await LocalDevelopmentController.create({
      entry,
      runtimeGeneration: 'fixture-runtime',
      initialConfig: { version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [], plugins: [] },
      runtime,
      rebuildBootstrap: async () => 'fixture-bootstrap',
      setBootstrap: () => undefined,
      stdout: () => undefined,
    })
    vi.useFakeTimers()
    try {
      const starting = controller.start()
      const stopping = controller.stop()
      await Promise.all([starting, stopping])
      expect(vi.getTimerCount()).toBe(0)
      expect(runtime.published).toHaveLength(0)
    } finally {
      await controller.stop()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('clears a pending rollback retry timer on stop', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-retry-stop-'))
    const entry = path.join(root, 'retry-stop.ts')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'retry-stop', version: '1.0.0' }))
    await writeFile(entry, 'export default { apply() {} }\n')
    const controller = await LocalDevelopmentController.create({
      entry,
      runtimeGeneration: 'fixture-runtime',
      initialConfig: { version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [], plugins: [] },
      runtime: new FixtureGenerationRuntime(),
      rebuildBootstrap: async () => 'fixture-bootstrap',
      setBootstrap: () => undefined,
      stdout: () => undefined,
    })
    vi.useFakeTimers()
    try {
      await controller.start()
      const internal = controller as unknown as {
        pendingRollback?: { transactionId: string }
        armRetry(transactionId?: string): void
      }
      internal.pendingRollback = { transactionId: 'pending-stop' }
      internal.armRetry('pending-stop')
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await controller.stop()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      await controller.stop()
      vi.useRealTimers()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('reports formal package dependencies as unavailable in the renderer-only phase', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-dependencies-'))
    const entry = path.join(root, 'dependent.ts')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dependent', version: '1.0.0' }))
    await writeFile(
      path.join(root, 'cordisx-package.json'),
      JSON.stringify({ dependencies: [{ id: 'base', version: '1.0.0' }] }),
    )
    await writeFile(entry, 'export default { apply() {} }\n')
    const runtime = new FixtureGenerationRuntime()
    const controller = await LocalDevelopmentController.create({
      entry,
      runtimeGeneration: 'fixture-runtime',
      initialConfig: { version: 1, rootDir: root, codex: { debugPort: 9229 }, providers: [], plugins: [] },
      runtime,
      rebuildBootstrap: async () => 'fixture-bootstrap',
      setBootstrap: () => undefined,
      stdout: () => undefined,
    })
    try {
      await controller.start()
      await eventually(() =>
        expect(runtime.states.at(-1)).toMatchObject({
          state: 'failed',
          error: 'local development phase 1 is renderer-only; package dependencies are unavailable',
        })
      )
      expect(runtime.published).toHaveLength(0)
      await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify({ dependencies: [] }))
      await eventually(() => expect(runtime.published).toHaveLength(1))
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
