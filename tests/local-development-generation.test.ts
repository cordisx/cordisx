import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  LocalDevelopmentController,
  buildLocalDevelopmentPlugin,
} from '../packages/cli/src/launcher/development.js'
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
  failNextStage = false
  staged: PluginRuntimeMutation | undefined
  active: CordisXPluginActivationRecordV1 | undefined
  readonly published: CordisXPluginActivationRecordV1[] = []
  readonly states: CordisXLocalDevelopmentSnapshot[] = []

  currentRegistryEpoch(): number { return this.epoch }
  cancelPreparation(): void {}
  prepare(transactionId: string) {
    return { transactionEpoch: `${transactionId}:fixture`, expectedRegistryEpoch: this.epoch }
  }
  async stage(mutation: PluginRuntimeMutation) {
    if (this.failNextStage) {
      this.failNextStage = false
      throw new Error('fixture activation rejected')
    }
    this.staged = mutation
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
    return { transactionId, transactionEpoch: this.staged.transactionEpoch, registryEpoch: this.epoch, active: this.active }
  }
  async complete(transactionId: string) {
    if (this.active === undefined || this.staged?.transactionId !== transactionId) throw new Error('fixture transaction is not active')
    return {
      transactionId,
      transactionEpoch: this.staged.transactionEpoch,
      registryEpoch: this.epoch,
      active: this.active,
      disposedAfter: this.staged.previous,
    }
  }
  async finalize(): Promise<void> { this.staged = undefined }
  async rollback(transactionId: string) {
    const mutation = this.staged
    this.staged = undefined
    const active = mutation?.previous ?? this.active
    if (active === undefined) throw new Error('fixture has no rollback activation')
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
  }
}

describe('local development generations', () => {
  it('uses the transitive graph, retains last-good across build/activation failures, recovers, and stops cleanly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-test-'))
    const source = path.join(root, 'src')
    const entry = path.join(source, 'demo.ts')
    const dependency = path.join(source, 'value.ts')
    await mkdir(source)
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.2.3' }))
    await writeFile(entry, "import { value } from './value.js'\nexport default { manifest: { id: 'demo', name: value }, apply() {} }\n")
    await writeFile(dependency, "export const value = 'one'\n")

    const firstBuild = await buildLocalDevelopmentPlugin(entry)
    expect(firstBuild.watchFiles).toContain(dependency)
    expect(firstBuild.identitySource).toMatch(/^file:\/\/\/cordisx-local-dev\//u)
    expect(firstBuild.identitySource).not.toContain(root)

    const runtime = new FixtureGenerationRuntime()
    const bootstraps: string[] = []
    const controller = await LocalDevelopmentController.create({
      entry,
      runtimeGeneration: 'fixture-runtime',
      runtime,
      rebuildBootstrap: async (config, activation, epoch) => {
        const plugin = config.plugins[0]!
        expect(plugin.development).toMatchObject({ origin: 'local-dev', sourcePath: entry, state: 'ready' })
        expect(plugin.source).not.toContain(root)
        return JSON.stringify({ digest: plugin.package?.digest, revision: activation.revision, epoch })
      },
      setBootstrap: sourceText => { bootstraps.push(sourceText) },
      stdout: () => undefined,
    })

    try {
      await controller.start()
      await eventually(() => expect(runtime.published).toHaveLength(1))
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

      runtime.failNextStage = true
      await writeFile(dependency, "export const value = 'activation-fails'\n")
      await eventually(() => expect(runtime.states.at(-1)).toMatchObject({ state: 'failed', error: 'fixture activation rejected' }))
      expect(runtime.published).toHaveLength(3)

      await writeFile(dependency, "export const value = 'activation-recovers'\n")
      await eventually(() => expect(runtime.published).toHaveLength(4))
      expect(bootstraps).toHaveLength(4)

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
  })

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
      runtime,
      rebuildBootstrap: async () => 'fixture-bootstrap',
      setBootstrap: () => undefined,
      stdout: () => undefined,
    })
    try {
      await controller.start()
      await eventually(() => expect(runtime.states.at(-1)).toMatchObject({
        origin: 'local-dev',
        pluginId: 'first-failure',
        sourcePath: entry,
        state: 'failed',
      }))
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

  it('reports formal package dependencies as unavailable in the renderer-only phase', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cordisx-local-dev-dependencies-'))
    const entry = path.join(root, 'dependent.ts')
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'dependent', version: '1.0.0' }))
    await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify({ dependencies: [{ id: 'base', version: '1.0.0' }] }))
    await writeFile(entry, 'export default { apply() {} }\n')
    const runtime = new FixtureGenerationRuntime()
    const controller = await LocalDevelopmentController.create({
      entry,
      runtimeGeneration: 'fixture-runtime',
      runtime,
      rebuildBootstrap: async () => 'fixture-bootstrap',
      setBootstrap: () => undefined,
      stdout: () => undefined,
    })
    try {
      await controller.start()
      await eventually(() => expect(runtime.states.at(-1)).toMatchObject({
        state: 'failed',
        error: 'local development phase 1 is renderer-only; package dependencies are unavailable',
      }))
      expect(runtime.published).toHaveLength(0)
      await writeFile(path.join(root, 'cordisx-package.json'), JSON.stringify({ dependencies: [] }))
      await eventually(() => expect(runtime.published).toHaveLength(1))
    } finally {
      await controller.stop()
      await rm(root, { recursive: true, force: true })
    }
  })
})
