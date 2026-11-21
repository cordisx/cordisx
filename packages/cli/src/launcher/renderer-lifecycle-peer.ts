import { createHash } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

/** These identities are owner-created, never taken from the browser's request. */
export interface RendererAttachmentScope {
  readonly homeDigest: string
  readonly ownerAppId: string
  readonly profileId: string
  readonly generation: string
}

export interface RendererAttachmentIdentity {
  readonly appId: string
  readonly adapterId: string
  readonly rendererId: string
  readonly pid: number
  readonly processStartedAt: string
}

export type RendererAttachmentMethod =
  | 'synchronize'
  | 'prepare'
  | 'stage'
  | 'publish'
  | 'complete'
  | 'finalize'
  | 'rollback'

/** An authenticated renderer explicitly rejected an operation. */
export class RendererAttachmentRejected extends Error {
  constructor() {
    super('renderer lifecycle operation failed')
  }
}

/** Structurally compatible with the owner-scoped ManagerRendererCommandPeer. */
export interface AttachedRendererPeer {
  readonly scope: RendererAttachmentScope
  readonly identity: RendererAttachmentIdentity
  readonly sessionId: string
  readonly closed: boolean
  request(method: RendererAttachmentMethod, payload: unknown): Promise<unknown>
  onDisconnect(listener: () => void): () => void
  close(): void
}

export function attachmentHomeDigest(homeDir: string): string {
  return createHash('sha256').update(path.resolve(homeDir)).digest('hex')
}

export function attachmentEqual(first: unknown, second: unknown): boolean {
  return isDeepStrictEqual(first, second)
}

export function attachmentRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('invalid renderer lifecycle frame')
  }
  return value as Record<string, unknown>
}

export function parseAttachmentScope(value: unknown): RendererAttachmentScope {
  const scope = attachmentRecord(value)
  const keys = ['homeDigest', 'ownerAppId', 'profileId', 'generation']
  const id = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/u
  if (
    Object.keys(scope).length !== keys.length || Object.keys(scope).some(key => !keys.includes(key))
    || typeof scope.homeDigest !== 'string' || !/^[a-f0-9]{64}$/u.test(scope.homeDigest)
    || typeof scope.ownerAppId !== 'string' || !id.test(scope.ownerAppId)
    || typeof scope.profileId !== 'string' || !id.test(scope.profileId)
    || typeof scope.generation !== 'string' || !id.test(scope.generation)
  ) throw new Error('invalid renderer lifecycle scope')
  return scope as unknown as RendererAttachmentScope
}
