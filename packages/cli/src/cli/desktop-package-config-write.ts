import { isDeepStrictEqual } from 'node:util'
import type { CordisXConfigPlugin } from '../launcher/config.js'
import type { ConfigBindingRequest } from '../launcher/config-rpc.js'
import type { DesktopManagerConfigProof, RendererConfigOperation } from '../launcher/renderer-config-management.js'
import { assertPath, removePaths, setAtPath } from '../renderer/configuration/values.js'
import {
  isDesktopConfigFieldValue,
  isWritableDesktopConfigField,
  projectDesktopManagerConfig,
} from './desktop-manager-config-projection.js'
import type { ServiceRendererSnapshot } from './service-renderer-bootstrap-state.js'

type Mutation = Extract<RendererConfigOperation, { readonly action: 'update' }>

function json(value: unknown): unknown {
  const encoded = JSON.stringify(value)
  if (encoded === undefined || Buffer.byteLength(encoded) > 1_048_576) {
    throw new Error('desktop-package-config-unavailable')
  }
  return JSON.parse(encoded) as unknown
}

/** One native Desktop configuration transaction, tied to its exact request and seat. */
export class DesktopPackageConfigWrite {
  private phase:
    | 'ready'
    | 'staging'
    | 'staged'
    | 'committing'
    | 'committed'
    | 'aborting'
    | 'aborted'
    | 'failed'
    | 'closed' = 'ready'
  private candidate: unknown
  private readonly candidateRevision: number

  constructor(
    private readonly input: {
      readonly snapshot: ServiceRendererSnapshot
      readonly plugin: CordisXConfigPlugin
      readonly proof: DesktopManagerConfigProof
      readonly operation: Mutation
      readonly profileId: string
      readonly rendererGeneration: string
      readonly seat: object
      readonly current: () => boolean
      readonly run: <T>(action: () => Promise<T>) => Promise<T>
    },
  ) {
    const { plugin, proof, operation } = input
    const descriptor = proof.plugin.configuration
    const projected = projectDesktopManagerConfig(input.snapshot, plugin, proof)
    const secretPaths = descriptor.secrets.map(secret => secret.path)
    if (
      operation.pluginId !== plugin.id || operation.expectedRevision !== plugin.revision
      || descriptor.writable !== true || descriptor.applies !== 'live'
      || !Array.isArray(operation.operations) || operation.operations.length === 0 || operation.operations.length > 100
      // A legacy inline secret needs a separate migration before any write.
      || !isDeepStrictEqual(json(plugin.config), json(removePaths(plugin.config, secretPaths)))
    ) throw new Error('desktop-package-config-unavailable')
    let candidate = projected
    for (const operation of input.operation.operations) {
      if (
        operation.op !== 'set' && operation.op !== 'unset'
        || operation.op === 'set' && !Object.hasOwn(operation, 'value')
      ) {
        throw new Error('desktop-package-config-unavailable')
      }
      assertPath(operation.path)
      const field = descriptor.fields.find(value => isDeepStrictEqual(value.path, operation.path))
      if (
        !field || !isWritableDesktopConfigField(field, descriptor.secrets)
        || operation.op === 'set' && !isDesktopConfigFieldValue(field, operation.value)
      ) throw new Error('desktop-package-config-unavailable')
      candidate = setAtPath(candidate, operation.path, operation.value, operation.op === 'unset')
    }
    this.candidate = json(candidate)
    if (Buffer.byteLength(JSON.stringify(this.candidate)) > 192 * 1024) {
      throw new Error('desktop-package-config-unavailable')
    }
    this.candidateRevision = operation.expectedRevision + 1
    if (!Number.isSafeInteger(this.candidateRevision)) throw new Error('desktop-package-config-unavailable')
  }

  private current(seat: object | undefined, request: ConfigBindingRequest): boolean {
    try {
      return seat === this.input.seat && this.input.current()
        && request.identity.pluginId === this.input.plugin.id && request.identity.source === this.input.plugin.source
        && request.scope.profileId === this.input.profileId
        && request.scope.generation === this.input.rendererGeneration
    } catch {
      return false
    }
  }

  private fail(): void {
    if (this.phase !== 'closed') this.phase = 'failed'
  }

  async handle(
    seat: object | undefined,
    request: ConfigBindingRequest,
    dispatch: (request: ConfigBindingRequest) => Promise<unknown>,
  ): Promise<unknown> {
    if (!this.current(seat, request)) throw new Error('desktop-package-config-unavailable')
    const stage = this.phase === 'ready' && request.operation === 'stage'
      && request.expectedRevision === this.input.operation.expectedRevision
      && isDeepStrictEqual(json(request.config), this.candidate)
    const commit = this.phase === 'staged' && request.operation === 'commit'
      && request.candidateRevision === this.candidateRevision
    const abort = this.phase === 'staged' && request.operation === 'abort'
      && request.candidateRevision === this.candidateRevision
    if (!stage && !commit && !abort) throw new Error('desktop-package-config-unavailable')
    const pending = stage ? 'staging' : commit ? 'committing' : 'aborting'
    this.phase = pending
    try {
      const result = await this.input.run(async () => await dispatch(request))
      const record = result !== null && typeof result === 'object' && !Array.isArray(result)
        ? result as Record<string, unknown>
        : undefined
      if (
        this.phase !== pending || !this.current(seat, request)
        || stage && record?.candidateRevision !== this.candidateRevision
        || commit
          && (record?.revision !== this.candidateRevision || !isDeepStrictEqual(json(record.config), this.candidate))
      ) throw new Error('desktop-package-config-result-uncertain')
      this.phase = stage ? 'staged' : commit ? 'committed' : 'aborted'
      return stage
        ? { candidateRevision: this.candidateRevision }
        : commit
        ? { revision: this.candidateRevision }
        : undefined
    } catch {
      this.fail()
      throw new Error('desktop-package-config-result-uncertain')
    }
  }

  outcome(): 'committed' | 'aborted' | undefined {
    return this.phase === 'committed' || this.phase === 'aborted' ? this.phase : undefined
  }

  expectedValue(): unknown {
    if (this.phase === 'closed') throw new Error('desktop-package-config-unavailable')
    return structuredClone(this.candidate)
  }

  unchanged(): boolean {
    return this.phase === 'ready' || this.phase === 'aborted'
  }

  close(): void {
    this.phase = 'closed'
    this.candidate = undefined
  }
}

/** The Desktop bridge may borrow a profile fence only while its owner installed a write. */
export class DesktopPackageConfigWriteGate {
  private active: DesktopPackageConfigWrite | undefined
  private closed = false

  begin(write: DesktopPackageConfigWrite): { isCurrent(): boolean; release(): void } {
    if (this.closed || this.active) throw new Error('desktop-package-config-unavailable')
    this.active = write
    let ended = false
    return {
      isCurrent: () => !ended && !this.closed && this.active === write,
      release: () => {
        if (ended) return
        ended = true
        write.close()
        if (this.active === write) this.active = undefined
      },
    }
  }

  async handle(
    request: ConfigBindingRequest,
    seat: object | undefined,
    action: () => Promise<unknown>,
  ): Promise<unknown> {
    if (this.closed) throw new Error('desktop-package-config-unavailable')
    const write = this.active
    return write ? await write.handle(seat, request, async () => await action()) : await action()
  }

  invalidate(): void {
    this.active?.close()
    this.active = undefined
  }

  close(): void {
    this.closed = true
    this.invalidate()
  }
}
