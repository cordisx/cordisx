import type { Disposable } from '@deepseek-ai/cordis'

import {
  CORDISX_OWNER_DOCUMENT_SERVICE_V1,
  type CordisXOwnerDocumentLoadResultV1,
  type CordisXOwnerDocumentReplaceCommandV1,
  type CordisXOwnerDocumentReplaceResultV1,
  type CordisXOwnerDocumentsV1,
} from '../durable-document-contracts.js'
import type { CordisXJsonValue, CordisXPluginIdentity } from '../contracts.js'

const OWNER_DOCUMENT_BINDING = '__cordisxOwnerDocumentRequestV1'
const OWNER_DOCUMENT_RECEIVER = '__cordisxOwnerDocumentReceiveV1'
const POLL_INTERVAL_MS = 250
const MAX_WATCHES = 64
const MAX_LISTENERS = 256
const MAX_PENDING_REQUESTS = 64
const REQUEST_TIMEOUT_MS = 5_000

declare global {
  var __cordisxOwnerDocumentRequestV1: ((payload: string) => void) | undefined
  var __cordisxOwnerDocumentReceiveV1: ((payload: string) => void) | undefined
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly timer: ReturnType<typeof setTimeout>
}
interface DocumentWatch {
  readonly token: string
  readonly documentId: string
  readonly listeners: Set<
    { readonly listener: (result: CordisXOwnerDocumentLoadResultV1) => void; readonly active: () => boolean }
  >
  timer: ReturnType<typeof setInterval>
  polling: boolean
  lastKey?: string
}

export interface OwnerDocumentPrincipalBinding {
  readonly source: string
  readonly pluginId: string
  readonly moduleGeneration: string
  readonly installationId?: string
  readonly pluginGeneration?: number
  readonly token: string
}

function clone<Value>(value: Value): Value {
  return typeof globalThis.structuredClone === 'function'
    ? globalThis.structuredClone(value)
    : JSON.parse(JSON.stringify(value)) as Value
}
function deepFreeze<Value>(value: Value, seen = new Set<object>()): Value {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value
  seen.add(value)
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen)
  return Object.freeze(value)
}
function immutable<Value>(value: Value): Value {
  return deepFreeze(clone(value))
}
function unavailable(
  code: Extract<CordisXOwnerDocumentLoadResultV1, { status: 'unavailable' }>['code'],
  diagnostic: string,
  recoverable = true,
): Extract<CordisXOwnerDocumentLoadResultV1, { status: 'unavailable' }> {
  return Object.freeze({ status: 'unavailable', code, diagnostic: diagnostic.slice(0, 512), recoverable })
}
function assertDocumentId(documentId: string): void {
  if (!/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(documentId)) throw new Error('documentId is invalid')
}
function jsonValue(value: unknown, label: string, seen = new Set<object>()): CordisXJsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'object') throw new Error(`${label} must be JSON-compatible`)
  if (seen.has(value)) throw new Error(`${label} must not be circular`)
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
function resultKey(result: CordisXOwnerDocumentLoadResultV1): string {
  if (result.status === 'loaded') return `loaded:${result.snapshot.revision}`
  if (result.status === 'missing') return 'missing:0'
  return `unavailable:${result.code}:${result.diagnostic}`
}
function identityKey(
  identity: { readonly source: string; readonly id?: string; readonly pluginId?: string },
  moduleGeneration: string,
): string {
  return JSON.stringify([identity.source, identity.id ?? identity.pluginId, moduleGeneration])
}

