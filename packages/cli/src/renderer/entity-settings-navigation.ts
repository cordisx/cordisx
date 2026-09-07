import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentDefinitionIdentity } from '@cordisx/protocol/agents/v1'
import type {
  EntitySettingsAvailabilityResult,
  EntitySettingsNavigationRequest,
  EntitySettingsNavigationResult,
  EntitySettingsNavigationService,
} from '@cordisx/protocol/entity-settings-navigation/v1'
import type { HostManagerContentOpenRequest } from './manager/navigation-controller.js'
import type { PluginConsoleAspect } from './plugin-console.js'
import { publicNavigationCallerActive } from './public-navigation-caller.js'

interface Options {
  readonly console?: PluginConsoleAspect
  readonly resolve: (identity: AgentDefinitionIdentity) => HostManagerContentOpenRequest | undefined
  readonly open: (target: HostManagerContentOpenRequest) => void
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function identityOf(value: unknown): AgentDefinitionIdentity | undefined {
  if (!object(value) || Object.keys(value).sort().join(',') !== 'identity' || !object(value.identity)) return undefined
  const identity = value.identity
  if (
    Object.keys(identity).sort().join(',') !== 'agentId,revision'
    || typeof identity.agentId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(identity.agentId)
    || typeof identity.revision !== 'string' || [...identity.revision].length < 1 || [...identity.revision].length > 512
  ) return undefined
  return Object.freeze({ agentId: identity.agentId, revision: identity.revision })
}

/** Public exact-definition navigation backed by the existing private Manager authority. */
export class CordisXEntitySettingsNavigationService extends Service implements EntitySettingsNavigationService {
  private readonly lifetime = { active: true }
  constructor(ctx: Context, private readonly options: Options) {
    super(ctx, 'entitySettingsNavigation')
    ctx.effect(() => () => {
      this.lifetime.active = false
    }, 'entity-settings-navigation')
  }
  private resolve(request: EntitySettingsNavigationRequest):
    | { readonly target: HostManagerContentOpenRequest }
    | Exclude<EntitySettingsAvailabilityResult, { status: 'available' }>
  {
    if (!this.lifetime.active) return { status: 'unavailable', code: 'host-unavailable' }
    if (!publicNavigationCallerActive(this.ctx, this.options.console)) {
      return { status: 'unavailable', code: 'caller-unavailable' }
    }
    const identity = identityOf(request)
    if (identity === undefined) return { status: 'unavailable', code: 'invalid-identity' }
    const target = this.options.resolve(identity)
    if (!publicNavigationCallerActive(this.ctx, this.options.console)) {
      return { status: 'unavailable', code: 'caller-unavailable' }
    }
    return target === undefined ? { status: 'unavailable', code: 'target-unavailable' } : { target }
  }
  async get(request: EntitySettingsNavigationRequest): Promise<EntitySettingsAvailabilityResult> {
    try {
      const result = this.resolve(request)
      return 'target' in result ? { status: 'available' } : result
    } catch {
      return { status: 'unavailable', code: 'target-unavailable' }
    }
  }
  async open(request: EntitySettingsNavigationRequest): Promise<EntitySettingsNavigationResult> {
    try {
      const result = this.resolve(request)
      if (!('target' in result)) return result
      this.options.open(result.target)
      return { status: 'accepted', code: 'opened' }
    } catch {
      return { status: 'unavailable', code: 'target-unavailable' }
    }
  }
}
