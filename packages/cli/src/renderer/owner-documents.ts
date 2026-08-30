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
const MAX_SUBSCRIPTIONS = 64
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

interface OwnerDocumentSubscription {
  active: boolean
  polling: boolean
  timer: ReturnType<typeof setInterval>
  documentId: string
  lastKey?: string
  listener: (result: CordisXOwnerDocumentLoadResultV1) => void
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

function immutable<Value>(value: Value): Value { return deepFreeze(clone(value)) }

function unavailable(
  code: Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }>['code'],
  diagnostic: string,
  recoverable = true,
): Extract<CordisXOwnerDocumentLoadResultV1, { readonly status: 'unavailable' }> {
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

export class BrowserOwnerDocumentBridge {
  private readonly pending = new Map<string, PendingRequest>()
  private requestSequence = 0
  private disposed = false
  private readonly receive = (payload: string): void => {
    let response: Record<string, unknown>
    try {
      const parsed = JSON.parse(payload) as unknown
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return
      response = parsed as Record<string, unknown>
    } catch { return }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value)
    else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'owner document bridge rejected request'))
  }

  constructor(
    private readonly token: string,
    readonly profileId: string,
    readonly generation: string,
  ) {
    globalThis[OWNER_DOCUMENT_RECEIVER] = this.receive
  }

  async request(value: Omit<Record<string, unknown>, 'version' | 'requestId' | 'token' | 'scope'>): Promise<unknown> {
    if (this.disposed) throw new Error('owner document bridge is disposed')
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw new Error('owner document bridge request limit reached')
    const binding = globalThis[OWNER_DOCUMENT_BINDING]
    if (typeof binding !== 'function') throw new Error('owner document bridge is unavailable')
    const requestId = `documents-${Date.now().toString(36)}-${(++this.requestSequence).toString(36)}`
    return await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        this.pending.delete(requestId)
        pending.reject(new Error('owner document bridge request timed out'))
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(requestId, { resolve, reject, timer })
      try {
        binding(JSON.stringify({
          version: 1,
          requestId,
          token: this.token,
          scope: { profileId: this.profileId, generation: this.generation },
          ...value,
        }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(requestId)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (globalThis[OWNER_DOCUMENT_RECEIVER] === this.receive) globalThis[OWNER_DOCUMENT_RECEIVER] = undefined
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('owner document bridge is disposed'))
    }
    this.pending.clear()
  }
}

interface BoundOwnerDocumentInput {
  readonly identity: CordisXPluginIdentity
  readonly active: () => boolean
}

class BoundOwnerDocuments implements CordisXOwnerDocumentsV1 {
  private disposed = false
  private readonly subscriptions = new Set<OwnerDocumentSubscription>()

  constructor(
    private readonly bridge: BrowserOwnerDocumentBridge | undefined,
    private readonly input: BoundOwnerDocumentInput,
  ) {}

  private live(): boolean { return !this.disposed && this.input.active() }

  async load(documentId: string): Promise<CordisXOwnerDocumentLoadResultV1> {
    try { assertDocumentId(documentId) } catch (error) {
      return unavailable('invalid-request', error instanceof Error ? error.message : 'documentId is invalid', false)
    }
    if (!this.live()) return unavailable('stale-generation', 'plugin generation is stale')
    if (this.bridge === undefined) return unavailable('bridge-unavailable', 'owner document bridge is unavailable')
    try {
      const value = await this.bridge.request({
        operation: 'load',
        identity: { source: this.input.identity.source, pluginId: this.input.identity.id },
        documentId,
      })
      if (!this.live()) return unavailable('stale-generation', 'plugin generation is stale')
      return immutable(value as CordisXOwnerDocumentLoadResultV1)
    } catch {
      return unavailable('host-unavailable', 'owner document request failed')
    }
  }

