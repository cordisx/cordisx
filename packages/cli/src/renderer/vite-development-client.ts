import type { installCordisX, RendererPluginMutation } from './runtime.js'
import { CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1 } from '../plugin-lifecycle-contracts.js'

type Install = typeof installCordisX
type Runtime = Awaited<ReturnType<Install>>
type Metadata = Parameters<Install>[1]
type BrowserPlugin = Parameters<Install>[0][number]

export interface ViteDevelopmentPlugin {
  readonly plugin: BrowserPlugin & { readonly isolatedArtifactSource?: string }
  readonly ownerDocumentBindings: NonNullable<Metadata['ownerDocumentBindings']>
}

export interface ViteDevelopmentGenerationTransaction {
  commit(): Promise<void>
  rollback(): Promise<void>
}

/** Receives Vite HMR updates in the renderer. No CDP update transport is involved. */
export class NativeViteDevelopmentClient {
  private runtime: Runtime | undefined
  private queue: Promise<unknown> = Promise.resolve()
  private stopped = false
  private plugins: ViteDevelopmentPlugin[]

  constructor(
    private readonly metadata: Metadata,
    plugins: readonly ViteDevelopmentPlugin[],
    private readonly disposeSharedReactRuntime: () => void,
    private readonly stagePluginGeneration?: (
      pluginId: string,
      moduleGeneration: string,
    ) => Promise<ViteDevelopmentGenerationTransaction>,
  ) {
    this.plugins = [...plugins]
  }

  private serial<T>(action: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      if (this.stopped) throw new Error('CordisX Vite development session is closed')
      return await action()
    })
    this.queue = result.catch(error => { console.error('[cordisx] Vite update failed; previous version retained where possible', error) })
    return result
  }

  restart(install: Install): Promise<Runtime> {
    return this.serial(async () => {
      const activation = this.runtime?.activePluginGeneration() ?? {
        $schema: CORDISX_PLUGIN_ACTIVATION_SCHEMA_V1,
        schemaVersion: 1 as const,
        recordKind: 'active' as const,
        profileId: this.metadata.profileId,
        runtimeGeneration: this.metadata.generation!,
        revision: 0,
        lastGoodRevision: 0,
        plugins: this.plugins.filter(item => item.plugin.enabled).map(({ plugin }) => ({
          id: plugin.id,
          version: plugin.package!.version,
          digest: plugin.package!.digest,
          moduleGeneration: plugin.package!.moduleGeneration,
          dependencies: [],
          enabled: true,
        })),
      }
      await this.runtime?.dispose()
      // The native document and launcher authority remain the same; only the
      // CordisX renderer is recreated. Clear the initial-injection deduplicator.
      globalThis.__cordisxBootGeneration = undefined
      this.runtime = await install(this.plugins.map(item => item.plugin), {
        ...this.metadata,
        pluginActivation: activation,
        ownerDocumentBindings: this.plugins.flatMap(item => item.ownerDocumentBindings),
      })
      return this.runtime
    })
  }

  update(artifact: ViteDevelopmentPlugin): Promise<void> {
    return this.serial(async () => {
      const runtime = this.runtime
      if (runtime === undefined) throw new Error('CordisX Vite runtime is not ready')
      const plugin = artifact.plugin
      const previous = runtime.activePluginGeneration()
      if (previous.plugins.find(item => item.id === plugin.id)?.digest === plugin.package!.digest) return
      const transactionId = `vite-${crypto.randomUUID()}`
      const item = {
        id: plugin.id,
        version: plugin.package!.version,
        digest: plugin.package!.digest,
        moduleGeneration: plugin.package!.moduleGeneration,
        dependencies: [],
        enabled: plugin.enabled,
      }
      const candidate = {
        ...previous,
        recordKind: 'candidate' as const,
        transactionId,
        revision: previous.revision + 1,
        lastGoodRevision: previous.revision,
        plugins: previous.plugins.some(value => value.id === plugin.id)
          ? previous.plugins.map(value => value.id === plugin.id ? item : value)
          : [...previous.plugins, item],
      }
      const mutation: RendererPluginMutation = {
        transactionId,
        operation: previous.plugins.some(value => value.id === plugin.id) ? 'update' : 'install',
        previous, candidate,
        targetId: plugin.id,
        affectedPluginIds: [plugin.id],
        developmentPackage: {
          id: plugin.id,
          version: plugin.package!.version,
          digest: plugin.package!.digest,
          identitySource: plugin.source,
          development: plugin.development!,
          ...(plugin.readme === undefined ? {} : { readme: plugin.readme }),
          ...(plugin.readmes === undefined ? {} : { readmes: plugin.readmes }),
          ...(plugin.manifest === undefined ? {} : { manifest: plugin.manifest }),
        },
        ...(plugin.isolatedArtifactSource === undefined ? {} : {
          isolatedArtifactSource: plugin.isolatedArtifactSource,
        }),
        ownerDocumentBindings: artifact.ownerDocumentBindings,
      }
      await runtime.settleRegistryProjection()
      let generationTransaction: ViteDevelopmentGenerationTransaction | undefined
      let rendererTransactionStarted = false
      try {
        generationTransaction = await this.stagePluginGeneration?.(plugin.id, plugin.package!.moduleGeneration)
        rendererTransactionStarted = true
        await runtime.stagePluginMutation(mutation, plugin.module, plugin.moduleFactory)
        await runtime.publishPluginMutation(transactionId)
        await runtime.completePluginMutation(transactionId)
        await runtime.finalizePluginMutation(transactionId)
        await generationTransaction?.commit()
      } catch (error) {
        // Restore renderer state before returning Host declarations to last-good.
        const rollbackErrors: unknown[] = []
        if (rendererTransactionStarted) {
          try { await runtime.rollbackPluginMutation(transactionId) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        }
        try { await generationTransaction?.rollback() } catch (rollbackError) { rollbackErrors.push(rollbackError) }
        if (rollbackErrors.length > 0) {
          this.stopped = true
          throw new AggregateError([error, ...rollbackErrors], 'Vite plugin rollback failed; updates paused')
        }
        throw error
      }
      const index = this.plugins.findIndex(value => value.plugin.id === plugin.id)
      if (index < 0) this.plugins.push(artifact)
      else this.plugins[index] = artifact
      console.info(`[cordisx] Vite plugin updated: ${plugin.id}`)
    })
  }

  async dispose(preserveSharedReactRuntime = false): Promise<void> {
    this.stopped = true
    await this.queue
    try {
      await this.runtime?.dispose()
    } finally {
      this.runtime = undefined
      if (!preserveSharedReactRuntime) this.disposeSharedReactRuntime()
    }
  }
}

declare global {
  var __cordisxViteClient: NativeViteDevelopmentClient | undefined
  var __cordisxViteBoot: Promise<unknown> | undefined
}