/** One renderer transport. Principal tokens are supplied only by bound clients. */
export class BrowserOwnerDocumentBridge {
  #pending = new Map<string, PendingRequest>()
  #requestSequence = 0
  #disposed = false
  #watches = new Map<string, DocumentWatch>()
  #listenerCount = 0
  #receive = (payload: string): void => {
    let response: Record<string, unknown>
    try {
      const parsed = JSON.parse(payload) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      response = parsed as Record<string, unknown>
    } catch {
      return
    }
    if (typeof response.requestId !== 'string') return
    const pending = this.#pending.get(response.requestId)
    if (pending === undefined) return
    this.#pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value)
    else {pending.reject(
        new Error(typeof response.error === 'string' ? response.error : 'owner document bridge rejected request'),
      )}
  }

  constructor() {
    globalThis[OWNER_DOCUMENT_RECEIVER] = this.#receive
  }

  async request(
    token: string,
    value: Omit<Record<string, unknown>, 'version' | 'requestId' | 'token'>,
  ): Promise<unknown> {
    if (this.#disposed) throw new Error('owner document bridge is disposed')
    if (this.#pending.size >= MAX_PENDING_REQUESTS) throw new Error('owner document bridge request limit reached')
    const binding = globalThis[OWNER_DOCUMENT_BINDING]
    if (typeof binding !== 'function') throw new Error('owner document bridge is unavailable')
    const requestId = `documents-${Date.now().toString(36)}-${(++this.#requestSequence).toString(36)}`
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.#pending.get(requestId)
        if (pending === undefined) return
        this.#pending.delete(requestId)
        pending.reject(new Error('owner document bridge request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.#pending.set(requestId, { resolve, reject, timer })
      try {
        binding(JSON.stringify({ version: 1, requestId, token, ...value }))
      } catch (error) {
        clearTimeout(timer)
        this.#pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  #watchKey(token: string, documentId: string): string {
    return `${token}\0${documentId}`
  }

  #publish(watch: DocumentWatch, result: CordisXOwnerDocumentLoadResultV1): void {
    if (this.#disposed || this.#watches.get(this.#watchKey(watch.token, watch.documentId)) !== watch) return
    const key = resultKey(result)
    if (key === watch.lastKey) return
    watch.lastKey = key
    for (const entry of watch.listeners) {
      if (!entry.active()) continue
      try {
        entry.listener(immutable(result))
      } catch { /* isolate consumers */ }
    }
  }

  async #poll(watch: DocumentWatch): Promise<void> {
    if (watch.polling || this.#disposed || this.#watches.get(this.#watchKey(watch.token, watch.documentId)) !== watch) {
      return
    }
    watch.polling = true
    try {
      const result = immutable(
        await this.request(watch.token, {
          operation: 'load',
          documentId: watch.documentId,
        }) as CordisXOwnerDocumentLoadResultV1,
      )
      this.#publish(watch, result)
    } catch {
      /* next bounded poll retries launcher availability */
    } finally {
      watch.polling = false
    }
  }

  watch(
    token: string,
    documentId: string,
    listener: (result: CordisXOwnerDocumentLoadResultV1) => void,
    active: () => boolean,
  ): Disposable<void> {
    if (this.#disposed) throw new Error('owner document bridge is disposed')
    if (this.#listenerCount >= MAX_LISTENERS) throw new Error('owner document listener limit reached')
    const key = this.#watchKey(token, documentId)
    let watch = this.#watches.get(key)
    if (watch === undefined) {
      if (this.#watches.size >= MAX_WATCHES) throw new Error('owner document watch limit reached')
      watch = {
        token,
        documentId,
        listeners: new Set(),
        polling: false,
        timer: undefined as unknown as ReturnType<typeof setInterval>,
      }
      watch.timer = setInterval(() => {
        void this.#poll(watch!)
      }, POLL_INTERVAL_MS)
      this.#watches.set(key, watch)
      void this.#poll(watch)
    }
    const entry = { listener, active }
    watch.listeners.add(entry)
    this.#listenerCount += 1
    let subscribed = true
    return () => {
      if (!subscribed) return
      subscribed = false
      const current = this.#watches.get(key)
      if (current === undefined) return
      if (current.listeners.delete(entry)) this.#listenerCount -= 1
      if (current.listeners.size === 0) {
        clearInterval(current.timer)
        this.#watches.delete(key)
      }
    }
  }

  publish(token: string, documentId: string, result: CordisXOwnerDocumentLoadResultV1): void {
    const watch = this.#watches.get(this.#watchKey(token, documentId))
    if (watch !== undefined) this.#publish(watch, result)
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const watch of this.#watches.values()) clearInterval(watch.timer)
    this.#watches.clear()
    this.#listenerCount = 0
    if (globalThis[OWNER_DOCUMENT_RECEIVER] === this.#receive) globalThis[OWNER_DOCUMENT_RECEIVER] = undefined
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('owner document bridge is disposed'))
    }
    this.#pending.clear()
  }
}

interface BoundOwnerDocumentInput {
  readonly identity: CordisXPluginIdentity
  readonly moduleGeneration: string
  readonly active: () => boolean
}

class BoundOwnerDocuments implements CordisXOwnerDocumentsV1 {
  #disposed = false
  #subscriptions = new Set<Disposable<void>>()
  #bridge: BrowserOwnerDocumentBridge | undefined
  #token: string | undefined
  #active: () => boolean
  #onDispose: (() => void) | undefined

  constructor(
    bridge: BrowserOwnerDocumentBridge | undefined,
    token: string | undefined,
    active: () => boolean,
    onDispose: () => void,
  ) {
    this.#bridge = bridge
    this.#token = token
    this.#active = active
    this.#onDispose = onDispose
  }
  #live(): boolean {
    return !this.#disposed && this.#active()
  }

  async load(documentId: string): Promise<CordisXOwnerDocumentLoadResultV1> {
    try {
      assertDocumentId(documentId)
    } catch (error) {
      return unavailable('invalid-request', error instanceof Error ? error.message : 'documentId is invalid', false)
    }
    if (!this.#live()) return unavailable('stale-generation', 'plugin generation is stale')
    if (this.#bridge === undefined || this.#token === undefined) {
      return unavailable('bridge-unavailable', 'owner document bridge is unavailable')
    }
    try {
      return immutable(
        await this.#bridge.request(this.#token, { operation: 'load', documentId }) as CordisXOwnerDocumentLoadResultV1,
      )
    } catch {
      return unavailable('host-unavailable', 'owner document request failed')
    }
  }

  async replace(command: CordisXOwnerDocumentReplaceCommandV1): Promise<CordisXOwnerDocumentReplaceResultV1> {
    try {
      if (command.contract !== CORDISX_OWNER_DOCUMENT_SERVICE_V1) throw new Error('owner document contract is invalid')
      assertDocumentId(command.documentId)
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
        throw new Error('expectedRevision is invalid')
      }
      if (!Number.isSafeInteger(command.schemaVersion) || command.schemaVersion < 1) {
        throw new Error('schemaVersion is invalid')
      }
      const value = jsonValue(command.value, 'value')
      if (!this.#live()) return unavailable('stale-generation', 'plugin generation is stale')
      if (this.#bridge === undefined || this.#token === undefined) {
        return unavailable('bridge-unavailable', 'owner document bridge is unavailable')
      }
      // The launcher is the commit authority. Once it returns accepted, a
      // concurrent renderer retirement must not rewrite durable success to stale.
      const result = immutable(
        await this.#bridge.request(this.#token, {
          operation: 'replace',
          documentId: command.documentId,
          expectedRevision: command.expectedRevision,
          schemaVersion: command.schemaVersion,
          value,
        }) as CordisXOwnerDocumentReplaceResultV1,
      )
      if (result.status === 'accepted') {
        this.#bridge.publish(this.#token, command.documentId, { status: 'loaded', snapshot: result.snapshot })
      }
      return result
    } catch (error) {
      return unavailable('invalid-request', error instanceof Error ? error.message : 'request is invalid', false)
    }
  }

  async transaction(command: CordisXOwnerDocumentReplaceCommandV1): Promise<CordisXOwnerDocumentReplaceResultV1> {
    return await this.replace(command)
  }

  subscribe(documentId: string, listener: (result: CordisXOwnerDocumentLoadResultV1) => void): Disposable<void> {
    assertDocumentId(documentId)
    if (typeof listener !== 'function') throw new Error('owner document listener is invalid')
    if (!this.#live()) throw new Error('owner document client is stale')
    if (this.#bridge === undefined || this.#token === undefined) throw new Error('owner document bridge is unavailable')
    let unsubscribe!: Disposable<void>
    const release = this.#bridge.watch(this.#token, documentId, listener, () => this.#live())
    unsubscribe = () => {
      release()
      this.#subscriptions.delete(unsubscribe)
    }
    this.#subscriptions.add(unsubscribe)
    let active = true
    return () => {
      if (!active) return
      active = false
      unsubscribe()
    }
  }

  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const unsubscribe of [...this.#subscriptions]) unsubscribe()
    this.#subscriptions.clear()
    this.#token = undefined
    this.#bridge = undefined
    this.#onDispose?.()
    this.#onDispose = undefined
  }
}

export class CordisXOwnerDocumentBroker {
  #clients = new Set<BoundOwnerDocuments>()
  #bridge: BrowserOwnerDocumentBridge | undefined
  #bindings = new Map<string, string>()

  constructor(bridge?: BrowserOwnerDocumentBridge, bindings: readonly OwnerDocumentPrincipalBinding[] = []) {
    this.#bridge = bridge
    this.registerBindings(bindings)
  }

  registerBindings(bindings: readonly OwnerDocumentPrincipalBinding[]): void {
    for (const binding of bindings) this.#bindings.set(identityKey(binding, binding.moduleGeneration), binding.token)
  }

  bind(input: BoundOwnerDocumentInput): CordisXOwnerDocumentsV1 & { dispose(): void } {
    let client!: BoundOwnerDocuments
    client = new BoundOwnerDocuments(
      this.#bridge,
      this.#bindings.get(identityKey(input.identity, input.moduleGeneration)),
      input.active,
      () => this.#clients.delete(client),
    )
    this.#clients.add(client)
    return client
  }

  dispose(): void {
    for (const client of [...this.#clients]) client.dispose()
    this.#clients.clear()
    this.#bridge?.dispose()
    this.#bridge = undefined
  }
}
