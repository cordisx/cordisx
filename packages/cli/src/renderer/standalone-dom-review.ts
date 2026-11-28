import type { CordisXPluginIdentity } from '../contracts.js'
import { isNativeManagerDomTarget, isStandaloneManagerDomTarget } from '../standalone-permission-contract.js'
import { consumeStandaloneDomReset } from './standalone-dom-reset-button.js'
import type {
  CordisXPermissionAuthorizationBindingV2,
  CordisXPermissionAuthorizationDecisionV3,
  CordisXPermissionAuthorizationPlanV3,
} from '../permission-contracts.js'
import {
  BrowserPermissionAuthorizationPromptV2,
  type PermissionAuthorizationPromptV2,
} from './platform/platform-permission-store.js'

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u
const reviews = new WeakMap<object, StandaloneDomReview>()

export function bindStandaloneDomReview(broker: object, review: StandaloneDomReview): void {
  if (reviews.has(broker)) throw new Error('standalone review already bound')
  reviews.set(broker, review)
}

export function standaloneDomReview(broker: object): StandaloneDomReview | undefined {
  return reviews.get(broker)
}

export interface StandaloneDomReviewContext {
  readonly identity: CordisXPluginIdentity
  readonly pointId: string
  readonly profileId: string
  readonly runtimeGeneration: string
  readonly moduleGeneration: string
  readonly artifact: { readonly version: string; readonly integrity: `sha256:${string}` }
  /** The owner explicitly supplies a persistent policy handoff for this graph. */
  readonly persistentEligible: boolean
  readonly isCurrent: () => boolean
  /** Checks the owner-bound renderer and its resources, without exposing its session token. */
  readonly verifyCurrent: () => Promise<boolean>
  /** Revoke this renderer's one-time grants when the owner fence is lost. */
  readonly invalidate: () => void
}

type ActiveReview = {
  readonly context: StandaloneDomReviewContext
  readonly prompt: PermissionAuthorizationPromptV2
  used: boolean
  allowed: boolean
  invalidated: boolean
}

/** A Host interaction reviews one owner-selected Manager UI point per tab. */
export class StandaloneDomReview implements PermissionAuthorizationPromptV2 {
  private active: ActiveReview | undefined
  private closed = false
  private persistentDecision:
    | ((
      context: StandaloneDomReviewContext,
      plan: CordisXPermissionAuthorizationPlanV3,
      decision: CordisXPermissionAuthorizationDecisionV3,
    ) => boolean)
    | undefined
  private persistentReset:
    | ((
      context: StandaloneDomReviewContext,
      observed: 'allow-persistent' | 'deny-persistent',
    ) => (() => void) | undefined)
    | undefined
  private onceDecision:
    | ((
      context: StandaloneDomReviewContext,
      plan: CordisXPermissionAuthorizationPlanV3,
      decision: CordisXPermissionAuthorizationDecisionV3,
    ) => Promise<boolean>)
    | undefined

  constructor(
    private readonly createPrompt: (context: StandaloneDomReviewContext) => PermissionAuthorizationPromptV2,
    private readonly targetAllowed = isStandaloneManagerDomTarget,
  ) {}

  isReviewing(): boolean {
    return this.active !== undefined
  }

  bindOnceDecision(callback: NonNullable<StandaloneDomReview['onceDecision']>): boolean {
    if (this.closed || this.active || this.onceDecision || typeof callback !== 'function') return false
    this.onceDecision = callback
    return true
  }

  /** Installed once by the standalone Host before any plugin is mounted. */
  bindPersistentDecision(callback: NonNullable<StandaloneDomReview['persistentDecision']>): boolean {
    if (this.closed || this.active || this.persistentDecision || typeof callback !== 'function') return false
    this.persistentDecision = callback
    return true
  }

  supportsPersistentDecision(context: StandaloneDomReviewContext): boolean {
    return !this.closed && context.persistentEligible
      && this.targetAllowed(context.identity, context.pointId) && this.persistentDecision !== undefined
  }

