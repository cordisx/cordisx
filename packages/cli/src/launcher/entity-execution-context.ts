import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { EntityRecord } from '@cordisx/protocol/entities/v1'
import type {
  EntityExecutionBinding,
  EntityExecutionBindingResult,
  EntityExecutionBindingWrite,
  EntityExecutionBindingWriteResult,
  EntityExecutionContextResult,
} from '@cordisx/protocol/entity-execution-context/v1'
import { OwnerDocumentStore, type OwnerDocumentStoreScope } from './owner-document-store.js'

const id = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const digest = (value: string): string => createHash('sha256').update(value).digest('hex')
export function validEntityExecutionBinding(value: unknown): value is EntityExecutionBinding {
  if (!record(value)) return false
  if (value.kind === 'projectless') return Object.keys(value).every(key => key === 'kind')
  return value.kind === 'project' && id(value.projectId)
    && Object.keys(value).every(key => ['kind', 'projectId', 'cwd'].includes(key))
    && (value.cwd === undefined
      || typeof value.cwd === 'string' && path.isAbsolute(value.cwd) && !value.cwd.includes('\0'))
}
function scope(entity: EntityRecord): OwnerDocumentStoreScope {
  return {
    profileId: entity.owner.profileId,
    identity: {
      pluginId: entity.owner.pluginId,
      // Host-owned Entity configuration, inaccessible through a plugin's normal document source.
      source: `cordisx:entity-execution-context/${entity.owner.installationId}/${entity.identity.agentId}`,
    },
  }
}

/** One binding per owned Entity, persisted through the existing locked CAS document store. */
export class EntityExecutionContextDirectory {
  private readonly store: OwnerDocumentStore
  constructor(private readonly homeDir: string, private readonly profileId: string) {
    this.store = new OwnerDocumentStore(homeDir)
  }

  async get(entity: EntityRecord): Promise<EntityExecutionBindingResult> {
    const result = await this.store.load(scope(entity), 'binding')
    if (result.status === 'missing') return { status: 'available', revision: 0, binding: { kind: 'projectless' } }
    if (
      result.status !== 'loaded' || !record(result.snapshot.value)
      || !validEntityExecutionBinding(result.snapshot.value.binding)
    ) return { status: 'unavailable', code: 'host-unavailable' }
    return {
      status: 'available',
      revision: result.snapshot.revision,
      binding: structuredClone(result.snapshot.value.binding),
    }
  }

  async set(
    entity: EntityRecord,
    request: EntityExecutionBindingWrite,
    active: () => boolean,
  ): Promise<EntityExecutionBindingWriteResult> {
    if (
      !record(request) || !id(request.mutationId) || !Number.isSafeInteger(request.expectedRevision)
      || request.expectedRevision < 0 || !validEntityExecutionBinding(request.binding)
      || !Object.keys(request).every(key => ['identity', 'mutationId', 'expectedRevision', 'binding'].includes(key))
    ) {
      return { status: 'unavailable', code: 'invalid-input' }
    }
    const binding: EntityExecutionBinding = request.binding.kind === 'projectless' ? { kind: 'projectless' } : {
      kind: 'project',
      projectId: request.binding.projectId,
      ...(request.binding.cwd === undefined ? {} : { cwd: request.binding.cwd }),
    }
    const fingerprint = JSON.stringify([entity.identity, binding, request.expectedRevision])
    const previous = await this.store.load(scope(entity), 'binding')
    if (previous.status !== 'loaded' && previous.status !== 'missing') {
      return { status: 'unavailable', code: 'host-unavailable' }
    }
    const revision = previous.status === 'loaded' ? previous.snapshot.revision : 0
    const saved = previous.status === 'loaded' && record(previous.snapshot.value) ? previous.snapshot.value : undefined
    if (saved?.mutationId === request.mutationId) {
      return saved.fingerprint === fingerprint
        ? { status: 'applied', disposition: 'replayed', revision, binding }
        : { status: 'unavailable', code: 'operation-conflict' }
    }
    if (request.expectedRevision !== revision) return { status: 'conflict', currentRevision: revision }
    if (!active()) return { status: 'unavailable', code: 'host-unavailable' }
    const result = await this.store.replace({
      scope: scope(entity),
      documentId: 'binding',
      expectedRevision: revision,
      schemaVersion: 1,
      value: { mutationId: request.mutationId, fingerprint, binding },
      commitAllowed: active,
    })
    return result.status === 'accepted'
      ? {
        status: 'applied',
        disposition: revision === 0 ? 'created' : 'updated',
        revision: result.snapshot.revision,
        binding,
      }
      : result.status === 'conflict'
      ? { status: 'conflict', currentRevision: result.actualRevision }
      : { status: 'unavailable', code: 'host-unavailable' }
  }

  async resolve(
    entity: EntityRecord,
    operationId: string,
    active: () => boolean,
  ): Promise<EntityExecutionContextResult> {
    if (!id(operationId)) return { status: 'unavailable', code: 'invalid-input' }
    const snapshot = await this.get(entity)
    if (snapshot.status !== 'available') return snapshot
    if (!active()) return { status: 'unavailable', code: 'host-unavailable' }
    if (snapshot.binding.kind === 'project') {
      return { status: 'resolved', binding: snapshot.binding, context: { ...snapshot.binding } }
    }
    const root = await realpath(this.homeDir)
    const components = [
      'profiles',
      this.profileId,
      'workspaces',
      'projectless',
      digest(JSON.stringify([entity.owner, entity.identity.agentId])),
      digest(operationId),
    ]
    let cwd = root
    for (const component of components) {
      if (!active()) return { status: 'unavailable', code: 'host-unavailable' }
      cwd = path.join(cwd, component)
      await mkdir(cwd, { mode: 0o700 }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      })
      const stat = await lstat(cwd)
      if (
        !stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
        || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      ) {
        return { status: 'unavailable', code: 'host-unavailable' }
      }
    }
    if (!active()) return { status: 'unavailable', code: 'host-unavailable' }
    return { status: 'resolved', binding: snapshot.binding, context: { kind: 'directory', cwd: await realpath(cwd) } }
  }
}
