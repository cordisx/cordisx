import { sha256Hex } from '../../permission-model-v2.js'
import { PlatformAuthorizationBroker } from './platform-authorization.js'
import type { CordisXPluginIdentity } from '../../contracts.js'
import type {
  ExtensionPointInteractionCapabilityV1,
  ExtensionPointVisualIdV1,
} from '@cordisx/protocol/extension-point-visual/v1'
import type { ComposerVisualAuthority } from '../composer-visual-runtime.js'
import type { PlatformPermissionSnapshot, Registration } from './platform-permission-types.js'
import {
  VISUAL_PERMISSION_DECISION_SCHEMA_V5,
  visualInteractionPlan,
} from '../../extension-point-interaction-authorization.js'

function supportedInteractionEvent(point: string, event: string): boolean {
  return (point === 'composer.frame.overlay' && ['pointer.observe', 'drag', 'activate'].includes(event))
    || (point === 'composer.primary-action.visual' && event === 'pointer.observe')
}
function supportedDeclaration(
  declaration: ExtensionPointInteractionCapabilityV1,
): ExtensionPointInteractionCapabilityV1 {
  return {
    ...declaration,
    scope: {
      ...declaration.scope,
      events: declaration.scope.events.filter(event =>
        declaration.scope.extensionPoints.some(point => supportedInteractionEvent(point, event))
      ),
    },
  }
}

interface InteractionLease {
  state: 'pending' | 'allow' | 'deny'
  cancel(): void
}
/** Generation-scoped interaction leases; persistent policy is intentionally not offered yet. */
export abstract class PlatformVisualPermissionBroker extends PlatformAuthorizationBroker {
  private readonly developmentVisualIdentities = new Set<string>()
  /** Host composition only; pass identities from verified Launcher local-dev provenance. */
  enableDevelopmentVisualIdentity(identity: CordisXPluginIdentity): void {
    this.developmentVisualIdentities.add(JSON.stringify([identity.source, identity.id]))
  }
  private isDevelopmentVisual(identity: CordisXPluginIdentity): boolean {
    return this.developmentVisualIdentities.has(JSON.stringify([identity.source, identity.id]))
  }

  private visualReviewSequence = 0
  private visualReviewQueue: Promise<unknown> = Promise.resolve()
  private readonly visualInteractionLeases = new Map<object, InteractionLease>()

  visualDeclarationSupported(identity: CordisXPluginIdentity, generation: string): boolean {
    const current = [...this.registrations.values()].find(item =>
      item.identity.id === identity.id && item.identity.source === identity.source
      && item.generation.moduleGeneration === generation
    )
    if (
      current?.generation.moduleGeneration !== generation
      || (current.manifest.schemaVersion !== 10 && current.manifest.schemaVersion !== 11)
    ) return false
    return !current.manifest.capabilities.some(item =>
      item.name === 'ui.extension-points.interact'
      && item.required && item.scope.extensionPoints.some(point =>
        item.scope.events.some(event => !supportedInteractionEvent(point, event))
      )
    )
  }

  visualAuthority(
    identity: CordisXPluginIdentity,
    moduleGeneration: string,
    pointId: ExtensionPointVisualIdV1,
    pointAllowed: () => boolean,
  ): ComposerVisualAuthority {
    let renderRequested = false
    const registration = (): Registration | undefined => {
      const value = this.registration(identity)
      return value?.generation.moduleGeneration === moduleGeneration ? value : undefined
    }
    const render = (): boolean => {
      const current = registration()
      if (
        current === undefined || (current.manifest.schemaVersion !== 10 && current.manifest.schemaVersion !== 11)
        || !pointAllowed()
      ) return false
      const declared = [...current.manifest.capabilities].find(item => item.name === 'ui.extension-points.render')
      if (
        declared === undefined || !('extensionPoints' in declared.scope)
        || !declared.scope.extensionPoints?.includes(pointId)
      ) return false
      const access = this.domAccess(identity, pointId)
      if (this.isDevelopmentVisual(identity) && access.state !== 'denied') return true
      if (!access.authorized && access.state === 'pending' && !renderRequested) {
        renderRequested = true
        this.visualReviewQueue = this.visualReviewQueue.catch(() => {}).then(async () => {
          if (registration() === current && pointAllowed()) await this.requestDomAccess(identity, pointId)
        }).catch(() => {})
      }
      return access.authorized
    }
    const interact = (event: 'pointer.observe' | 'drag' | 'activate'): boolean => {
      if (!render()) return false
      const current = registration()!
      const declaration = (current.manifest.schemaVersion === 10 || current.manifest.schemaVersion === 11)
        ? [...current.manifest.capabilities].find((item): item is ExtensionPointInteractionCapabilityV1 =>
          item.name === 'ui.extension-points.interact'
        )
        : undefined
      if (
        declaration === undefined || !declaration.scope.extensionPoints.includes(pointId)
        || !supportedInteractionEvent(pointId, event)
        || !supportedDeclaration(declaration).scope.events.includes(event)
      ) return false
      let lease = this.visualInteractionLeases.get(current.token)
      if (lease === undefined) {
        lease = { state: this.isDevelopmentVisual(identity) ? 'allow' : 'pending', cancel() {} }
        this.visualInteractionLeases.set(current.token, lease)
        if (lease.state === 'allow') return true
        const selectedLease = lease
        this.visualReviewQueue = this.visualReviewQueue.catch(() => {}).then(async () => {
          if (
            registration() === current && this.visualInteractionLeases.get(current.token) === selectedLease
            && render()
          ) {
            await this.requestVisualInteraction(current, declaration, selectedLease)
          }
        })
      }
      return lease.state === 'allow'
    }
    return Object.freeze({
      render,
      observePointer: () => interact('pointer.observe'),
      drag: () => interact('drag'),
      activate: () => interact('activate'),
      subscribe: (listener: () => void) => {
        this.listeners.add(listener)
        return () => {
          this.listeners.delete(listener)
        }
      },
    })
  }