  bindPersistentReset(callback: NonNullable<StandaloneDomReview['persistentReset']>): boolean {
    if (this.closed || this.active || this.persistentReset || typeof callback !== 'function') return false
    this.persistentReset = callback
    return true
  }

  supportsPersistentReset(context: StandaloneDomReviewContext): boolean {
    return !this.closed && context.persistentEligible
      && this.targetAllowed(context.identity, context.pointId) && this.persistentReset !== undefined
  }

  private current(active: ActiveReview): boolean {
    try {
      return !this.closed && this.active === active && active.context.isCurrent()
    } catch {
      return false
    }
  }

  private async verified(active: ActiveReview): Promise<boolean> {
    if (!this.current(active)) {
      this.invalidate(active)
      return false
    }
    try {
      if (await active.context.verifyCurrent() && this.current(active)) return true
    } catch {
      /* a failed owner check must revoke the temporary grants */
    }
    this.invalidate(active)
    return false
  }

  private invalidate(active: ActiveReview): void {
    if (active.invalidated) return
    active.invalidated = true
    try {
      active.context.invalidate()
    } catch { /* an invalid session remains closed */ }
  }

  isDomLeaseVisible(identity: CordisXPluginIdentity, pointId: string, moduleGeneration?: string): boolean {
    const active = this.active
    return active === undefined || active.context.identity.id !== identity.id
      || active.context.identity.source !== identity.source || active.context.pointId !== pointId
      || active.context.moduleGeneration !== moduleGeneration
  }

  async review(context: StandaloneDomReviewContext, operation: () => Promise<boolean>): Promise<boolean> {
    if (
      this.closed || this.active || !this.targetAllowed(context.identity, context.pointId)
      || !ID.test(context.profileId)
      || !ID.test(context.runtimeGeneration) || !ID.test(context.moduleGeneration)
      || !context.artifact.version || context.artifact.version.length > 128
      || /[\u0000-\u001f\u007f]/u.test(context.artifact.version)
      || !/^sha256:[a-f0-9]{64}$/u.test(context.artifact.integrity)
    ) return false
    const captured: StandaloneDomReviewContext = Object.freeze({
      ...context,
      identity: Object.freeze({ ...context.identity }),
      artifact: Object.freeze({ ...context.artifact }),
    })
    let prompt: PermissionAuthorizationPromptV2
    try {
      prompt = this.createPrompt(captured)
    } catch {
      return false
    }
    const active: ActiveReview = { context: captured, prompt, used: false, allowed: false, invalidated: false }
    this.active = active
    try {
      if (!await this.verified(active)) return false
      const result = await operation()
      const current = await this.verified(active)
      return result && active.used && active.allowed && current
    } catch {
      this.invalidate(active)
      return false
    } finally {
      if (this.active === active) this.active = undefined
      try {
        prompt.dispose?.()
      } catch { /* cleanup cannot turn a review into an authorization */ }
    }
  }

  /** Reset a persisted decision only after a trusted click on the Host-owned control. */
  async reset(
    context: StandaloneDomReviewContext,
    observed: 'allow-persistent' | 'deny-persistent',
    event: Event,
    policyCurrent: () => boolean,
    operation: () => Promise<boolean>,
  ): Promise<boolean> {
    if (
      !this.supportsPersistentReset(context) || observed !== 'allow-persistent' && observed !== 'deny-persistent'
      || !consumeStandaloneDomReset(event, context.identity, context.pointId)
    ) return false
    return await this.review(context, async () => {
      const active = this.active
      if (!active || !this.current(active) || !policyCurrent()) return false
      const cancel = this.persistentReset?.(active.context, observed)
      if (!cancel) return false
      active.used = true
      active.allowed = true
      try {
        return await operation()
      } finally {
        cancel()
      }
    })
  }

  async request(): Promise<undefined> {
    return undefined
  }

