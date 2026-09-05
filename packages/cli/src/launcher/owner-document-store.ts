import { createHash, randomBytes } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'

import {
  CORDISX_OWNER_DOCUMENT_SERVICE_V1,
  type CordisXOwnerDocumentLoadResultV1,
  type CordisXOwnerDocumentReplaceResultV1,
} from '../durable-document-contracts.js'
import type { CordisXJsonValue } from '../contracts.js'

export const OWNER_DOCUMENT_MAX_DOCUMENT_BYTES = 524_288
export const OWNER_DOCUMENT_MAX_OWNER_BYTES = 4_194_304
export const OWNER_DOCUMENT_MAX_DOCUMENTS = 64
const STORE_SCHEMA_VERSION = 1
const LOCK_STALE_MS = 15_000
const LOCK_TIMEOUT_MS = 5_000

export interface OwnerDocumentIdentity {
  readonly source: string
  readonly pluginId: string
}

export interface OwnerDocumentStoreScope {
  readonly profileId: string
  readonly identity: OwnerDocumentIdentity
}

interface StoredDocument {
  readonly revision: number
  readonly schemaVersion: number
  readonly value: CordisXJsonValue
}

interface StoredOwnerDocuments {
  readonly contract: typeof CORDISX_OWNER_DOCUMENT_SERVICE_V1
  readonly storeSchemaVersion: typeof STORE_SCHEMA_VERSION
  readonly profileId: string
  readonly identity: OwnerDocumentIdentity
  readonly documents: Readonly<Record<string, StoredDocument>>
}

type StoreRead =
  | { readonly status: 'ready'; readonly value: StoredOwnerDocuments }
  | {
    readonly status: 'unavailable'
    readonly result: Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }>
  }

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function unavailable(
  code: Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }>['code'],
  diagnostic: string,
  recoverable = true,
): Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }> {
  return { status: 'unavailable', code, diagnostic: diagnostic.slice(0, 512), recoverable }
}

function assertDocumentId(documentId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(documentId)) throw new Error('documentId is invalid')
}

function assertScope(scope: OwnerDocumentStoreScope): void {
  if (scope.profileId.length === 0 || scope.profileId.length > 128) throw new Error('profileId is invalid')
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(scope.identity.pluginId)) throw new Error('pluginId is invalid')
  if (scope.identity.source.length === 0 || byteLength(scope.identity.source) > 4096) {
    throw new Error('plugin source is invalid')
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key))
  if (unknown !== undefined) throw new Error(`${label} contains unknown field ${unknown}`)
}

function jsonValue(value: unknown, label: string, seen = new Set<object>()): CordisXJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error(`${label} is not JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} is circular`)
  seen.add(value)
  try {
    if (Array.isArray(value)) return value.map((entry, index) => jsonValue(entry, `${label}[${index}]`, seen))
    const output: Record<string, CordisXJsonValue> = Object.create(null) as Record<string, CordisXJsonValue>
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error(`${label} contains a reserved key`)
      output[key] = jsonValue(entry, `${label}.${key}`, seen)
    }
    return output
  } finally {
    seen.delete(value)
  }
}

function parseStored(value: unknown, scope: OwnerDocumentStoreScope): StoredOwnerDocuments {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('store root is invalid')
  const root = value as Record<string, unknown>
  assertExactKeys(root, ['contract', 'storeSchemaVersion', 'profileId', 'identity', 'documents'], 'store root')
  if (root.contract !== CORDISX_OWNER_DOCUMENT_SERVICE_V1 || root.storeSchemaVersion !== STORE_SCHEMA_VERSION) {
    throw new Error('store schema is unsupported')
  }
  if (root.profileId !== scope.profileId) throw new Error('store profile identity is invalid')
  const identity = root.identity
  if (identity === null || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('store owner identity is invalid')
  }
  const owner = identity as Record<string, unknown>
  assertExactKeys(owner, ['source', 'pluginId'], 'store owner identity')
  if (owner.source !== scope.identity.source || owner.pluginId !== scope.identity.pluginId) {
    throw new Error('store owner identity is invalid')
  }
  if (root.documents === null || typeof root.documents !== 'object' || Array.isArray(root.documents)) {
    throw new Error('store documents are invalid')
  }
  const entries = Object.entries(root.documents as Record<string, unknown>)
  if (entries.length > OWNER_DOCUMENT_MAX_DOCUMENTS) throw new Error('store document count exceeds quota')
  const documents: Record<string, StoredDocument> = Object.create(null) as Record<string, StoredDocument>
  for (const [documentId, candidate] of entries) {
    assertDocumentId(documentId)
    if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new Error('stored document is invalid')
    }
    const item = candidate as Record<string, unknown>
    assertExactKeys(item, ['revision', 'schemaVersion', 'value'], `stored document ${documentId}`)
    if (!Number.isSafeInteger(item.revision) || (item.revision as number) < 1) {
      throw new Error('stored document revision is invalid')
    }
    if (!Number.isSafeInteger(item.schemaVersion) || (item.schemaVersion as number) < 1) {
      throw new Error('stored document schemaVersion is invalid')
    }
    const normalized = jsonValue(item.value, `documents.${documentId}.value`)
    if (byteLength(JSON.stringify(normalized)) > OWNER_DOCUMENT_MAX_DOCUMENT_BYTES) {
      throw new Error('stored document exceeds quota')
    }
    documents[documentId] = {
      revision: item.revision as number,
      schemaVersion: item.schemaVersion as number,
      value: normalized,
    }
  }
  return {
    contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    profileId: scope.profileId,
    identity: { ...scope.identity },
    documents,
  }
}

