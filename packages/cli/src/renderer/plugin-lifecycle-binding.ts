import {
  CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginLifecycleOperationV1,
  type CordisXPluginLifecycleRequestV1,
  type CordisXPluginLifecycleResultV1,
} from '../plugin-lifecycle-contracts.js'
import type {
  CordisXPermissionAuthorizationDecisionV2,
  CordisXPermissionAuthorizationDecisionV4,
  CordisXPermissionAuthorizationPlanV2,
  CordisXPermissionAuthorizationPlanV4,
} from '../permission-contracts.js'
import {
  CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1,
  type CordisXPluginBundleLifecycleOperationV1,
  type CordisXPluginBundleLifecycleRequestV1,
  type CordisXPluginBundleLifecycleResultV1,
  type CordisXPluginBundleManagerSnapshotV1,
} from '../plugin-bundle-contracts.js'

const BINDING = '__cordisxPluginLifecycleRequestV1'
const RECEIVER = '__cordisxPluginLifecycleReceiveV1'

declare global {
  interface Window {
    __cordisxPluginLifecycleRequestV1?: (payload: string) => void
    __cordisxPluginLifecycleReceiveV1?: (payload: string) => void
  }
}

export class BrowserPluginLifecycleBridge {
  private readonly pending = new Map<string, {
    readonly resolve: (value: unknown) => void
    readonly reject: (error: Error) => void
    readonly timer: ReturnType<typeof setTimeout>
  }>()
  private disposed = false

  constructor(
    private readonly token: string,
    private readonly profileId: string,
    private readonly generation: string,
  ) {
    window[RECEIVER] = payload => this.receive(payload)
  }

  request(expectedRevision: number, operation: CordisXPluginLifecycleOperationV1): Promise<CordisXPluginLifecycleResultV1> {
    if (this.disposed) return Promise.reject(new Error('plugin lifecycle bridge is disposed'))
    const binding = window[BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    const requestId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const request: CordisXPluginLifecycleRequestV1 = {
      $schema: CORDISX_PLUGIN_LIFECYCLE_OPERATION_SCHEMA_V1,
      schemaVersion: 1,
      requestId,
      profileId: this.profileId,
      expectedRevision,
      runtimeGeneration: this.generation,
      operation,
    }
    return this.send<CordisXPluginLifecycleResultV1>(requestId, { token: this.token, request })
  }

  bundleSnapshot(): Promise<CordisXPluginBundleManagerSnapshotV1> {
    const requestId = this.requestId()
    return this.send(requestId, {
      token: this.token,
      privateRequest: {
        kind: 'bundle-snapshot-v1', requestId,
        profileId: this.profileId, runtimeGeneration: this.generation,
      },
    })
  }

  bundleRequest(
    snapshot: Pick<CordisXPluginBundleManagerSnapshotV1, 'revision' | 'pluginRevision'>,
    operation: CordisXPluginBundleLifecycleOperationV1,
  ): Promise<CordisXPluginBundleLifecycleResultV1> {
    const requestId = this.requestId()
    const request: CordisXPluginBundleLifecycleRequestV1 = {
      $schema: CORDISX_PLUGIN_BUNDLE_LIFECYCLE_OPERATION_SCHEMA_V1,
      schemaVersion: 1,
      requestId,
      profileId: this.profileId,
      expectedRevision: snapshot.revision,
      expectedPluginRevision: snapshot.pluginRevision,
      runtimeGeneration: this.generation,
      operation,
    }
    return this.send(requestId, {
      token: this.token,
      privateRequest: {
        kind: 'bundle-operation-v1', requestId,
        profileId: this.profileId, runtimeGeneration: this.generation,
        request,
      },
    })
  }

  permissionReviewPlanV2(
    expectedRevision: number,
    target: { readonly kind: 'candidate'; readonly candidateId: string } | { readonly kind: 'enable'; readonly pluginId: string },
  ): Promise<CordisXPermissionAuthorizationPlanV2 | undefined> {
    const requestId = this.requestId()
    return this.send(requestId, {
      token: this.token,
      privateRequest: {
        kind: 'permission-review-plan-v2',
        requestId,
        profileId: this.profileId,
        runtimeGeneration: this.generation,
        expectedRevision,
        target,
      },
    })
  }

  applyPermissionReviewV2(
    expectedRevision: number,
    decision: CordisXPermissionAuthorizationDecisionV2,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const requestId = this.requestId()
    return this.send(requestId, {
      token: this.token,
      privateRequest: {
        kind: 'permission-review-apply-v2',
        requestId,
        profileId: this.profileId,
        runtimeGeneration: this.generation,
        expectedRevision,
        decision,
      },
    })
  }

  permissionReviewPlanV4(
    expectedRevision: number,
    target: { readonly kind: 'candidate'; readonly candidateId: string } | { readonly kind: 'enable'; readonly pluginId: string },
  ): Promise<CordisXPermissionAuthorizationPlanV4 | undefined> {
    const requestId = this.requestId()
    return this.send(requestId, {
      token: this.token,
      privateRequest: {
        kind: 'permission-review-plan-v4',
        requestId,
        profileId: this.profileId,
        runtimeGeneration: this.generation,
        expectedRevision,
        target,
      },
    })
  }

  applyPermissionReviewV4(
    expectedRevision: number,
    decision: CordisXPermissionAuthorizationDecisionV4,
  ): Promise<CordisXPluginLifecycleResultV1> {
    const requestId = this.requestId()
    return this.send(requestId, {
      token: this.token,
      privateRequest: {
        kind: 'permission-review-apply-v4',
        requestId,
        profileId: this.profileId,
        runtimeGeneration: this.generation,
        expectedRevision,
        decision,
      },
    })
  }

  private requestId(): string {
    return typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  }

  private send<Value>(requestId: string, envelope: object): Promise<Value> {
    if (this.disposed) return Promise.reject(new Error('plugin lifecycle bridge is disposed'))
    const binding = window[BINDING]
    if (typeof binding !== 'function') return Promise.reject(new Error('plugin lifecycle operations are unavailable'))
    return new Promise<Value>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new Error('plugin lifecycle request timed out'))
      }, 60_000)
      this.pending.set(requestId, { resolve: value => resolve(value as Value), reject, timer })
      try {
        binding(JSON.stringify(envelope))
      } catch (error) {
        this.pending.delete(requestId)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    if (window[RECEIVER] !== undefined) delete window[RECEIVER]
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('plugin lifecycle bridge is disposed'))
    }
    this.pending.clear()
  }

  private receive(payload: string): void {
    let response: { readonly requestId?: unknown; readonly ok?: unknown; readonly value?: unknown; readonly error?: unknown }
    try { response = JSON.parse(payload) as typeof response } catch { return }
    if (typeof response.requestId !== 'string') return
    const pending = this.pending.get(response.requestId)
    if (pending === undefined) return
    this.pending.delete(response.requestId)
    clearTimeout(pending.timer)
    if (response.ok === true) pending.resolve(response.value)
    else pending.reject(new Error(typeof response.error === 'string' ? response.error : 'plugin lifecycle request failed'))
  }
}
