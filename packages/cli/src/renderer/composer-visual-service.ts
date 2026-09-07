import { Context, Service } from '@deepseek-ai/cordis'
import type {
  CordisXExtensionPointVisuals,
  CordisXReactVisual,
  CordisXVisualRegistration,
} from '../extension-point-visual-contracts.js'
import { ComposerVisualRuntime } from './composer-visual-runtime.js'
import { generationFromContext, ownerFromContext, qualifyOwnedId, sourceFromContext } from './ownership.js'
import type { SurfaceRegistry } from './surface-registry.js'
import type { PermissionBroker } from './platform/platform-permission-broker.js'

export const COMPOSER_VISUAL_POINTS = ['composer.primary-action.visual', 'composer.frame.overlay'] as const
interface Options {
  readonly surfaces: SurfaceRegistry
  readonly broker: PermissionBroker
  readonly document: Document
}

/** Cordis-owned source/generation binding around the Host-private DOM runtime. */
export class CordisXExtensionPointVisualService extends Service implements CordisXExtensionPointVisuals {
  private readonly state: { runtime?: ComposerVisualRuntime } = {}
  constructor(ctx: Context, private readonly options: Options) {
    super(ctx, 'extensionPointVisuals')
    ctx.effect(() => () => {
      this.state.runtime?.dispose()
      for (const surface of COMPOSER_VISUAL_POINTS) options.surfaces.clearRuntimeContext(surface)
    }, 'cordisx: composer visual runtime')
  }

  private runtimeFor(): ComposerVisualRuntime {
    if (this.state.runtime !== undefined) return this.state.runtime
    const options = this.options
    this.state.runtime = new ComposerVisualRuntime(options.document, available => {
      for (const surface of COMPOSER_VISUAL_POINTS) {
        options.surfaces.setRuntimeContext({
          surface,
          state: available ? 'active' : 'not-mounted',
        })
      }
    })
    return this.state.runtime
  }

  register(declaration: CordisXVisualRegistration, load: () => Promise<CordisXReactVisual>): () => void {
    const owner = ownerFromContext(this.ctx)
    const source = sourceFromContext(this.ctx)
    const generation = generationFromContext(this.ctx)
    if (source === undefined || generation === undefined) {
      throw new Error('Visual registration requires a bound plugin generation')
    }
    const identity = { id: owner, source }
    if (!this.options.broker.visualDeclarationSupported(identity, generation)) {
      throw new Error('Visual manifest or required interaction is unsupported')
    }
    return this.ctx.effect(() => {
      const surfaces = this.options.surfaces
      const qualifiedId = qualifyOwnedId(owner, declaration.id)
      const contribution = surfaces.register(this.ctx, {
        name: declaration.pointId,
        id: declaration.id,
        ...(declaration.order === undefined ? {} : { order: declaration.order }),
      }, {
        renderer: { id: declaration.id },
        ...(declaration.events === undefined ? {} : { events: declaration.events }),
      })
      const pointAllowed = (): boolean => {
        const item = surfaces.snapshot().find(item =>
          item.surface === declaration.pointId && item.qualifiedId === qualifiedId
        )
        return item?.visible === true && item.valid && !item.disabled && item.pointPolicy !== 'deny'
      }
      const authority = this.options.broker.visualAuthority(identity, generation, declaration.pointId, pointAllowed)
      let release: () => void
      try {
        release = this.runtimeFor().register(
          `${source}\u0000${owner}\u0000${generation}\u0000${declaration.id}`,
          declaration,
          load,
          {
            ...authority,
            subscribe: listener => {
              const a = authority.subscribe(listener)
              const b = surfaces.subscribe(listener)
              return () => {
                a()
                b()
              }
            },
            mounted: () => {
              const token = surfaces.renderToken(declaration.pointId, qualifiedId)
              if (token !== undefined) surfaces.markRendered(declaration.pointId, qualifiedId, token, true)
              return () => {
                if (token !== undefined) surfaces.markRendered(declaration.pointId, qualifiedId, token, false)
              }
            },
          },
        )
      } catch (error) {
        contribution.dispose()
        throw error
      }
      return () => {
        release()
        contribution.dispose()
        if (this.state.runtime?.inspect().registrations === 0) {
          this.state.runtime.dispose()
          delete this.state.runtime
          for (const surface of COMPOSER_VISUAL_POINTS) surfaces.clearRuntimeContext(surface)
        }
      }
    }, `extensionPointVisuals.register(${JSON.stringify(declaration.id)})`)
  }
}
