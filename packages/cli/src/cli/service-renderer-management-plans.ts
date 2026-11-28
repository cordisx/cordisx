import { randomBytes, randomUUID } from 'node:crypto'
import type { PluginManagementRequest } from '../management/contracts.js'
import type { DeferredPermissionPlan } from '../permission-deferral.js'
import { PluginActivationStore } from '../launcher/plugin-activation.js'
import { loadServiceRendererPackage } from './service-renderer-projection.js'

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

export interface RestrictedPermissionReview extends RestrictedLifecyclePlan {
  readonly ownerPlan: DeferredPermissionPlan
  readonly rendererPlan: DeferredPermissionPlan
  readonly expires: number
}

const ownerTokenPattern = /^management-execution-[a-f0-9-]{36}$/u
const sessionTokenPattern = /^renderer-management-execution-[a-f0-9-]{36}$/u
const limit = 16

/** Owner-only plans belong to one renderer session and are consumed at most once. */
export class ServiceRendererManagementPlans {
  private readonly plans = new Map<string, StoredPlan>()
  private readonly reviews = new Map<string, RestrictedPermissionReview>()
  private closed = false
  private cleanupFailed = false

  constructor(
    private readonly discardOwnerPlan: (token: string) => void,
    private readonly reviewEnabled = false,
    private readonly verifyReviewCandidate: (plan: DeferredPermissionPlan, revision: number) => Promise<boolean> =
      async () => false,
  ) {}

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

  /** Keep candidate identity and authority inside this one admitted session. */
  async issueReview(input: RestrictedLifecyclePlan & { readonly ownerPlan: DeferredPermissionPlan }): Promise<
    {
      readonly token: string
      readonly plan: DeferredPermissionPlan
    } | undefined
  > {
    if (!this.available || !this.reviewEnabled || input.ownerPlan.schemaVersion !== 7) {
      return undefined
    }
    if (!await this.verifyReviewCandidate(input.ownerPlan, input.activationRevision) || !this.available) {
      return undefined
    }
    const now = Date.now()
    for (const [token, review] of this.reviews) if (review.expires < now) this.reviews.delete(token)
    if (this.reviews.size >= 4) this.reviews.delete(this.reviews.keys().next().value!)
    const token = `renderer-review-${randomUUID()}`
    const alias = `https://renderer.cordisx.invalid/plugin/${randomBytes(32).toString('hex')}`
    const rendererPlan: DeferredPermissionPlan = {
      ...structuredClone(input.ownerPlan),
      identity: { ...input.ownerPlan.identity, source: alias },
      binding: { ...input.ownerPlan.binding, requestId: token },
      declarations: input.ownerPlan.declarations.map(({ certification: _certification, ...item }) => item),
    }
    this.reviews.set(token, {
      intent: structuredClone(input.intent),
      managementRevision: input.managementRevision,
      activationRevision: input.activationRevision,
      ownerPlan: structuredClone(input.ownerPlan),
      rendererPlan,
      expires: now + 15 * 60_000,
    })
    return { token, plan: structuredClone(rendererPlan) }
  }

  peekReview(token: string): RestrictedPermissionReview | undefined {
    const review = this.available ? this.reviews.get(token) : undefined
    if (!review || review.expires < Date.now()) {
      this.reviews.delete(token)
      return undefined
    }
    return review
  }

  takeReview(token: string): RestrictedPermissionReview | undefined {
    const review = this.peekReview(token)
    if (review) this.reviews.delete(token)
    return review
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
    this.reviews.clear()
    for (const plan of plans) {
      try {
        this.discardOwner(plan.ownerToken)
      } catch { /* Every remaining owner plan still needs cleanup. */ }
    }
    if (this.cleanupFailed) throw new Error('renderer-management-plan-cleanup-unavailable')
  }
}

/** Issue restricted plans only when the owner has enabled the profile fence. */
export function createServiceRendererManagementPlans(input: {
  readonly homeDir: string
  readonly profileId: string
  readonly generation: string
  readonly protectProfileInputs?: boolean
  readonly restrictedManagement?: { readonly discardPlan: (token: string) => void }
  readonly permissionProof?: { readonly authorizeLifecycle?: unknown }
}): { readonly managementPlans?: ServiceRendererManagementPlans } {
  return input.protectProfileInputs && input.restrictedManagement
    ? {
      managementPlans: new ServiceRendererManagementPlans(
        input.restrictedManagement.discardPlan,
        typeof input.permissionProof?.authorizeLifecycle === 'function',
        async (plan, revision) => {
          try {
            if (
              !plan.binding.requestId || plan.profileId !== input.profileId
              || plan.binding.runtimeGeneration !== input.generation
            ) return false
            const candidate = await new PluginActivationStore(input.homeDir, input.profileId, input.generation)
              .loadCandidate(plan.binding.requestId)
            const item = candidate.plugins.find(plugin => plugin.id === plan.identity.pluginId)
            if (
              candidate.recordKind !== 'candidate' || candidate.transactionId !== plan.binding.requestId
              || candidate.profileId !== input.profileId || candidate.runtimeGeneration !== input.generation
              || candidate.lastGoodRevision !== revision || candidate.revision !== revision + 1
              || !item?.enabled || item.moduleGeneration !== plan.binding.moduleGeneration
            ) return false
            const staged = await loadServiceRendererPackage(input.homeDir, item)
            return staged.identitySource === plan.identity.source
          } catch {
            return false
          }
        },
      ),
    }
    : {}
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
