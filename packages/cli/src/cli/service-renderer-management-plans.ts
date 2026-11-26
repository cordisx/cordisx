import { randomUUID } from 'node:crypto'
import type { PluginManagementRequest } from '../management/contracts.js'

type RestrictedInstalledIntent = Extract<
  PluginManagementRequest,
  { readonly kind: 'plugin-enable' | 'plugin-disable' | 'plugin-uninstall' }
>

export type RestrictedMarketplaceIntent =
  & Extract<PluginManagementRequest, { readonly kind: 'plugin-plan-marketplace' }>
  & {
    readonly sourceUrl: string
    readonly version: string
    readonly expectedCanonicalSource: string
    readonly expectedArtifactIntegrity: string
  }

export type RestrictedLifecycleIntent = RestrictedInstalledIntent | RestrictedMarketplaceIntent

export interface RestrictedLifecyclePlan {
  readonly intent: RestrictedLifecycleIntent
  readonly managementRevision: number
  readonly activationRevision: number
}

interface StoredPlan extends RestrictedLifecyclePlan {
  readonly ownerToken: string
}

const ownerTokenPattern = /^management-execution-[a-f0-9-]{36}$/u
const sessionTokenPattern = /^renderer-management-execution-[a-f0-9-]{36}$/u
const limit = 16

/** Owner-only plans belong to one renderer session and are consumed at most once. */
export class ServiceRendererManagementPlans {
  private readonly plans = new Map<string, StoredPlan>()
  private closed = false
  private cleanupFailed = false

  constructor(private readonly discardOwnerPlan: (token: string) => void) {}

  get available(): boolean {
    return !this.closed && !this.cleanupFailed
  }

  issue(ownerToken: string, plan: RestrictedLifecyclePlan): string | undefined {
    if (!ownerTokenPattern.test(ownerToken) || !this.available) return undefined
    if ([...this.plans.values()].some(value => value.ownerToken === ownerToken)) return undefined
    if (this.plans.size >= limit) {
      const oldest = this.plans.keys().next().value
      if (oldest !== undefined) this.discard(oldest)
    }
    const token = `renderer-management-execution-${randomUUID()}`
    this.plans.set(token, { ...structuredClone(plan), ownerToken })
    return token
  }

  peek(token: string): StoredPlan | undefined {
    return this.available ? this.plans.get(token) : undefined
  }

  take(token: string): StoredPlan | undefined {
    const plan = this.peek(token)
    if (plan) this.plans.delete(token)
    return plan
  }

  discard(token: string): void {
    const plan = this.plans.get(token)
    this.plans.delete(token)
    if (plan) this.discardOwner(plan.ownerToken)
  }

  discardOwner(token: string): void {
    if (!ownerTokenPattern.test(token)) return
    try {
      this.discardOwnerPlan(token)
    } catch (error) {
      this.cleanupFailed = true
      throw error
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const plans = [...this.plans.values()]
    this.plans.clear()
    for (const plan of plans) {
      try {
        this.discardOwner(plan.ownerToken)
      } catch { /* Every remaining owner plan still needs cleanup. */ }
    }
    if (this.cleanupFailed) throw new Error('renderer-management-plan-cleanup-unavailable')
  }
}

/** A Marketplace selection contains catalog identity, never an arbitrary artifact or candidate. */
export function restrictedLifecycleIntent(value: unknown): RestrictedLifecycleIntent | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (item.kind === 'plugin-plan-marketplace') {
    const keys = ['kind', 'pluginId', 'sourceUrl', 'version', 'expectedCanonicalSource', 'expectedArtifactIntegrity']
    if (
      Object.keys(item).length !== keys.length || Object.keys(item).some(key => !keys.includes(key))
      || typeof item.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(item.pluginId)
      || typeof item.sourceUrl !== 'string' || item.sourceUrl.length > 2048
      || typeof item.version !== 'string' || !/^[^\u0000-\u0020\u007f]{1,128}$/u.test(item.version)
      || typeof item.expectedCanonicalSource !== 'string' || item.expectedCanonicalSource.length > 2048
      || typeof item.expectedArtifactIntegrity !== 'string'
      || !/^sha256:[a-f0-9]{64}$/u.test(item.expectedArtifactIntegrity)
    ) return undefined
    try {
      const source = new URL(item.sourceUrl)
      const canonical = new URL(item.expectedCanonicalSource)
      if (
        !['http:', 'https:'].includes(source.protocol) || source.username || source.password || source.hash
        || canonical.protocol !== 'https:' || canonical.username || canonical.password || canonical.search
        || canonical.hash
      ) return undefined
    } catch {
      return undefined
    }
    return item as unknown as RestrictedMarketplaceIntent
  }
  if (
    Object.keys(item).length !== 2 || Object.keys(item).some(key => !['kind', 'pluginId'].includes(key))
    || !['plugin-enable', 'plugin-disable', 'plugin-uninstall'].includes(String(item.kind))
    || typeof item.pluginId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/u.test(item.pluginId)
  ) return undefined
  return { kind: item.kind, pluginId: item.pluginId } as RestrictedInstalledIntent
}

export function restrictedExecutionToken(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  return Object.keys(item).length === 2 && item.kind === 'plugin-execute-plan'
      && typeof item.executionToken === 'string' && sessionTokenPattern.test(item.executionToken)
    ? item.executionToken
    : undefined
}

export function ownerExecutionToken(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  return Object.keys(item).length === 2 && item.kind === 'plugin-execute-plan'
      && typeof item.executionToken === 'string' && ownerTokenPattern.test(item.executionToken)
    ? item.executionToken
    : undefined
}

/** Never fall through to a legacy unscoped path for a malformed session token. */
export function hasSessionExecutionToken(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const item = value as Record<string, unknown>
  return item.kind === 'plugin-execute-plan' && typeof item.executionToken === 'string'
    && item.executionToken.startsWith('renderer-management-execution-')
}