function emptyStore(scope: OwnerDocumentStoreScope): StoredOwnerDocuments {
  return {
    contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
    storeSchemaVersion: STORE_SCHEMA_VERSION,
    profileId: scope.profileId,
    identity: { ...scope.identity },
    documents: {},
  }
}

/** Launcher-owned authority. All calls on one instance are linearly serialized. */
export class OwnerDocumentStore {
  private queue: Promise<void> = Promise.resolve()

  constructor(
    private readonly homeDir: string,
    private readonly hooks: { readonly beforeCommit?: () => void | Promise<void> } = {},
  ) {}

  private ownerPath(scope: OwnerDocumentStoreScope): string {
    assertScope(scope)
    const key = createHash('sha256')
      .update(scope.profileId).update('\0')
      .update(scope.identity.source).update('\0')
      .update(scope.identity.pluginId)
      .digest('hex')
    return path.join(this.homeDir, 'state', 'owner-documents', 'v1', key.slice(0, 2), `${key}.json`)
  }

  private async serialized<Value>(operation: () => Promise<Value>): Promise<Value> {
    const previous = this.queue
    let release!: () => void
    this.queue = new Promise<void>(resolve => {
      release = resolve
    })
    await previous
    try {
      return await operation()
    } finally {
      release()
    }
  }