  async replace(command: CordisXOwnerDocumentReplaceCommandV1): Promise<CordisXOwnerDocumentReplaceResultV1> {
    try {
      if (command.contract !== CORDISX_OWNER_DOCUMENT_SERVICE_V1) throw new Error('owner document contract is invalid')
      assertDocumentId(command.documentId)
      if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw new Error('expectedRevision is invalid')
      if (!Number.isSafeInteger(command.schemaVersion) || command.schemaVersion < 1) throw new Error('schemaVersion is invalid')
      const value = jsonValue(command.value, 'value')
      if (!this.live()) return unavailable('stale-generation', 'plugin generation is stale')
      if (this.bridge === undefined) return unavailable('bridge-unavailable', 'owner document bridge is unavailable')
      const result = immutable(await this.bridge.request({
        operation: 'replace',
        identity: { source: this.input.identity.source, pluginId: this.input.identity.id },
        documentId: command.documentId,
        expectedRevision: command.expectedRevision,
        schemaVersion: command.schemaVersion,
        value,
      }) as CordisXOwnerDocumentReplaceResultV1)
      if (!this.live()) return unavailable('stale-generation', 'plugin generation is stale')
      if (result.status === 'accepted') this.publish(command.documentId, { status: 'loaded', snapshot: result.snapshot })
      return result
    } catch (error) {
      return unavailable('invalid-request', error instanceof Error ? error.message : 'request is invalid', false)
    }
  }

  async transaction(command: CordisXOwnerDocumentReplaceCommandV1): Promise<CordisXOwnerDocumentReplaceResultV1> {
    return await this.replace(command)
  }

  private publish(documentId: string, result: CordisXOwnerDocumentLoadResultV1): void {
    if (!this.live()) return
    for (const subscription of this.subscriptions) {
      if (!subscription.active || subscription.documentId !== documentId) continue
      const key = resultKey(result)
      if (key === subscription.lastKey) continue
      subscription.lastKey = key
      try { subscription.listener(immutable(result)) } catch { /* subscriber errors cannot change a committed CAS result */ }
    }
  }

  private async poll(subscription: OwnerDocumentSubscription): Promise<void> {
    if (!subscription.active || subscription.polling || !this.live()) return
    subscription.polling = true
    try {
      const result = await this.load(subscription.documentId)
      if (!subscription.active || !this.live()) return
      const key = resultKey(result)
      if (key === subscription.lastKey) return
      subscription.lastKey = key
      try { subscription.listener(result) } catch { /* isolate plugin subscriber failures */ }
    } finally {
      subscription.polling = false
    }
  }

  subscribe(documentId: string, listener: (result: CordisXOwnerDocumentLoadResultV1) => void): Disposable<void> {
    assertDocumentId(documentId)
    if (typeof listener !== 'function') throw new Error('owner document listener is invalid')
    if (!this.live()) throw new Error('owner document client is stale')
    if (this.subscriptions.size >= MAX_SUBSCRIPTIONS) throw new Error('owner document subscription limit reached')
    const subscription = {
      active: true,
      polling: false,
      documentId,
      listener,
      timer: setInterval(() => { void this.poll(subscription) }, POLL_INTERVAL_MS),
    }
    this.subscriptions.add(subscription)
    void this.poll(subscription)
    return () => {
      if (!subscription.active) return
      subscription.active = false
      clearInterval(subscription.timer)
      this.subscriptions.delete(subscription)
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const subscription of this.subscriptions) {
      subscription.active = false
      clearInterval(subscription.timer)
    }
    this.subscriptions.clear()
  }
}

export class CordisXOwnerDocumentBroker {
  private readonly clients = new Set<BoundOwnerDocuments>()

  constructor(private readonly bridge?: BrowserOwnerDocumentBridge) {}

  bind(input: BoundOwnerDocumentInput): CordisXOwnerDocumentsV1 & { dispose(): void } {
    const client = new BoundOwnerDocuments(this.bridge, input)
    this.clients.add(client)
    const dispose = client.dispose.bind(client)
    client.dispose = () => { dispose(); this.clients.delete(client) }
    return client
  }

  dispose(): void {
    for (const client of [...this.clients]) client.dispose()
    this.clients.clear()
    this.bridge?.dispose()
  }
}