  async requestV3(
    plan: CordisXPermissionAuthorizationPlanV3,
    identity: CordisXPluginIdentity,
  ): Promise<CordisXPermissionAuthorizationDecisionV3 | undefined> {
    const active = this.active
    const item = plan.declarations[0]
    if (
      !active || active.used || !this.current(active) || !active.prompt.requestV3 || plan.schemaVersion !== 3
      || plan.operation !== 'runtime' || plan.profileId !== active.context.profileId
      || identity.id !== active.context.identity.id || identity.source !== active.context.identity.source
      || plan.identity.pluginId !== identity.id || plan.identity.source !== identity.source
      || plan.binding.runtimeGeneration !== active.context.runtimeGeneration
      || plan.binding.moduleGeneration !== active.context.moduleGeneration
      || plan.declarations.length !== 1 || !item || item.capability !== 'ui.extension-points.render'
      || item.policy !== 'ask' || item.authorizationMode !== 'explicit-user' || !item.decisionRequired
      || Object.keys(item.scope).some(key => key !== 'extensionPoints')
      || item.scope.extensionPoints?.length !== 1 || item.scope.extensionPoints[0] !== active.context.pointId
      || !item.allowedDecisions.includes('allow-once') || !item.allowedDecisions.includes('deny-once')
    ) return undefined
    active.used = true
    const persistent = this.supportsPersistentDecision(active.context)
    const allowedDecisions = [
      'deny-once' as const,
      'allow-once' as const,
      ...(persistent
        ? item.allowedDecisions.filter(value => value === 'deny-persistent' || value === 'allow-persistent')
        : []),
    ]
    const restricted: CordisXPermissionAuthorizationPlanV3 = {
      ...plan,
      declarations: [{
        ...item,
        persistentAllow: persistent && item.persistentAllow,
        persistentDeny: persistent && item.persistentDeny,
        allowedDecisions,
        defaultDecision: 'deny-once',
      }],
    }
    const decision = await active.prompt.requestV3(restricted, identity)
    if (
      !decision || decision.decisions.length !== 1
      || !allowedDecisions.includes(decision.decisions[0]!.decision)
      || !await this.verified(active)
    ) return undefined
    const selected = decision.decisions[0]!.decision
    if (
      (selected === 'allow-once' || selected === 'deny-once') && this.onceDecision
      && (!await this.onceDecision(active.context, plan, decision) || !await this.verified(active))
    ) return undefined
    if (
      (selected === 'allow-persistent' || selected === 'deny-persistent')
      && this.persistentDecision?.(active.context, plan, decision) !== true
    ) return undefined
    active.allowed = selected === 'allow-once' || selected === 'allow-persistent'
    return decision
  }

  cancelV3(planId: string, binding: CordisXPermissionAuthorizationBindingV2): void {
    this.active?.prompt.cancelV3?.(planId, binding)
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    try {
      this.active?.prompt.dispose?.()
    } catch { /* closing still invalidates the review */ }
    this.active = undefined
    this.persistentDecision = undefined
    this.persistentReset = undefined
    this.onceDecision = undefined
  }
}

/** Use the existing Host dialog with same-origin styles and user-originated decisions. */
export function createStandaloneDomReview(document: Document, native = false): StandaloneDomReview {
  return new StandaloneDomReview(
    context =>
      new BrowserPermissionAuthorizationPromptV2(document, (_plan, identity) => ({
        plugin: {
          name: `${identity.id === 'channel' ? 'Channel' : identity.id} ${context.artifact.version}`,
          source: `${identity.source} · ${context.artifact.integrity}`,
          trust: 'configured',
        },
        availability: {},
        resolve: message => message.fallback ?? `[[${message.namespace ?? 'permission'}:${message.key}]]`,
        scope: scope => scope.extensionPoints?.join(', ') ?? JSON.stringify(scope),
        requestSource: identity.source,
      }), { externalStyles: !native, requireTrustedEvents: true, hideManage: true }),
    native ? isNativeManagerDomTarget : isStandaloneManagerDomTarget,
  )
}