  private async locked<Value>(scope: OwnerDocumentStoreScope, operation: () => Promise<Value>): Promise<Value> {
    const file = this.ownerPath(scope)
    const lock = `${file}.lock`
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const started = Date.now()
    while (true) {
      try {
        await mkdir(lock, { mode: 0o700 })
        await writeFile(path.join(lock, 'owner'), `${process.pid}\n${Date.now()}\n`, { mode: 0o600 })
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
        const metadata = await stat(lock).catch(() => undefined)
        if (metadata !== undefined && Date.now() - metadata.mtimeMs > LOCK_STALE_MS) {
          const recovery = `${lock}.recovery`
          let recoveryOwned = false
          try {
            await mkdir(recovery, { mode: 0o700 })
            recoveryOwned = true
            await writeFile(path.join(recovery, 'owner'), `${process.pid}\n${Date.now()}\n`, { mode: 0o600 })
            // Re-read only after exclusively owning recovery. This prevents two
            // cleaners from deleting a newly reacquired live lock.
            const current = await stat(lock).catch(() => undefined)
            if (
              current !== undefined && Date.now() - current.mtimeMs > LOCK_STALE_MS
              && !await this.lockOwnerLive(lock)
            ) await rm(lock, { recursive: true, force: true })
          } catch (recoveryError) {
            if ((recoveryError as NodeJS.ErrnoException).code !== 'EEXIST') throw recoveryError
            const recoveryMetadata = await stat(recovery).catch(() => undefined)
            if (
              recoveryMetadata !== undefined && Date.now() - recoveryMetadata.mtimeMs > LOCK_STALE_MS
              && !await this.lockOwnerLive(recovery)
            ) await rm(recovery, { recursive: true, force: true })
          } finally {
            if (recoveryOwned) await rm(recovery, { recursive: true, force: true })
          }
          continue
        }
        if (Date.now() - started >= LOCK_TIMEOUT_MS) throw new Error('owner document store lock timed out')
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    }
    try {
      return await operation()
    } finally {
      await rm(lock, { recursive: true, force: true })
    }
  }

  private async lockOwnerLive(lock: string): Promise<boolean> {
    const owner = await readFile(path.join(lock, 'owner'), 'utf8').catch(() => '')
    const pid = Number.parseInt(owner.split('\n')[0] ?? '', 10)
    if (!Number.isSafeInteger(pid) || pid <= 0) return false
    try {
      process.kill(pid, 0)
      return true
    } catch (probe) {
      return (probe as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  private async read(scope: OwnerDocumentStoreScope): Promise<StoreRead> {
    const file = this.ownerPath(scope)
    let raw: string
    try {
      const metadata = await stat(file)
      if (!metadata.isFile()) {
        return { status: 'unavailable', result: unavailable('corrupt-store', 'owner document store is not a file') }
      }
      if (metadata.size > OWNER_DOCUMENT_MAX_OWNER_BYTES) {
        return { status: 'unavailable', result: unavailable('quota-exceeded', 'owner document store exceeds quota') }
      }
      raw = await readFile(file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'ready', value: emptyStore(scope) }
      return {
        status: 'unavailable',
        result: unavailable('host-unavailable', 'owner document store could not be read'),
      }
    }
    if (byteLength(raw) > OWNER_DOCUMENT_MAX_OWNER_BYTES) {
      return { status: 'unavailable', result: unavailable('quota-exceeded', 'owner document store exceeds quota') }
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return { status: 'unavailable', result: unavailable('corrupt-store', 'owner document store is corrupt') }
    }
    try {
      return { status: 'ready', value: parseStored(parsed, scope) }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'owner document store is invalid'
      const code = message.includes('schema is unsupported')
        ? 'unsupported-store-schema' as const
        : message.includes('quota')
        ? 'quota-exceeded' as const
        : 'corrupt-store' as const
      return { status: 'unavailable', result: unavailable(code, message) }
    }
  }

  private async write(
    scope: OwnerDocumentStoreScope,
    value: StoredOwnerDocuments,
    commitAllowed?: () => boolean,
  ): Promise<boolean> {
    const output = `${JSON.stringify(value)}\n`
    if (byteLength(output) > OWNER_DOCUMENT_MAX_OWNER_BYTES) throw new Error('owner document store exceeds quota')
    const file = this.ownerPath(scope)
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    const temporary = `${file}.${process.pid}.${randomBytes(8).toString('hex')}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(output, 'utf8')
      await handle.sync()
      await handle.close()
      await this.hooks.beforeCommit?.()
      // This is the CAS linearization fence: it runs under the same owner lock
      // immediately before atomic rename, after all temporary bytes are synced.
      if (commitAllowed?.() === false) return false
      await rename(temporary, file)
      return true
    } finally {
      await handle.close().catch(() => undefined)
      await unlink(temporary).catch(() => undefined)
    }
  }

  async load(scope: OwnerDocumentStoreScope, documentId: string): Promise<CordisXOwnerDocumentLoadResultV1> {
    return await this.serialized(async () => {
      try {
        assertDocumentId(documentId)
      } catch {
        return unavailable('invalid-request', 'documentId is invalid', false)
      }
      const read = await this.read(scope)
      if (read.status === 'unavailable') return read.result
      const document = read.value.documents[documentId]
      return document === undefined
        ? { status: 'missing', revision: 0 }
        : {
          status: 'loaded',
          snapshot: {
            contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
            revision: document.revision,
            schemaVersion: document.schemaVersion,
            value: document.value,
          },
        }
    })
  }

  async replace(input: {
    readonly scope: OwnerDocumentStoreScope
    readonly documentId: string
    readonly expectedRevision: number
    readonly schemaVersion: number
    readonly value: unknown
    /** Synchronous authority fence checked at the commit linearization point. */
    readonly commitAllowed?: () => boolean
  }): Promise<CordisXOwnerDocumentReplaceResultV1> {
    return await this.serialized(async () => {
      try {
        return await this.locked(input.scope, async () => {
          try {
            assertDocumentId(input.documentId)
            if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0) {
              throw new Error('expectedRevision is invalid')
            }
            if (!Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1) {
              throw new Error('schemaVersion is invalid')
            }
            const value = jsonValue(input.value, 'value')
            if (byteLength(JSON.stringify(value)) > OWNER_DOCUMENT_MAX_DOCUMENT_BYTES) {
              return unavailable('quota-exceeded', 'document exceeds quota', false)
            }
            const read = await this.read(input.scope)
            if (read.status === 'unavailable') return read.result
            const actualRevision = read.value.documents[input.documentId]?.revision ?? 0
            if (actualRevision !== input.expectedRevision) return { status: 'conflict', actualRevision }
            if (
              read.value.documents[input.documentId] === undefined
              && Object.keys(read.value.documents).length >= OWNER_DOCUMENT_MAX_DOCUMENTS
            ) {
              return unavailable('quota-exceeded', 'owner document count exceeds quota', false)
            }
            const revision = actualRevision + 1
            const next: StoredOwnerDocuments = {
              ...read.value,
              documents: {
                ...read.value.documents,
                [input.documentId]: { revision, schemaVersion: input.schemaVersion, value },
              },
            }
            try {
              if (!await this.write(input.scope, next, input.commitAllowed)) {
                return unavailable('stale-generation', 'plugin owner is stale', true)
              }
            } catch (error) {
              if (error instanceof Error && error.message.includes('quota')) {
                return unavailable('quota-exceeded', error.message, false)
              }
              return unavailable('host-unavailable', 'owner document store could not be committed')
            }
            return {
              status: 'accepted',
              snapshot: {
                contract: CORDISX_OWNER_DOCUMENT_SERVICE_V1,
                revision,
                schemaVersion: input.schemaVersion,
                value,
              },
            }
          } catch (error) {
            return unavailable('invalid-request', error instanceof Error ? error.message : 'request is invalid', false)
          }
        })
      } catch {
        return unavailable('host-unavailable', 'owner document store lock could not be acquired')
      }
    })
  }
}
