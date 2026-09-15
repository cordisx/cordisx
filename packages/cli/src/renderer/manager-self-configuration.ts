import type { CordisXManagerOpenResult, CordisXManagerService } from '@cordisx/protocol/manager-self-configuration/v1'
import { Context, Service } from '@deepseek-ai/cordis'
import type { PluginConsoleAspect } from './plugin-console.js'
import { publicNavigationCallerActive } from './public-navigation-caller.js'
import { generationFromContext, ownerFromContext } from './ownership.js'

export interface ManagerSelfConfigurationOptions {
  readonly console?: PluginConsoleAspect
  readonly resolve: (owner: string) => boolean
  readonly open: (owner: string) => void
}

/** Public owner-derived configuration navigation backed by the Host Manager. */
export class CordisXManagerSelfConfigurationService extends Service implements CordisXManagerService {
  private readonly lifetime = { active: true }

  constructor(ctx: Context, private readonly options: ManagerSelfConfigurationOptions) {
    super(ctx, 'manager')
    ctx.effect(() => () => {
      this.lifetime.active = false
    }, 'manager-self-configuration')
  }

  async openOwnPluginConfiguration(): Promise<CordisXManagerOpenResult> {
    try {
      const owner = ownerFromContext(this.ctx)
      const generation = generationFromContext(this.ctx)
      if (
        !this.lifetime.active || owner === 'host' || generation === undefined
        || !publicNavigationCallerActive(this.ctx, this.options.console)
      ) return 'unavailable'
      if (!this.options.resolve(owner)) return 'unavailable'
      if (
        !this.lifetime.active || ownerFromContext(this.ctx) !== owner || generationFromContext(this.ctx) !== generation
        || !publicNavigationCallerActive(this.ctx, this.options.console)
      ) return 'unavailable'
      this.options.open(owner)
      return 'opened'
    } catch {
      return 'unavailable'
    }
  }
}