  setVisualInteractionPolicy(identity: CordisXPluginIdentity, allow: boolean): void {
    const current = this.registration(identity)
    if (current === undefined) return
    const old = this.visualInteractionLeases.get(current.token)
    old?.cancel()
    // "Allow" opens a new explicit review; it cannot silently mint a grant.
    if (allow) this.visualInteractionLeases.delete(current.token)
    else this.visualInteractionLeases.set(current.token, { state: 'deny', cancel() {} })
    this.changed()
  }

  private async requestVisualInteraction(
    registration: Registration,
    declaration: ExtensionPointInteractionCapabilityV1,
    lease: InteractionLease,
  ): Promise<void> {
    const operationId = `visual:${
      sha256Hex(JSON.stringify([
        this.generation,
        registration.generation.moduleGeneration,
        registration.identity.source,
        registration.identity.id,
        ++this.visualReviewSequence,
      ]))
    }`
    // Only implemented events enter a plan. Required unsupported interaction
    // is rejected by the visual service before activating a renderer.
    const plan = visualInteractionPlan({
      planId: operationId,
      operation: 'runtime',
      profileId: this.profileId,
      identity: { source: registration.identity.source, pluginId: registration.identity.id },
      catalogVersion: 'composer-visual-interaction-v1',
      binding: this.binding(registration, operationId, operationId),
    }, supportedDeclaration(declaration))
    let retired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel!: () => void
    const cancelled = new Promise<undefined>(resolve => {
      cancel = () => resolve(undefined)
    })
    lease.cancel = () => {
      retired = true
      cancel()
      this.promptV2?.cancelVisualV5?.(plan.planId, plan.binding)
    }
    try {
      const result = await Promise.race([
        this.promptV2?.requestVisualV5?.(plan, registration.identity) ?? Promise.resolve(undefined),
        cancelled,
        new Promise<undefined>(resolve => {
          timer = setTimeout(() => resolve(undefined), this.promptTimeoutMs)
        }),
      ])
      const item = result?.decisions[0]
      const expected = plan.declarations[0]!
      const valid = !retired && this.isRegistered(registration)
        && this.registration(registration.identity) === registration
        && this.visualInteractionLeases.get(registration.token) === lease
        && result?.$schema === VISUAL_PERMISSION_DECISION_SCHEMA_V5 && result.schemaVersion === 5
        && result.origin === 'explicit-user' && result.planId === plan.planId
        && result.profileId === plan.profileId && result.operation === plan.operation
        && JSON.stringify(result.identity) === JSON.stringify(plan.identity)
        && JSON.stringify(result.binding) === JSON.stringify(plan.binding)
        && result.decisions.length === 1 && item?.capability === expected.capability
        && item.securityFingerprint === expected.securityFingerprint
        && JSON.stringify(item.scope) === JSON.stringify(expected.scope)
      lease.state = valid && item?.decision === 'allow-once' ? 'allow' : 'deny'
    } catch {
      lease.state = 'deny'
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      this.promptV2?.cancelVisualV5?.(plan.planId, plan.binding)
      this.changed()
    }
  }

  protected visualPermissionSnapshots(): readonly PlatformPermissionSnapshot[] {
    return [...this.registrations.values()].flatMap(current => {
      if (
        this.registration(current.identity) !== current
        || (current.manifest.schemaVersion !== 10 && current.manifest.schemaVersion !== 11)
      ) return []
      const declaration = [...current.manifest.capabilities].find(item => item.name === 'ui.extension-points.interact')
      if (declaration === undefined) return []
      const plan = visualInteractionPlan({
        planId: 'visual-snapshot',
        operation: 'runtime',
        profileId: this.profileId,
        identity: { source: current.identity.source, pluginId: current.identity.id },
        catalogVersion: 'composer-visual-interaction-v1',
        binding: this.binding(current, 'visual-snapshot', 'visual-snapshot'),
      }, declaration)
      const item = plan.declarations[0]!
      const lease = this.visualInteractionLeases.get(current.token)
      return [{
        identity: current.identity,
        capability: 'ui.extension-points.interact' as const,
        required: declaration.required,
        scope: declaration.scope,
        reason: item.presentation.description,
        fingerprint: item.securityFingerprint,
        policy: lease?.state === 'allow'
          ? 'allow' as const
          : lease?.state === 'deny'
          ? 'deny' as const
          : 'ask' as const,
        denialCount: lease?.state === 'deny' ? 1 : 0,
        authorizationOrigin: 'explicit-user' as const,
        authorizationReason: 'Generation-scoped explicit interaction permission',
      }]
    })
  }

  protected override retireAdditionalPermissions(registration: Registration): void {
    this.visualInteractionLeases.get(registration.token)?.cancel()
    this.visualInteractionLeases.delete(registration.token)
  }

  protected disposeVisualInteractions(): void {
    for (const lease of this.visualInteractionLeases.values()) lease.cancel()
    this.visualInteractionLeases.clear()
  }
}
