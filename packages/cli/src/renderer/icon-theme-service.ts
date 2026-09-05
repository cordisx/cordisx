import { type Context, Service } from '@deepseek-ai/cordis'
import type {
  CordisXIconThemeProviderDefinitionV1,
  CordisXIconThemeRegistrationHandle,
  CordisXIconThemes,
} from '../icon-theme-contracts.js'
import { generationFromContext, ownerFromContext } from './ownership.js'
import { BUILTIN_REICON_PROVIDER_GENERATION, IconThemeRegistry } from './icon-theme-registry.js'

/** Cordis service exposes data registration only; provider execution is absent. */
export class CordisXIconThemeService extends Service implements CordisXIconThemes {
  private nextPrincipal = 1
  private nextRequest = 1
  private readonly principals = new Map<string, `ipp_${string}`>()

  constructor(ctx: Context, readonly registry: IconThemeRegistry) {
    super(ctx, 'iconThemes')
  }

  register(definition: CordisXIconThemeProviderDefinitionV1): CordisXIconThemeRegistrationHandle {
    const pluginId = ownerFromContext(this.ctx)
    const providerGeneration = generationFromContext(this.ctx)
    if (pluginId === 'host' || providerGeneration === undefined) {
      throw new Error('icon theme registration requires an owned plugin generation')
    }
    const principalKey = `${pluginId}\0${providerGeneration}`
    let principalHandle = this.principals.get(principalKey)
    if (principalHandle === undefined) {
      principalHandle = `ipp_${String(this.nextPrincipal++).padStart(20, '0')}`
      this.principals.set(principalKey, principalHandle)
    }
    const registered = this.registry.registerPlugin(
      `iconregister_${String(this.nextRequest++).padStart(16, '0')}`,
      this.registry.selection().profileRevision,
      this.registry.hostGeneration,
      { principalHandle, pluginId, providerGeneration },
      definition,
    )
    const registration = registered.registration
    if (registration === undefined) {
      throw new Error(`icon theme registration rejected: ${registered.result.error?.code ?? registered.result.outcome}`)
    }
    let live = true
    const dispose = (): void => {
      if (!live) return
      live = false
      let revision = this.registry.selection().profileRevision
      if (this.registry.selection().selectedProvider.providerHandle === registration.providerHandle) {
        const rollback = this.registry.rollback(
          `iconrollback_${String(this.nextRequest++).padStart(16, '0')}`,
          revision,
          this.registry.hostGeneration,
          registration.providerHandle,
          registration.providerGeneration,
          this.registry.builtinProviderHandle,
          BUILTIN_REICON_PROVIDER_GENERATION,
          'provider-unavailable',
        )
        if (rollback.outcome !== 'rolled-back') return
        revision = rollback.profileRevision
      }
      this.registry.disposeProvider(
        `icondispose_${String(this.nextRequest++).padStart(16, '0')}`,
        revision,
        this.registry.hostGeneration,
        registration.providerHandle,
        registration.providerGeneration,
      )
    }
    const handle = dispose as unknown as CordisXIconThemeRegistrationHandle
    handle.dispose = dispose
    Object.defineProperties(handle, {
      providerHandle: { value: registration.providerHandle, enumerable: true },
      providerGeneration: { value: registration.providerGeneration, enumerable: true },
      providerId: { value: registration.identity.providerId, enumerable: true },
    })
    this.ctx.effect(() => dispose, `iconThemes.register(${JSON.stringify(definition.namespace)})`)
    return handle
  }
}
