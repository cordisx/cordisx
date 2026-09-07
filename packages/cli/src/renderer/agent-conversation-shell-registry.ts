import { Context, Service } from '@deepseek-ai/cordis'
import type { AgentConversationShellBindRequest } from '@cordisx/protocol/agent-conversation-shell/v1'
import type {
  CordisXAgentConversationShell,
  CordisXAgentConversationShellRegistration,
  CordisXAgentConversationShellSourceFactory,
  CordisXAgentConversationShellSourceFactoryV10,
  CordisXAgentConversationShellSourceFactoryV2,
  CordisXAgentConversationShellSourceFactoryV3,
  CordisXAgentConversationShellSourceFactoryV4,
  CordisXAgentConversationShellSourceFactoryV5,
  CordisXAgentConversationShellSourceFactoryV6,
  CordisXAgentConversationShellSourceFactoryV7,
  CordisXAgentConversationShellSourceFactoryV8,
  CordisXAgentConversationShellSourceFactoryV9,
  CordisXAgentConversationShellSourceOptionsV9,
  CordisXPageMount,
} from '../contracts.js'
import { markAgentConversationPageMount } from './agent-conversation-page.js'
import type { CordisXCommandService } from './commands.js'
import {
  type GenerationVisibilityCoordinator,
  generationVisibilityFromContext,
  type PluginGenerationEffectIdentity,
} from './generation-visibility.js'
import type { AgentConversationRendererProps } from './host-ui/conversation/AgentConversationRenderer.js'
import type { CordisXI18nService } from './i18n.js'
import { ownerFromContext } from './ownership.js'
import type { PluginConsoleAspect, PluginPrincipalToken } from './plugin-console.js'
import type { PlaygroundScenarioConversationSourceAuthority } from './playground-scenario-session-scope.js'
import type { SelectedNavigationActionRegistry } from './selected-navigation-actions.js'
import { immutableSnapshot } from './validation.js'
import { BoundSourceHost, type RegisteredSource } from './agent-conversation-shell-base.js'
import { MountedConversation } from './agent-conversation-shell-mounted.js'
import { encodedGeneration } from './agent-conversation-shell-projection.js'
import {
  exactKeys,
  plainObject,
  type PlaygroundScenarioConversationOwnerResolver,
} from './agent-conversation-shell-validation.js'

export class AgentConversationShellRegistry {
  private readonly records = new Set<RegisteredSource>()
  private readonly disconnectVisibility: (() => void) | undefined
  private nextRequest = 1
  private nextBinding = 1
  private disposed = false

  constructor(
    private readonly commands: CordisXCommandService,
    private readonly i18n: CordisXI18nService,
    private readonly visibility?: GenerationVisibilityCoordinator,
    private readonly console?: PluginConsoleAspect,
    private readonly identity?: AgentConversationRendererProps['identity'],
    private readonly scenarioSource?: PlaygroundScenarioConversationSourceAuthority,
    private readonly scenarioOwner?: PlaygroundScenarioConversationOwnerResolver,
    private readonly selectedNavigationActions?: SelectedNavigationActionRegistry,
  ) {
    this.disconnectVisibility = visibility?.connect({
      notify: () => {
        for (const record of [...this.records]) {
          if (!visibility.visible(record.effect)) this.disposeRecord(record)
        }
      },
    })
  }

  register(
    ctx: Context,
    factory:
      | CordisXAgentConversationShellSourceFactory
      | CordisXAgentConversationShellSourceFactoryV2
      | CordisXAgentConversationShellSourceFactoryV3
      | CordisXAgentConversationShellSourceFactoryV4
      | CordisXAgentConversationShellSourceFactoryV5
      | CordisXAgentConversationShellSourceFactoryV6
      | CordisXAgentConversationShellSourceFactoryV7
      | CordisXAgentConversationShellSourceFactoryV8
      | CordisXAgentConversationShellSourceFactoryV9
      | CordisXAgentConversationShellSourceFactoryV10,
    principal?: PluginPrincipalToken,
    version: 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 = 3,
    options?: CordisXAgentConversationShellSourceOptionsV9,
  ): CordisXAgentConversationShellRegistration {
    if (this.disposed) throw new Error('Agent conversation shell registry is disposed')
    if (typeof factory !== 'function') throw new Error('Agent conversation shell source factory must be a function')
    const owner = ownerFromContext(ctx)
    const effect: PluginGenerationEffectIdentity = this.visibility?.effect(ctx) ?? Object.freeze({ pluginId: owner })
    if (
      [...this.records].some(record =>
        record.owner === owner && record.version === version
        && record.effect.moduleGeneration === effect.moduleGeneration
      )
    ) {
      throw new Error(`Agent conversation Shell v${version} source is already registered for ${owner}`)
    }
    const rawGeneration = effect.moduleGeneration ?? owner
    const record: RegisteredSource = {
      version,
      owner,
      ownerGeneration: encodedGeneration(rawGeneration),
      effect,
      factory,
      ...(principal === undefined ? {} : { principal }),
      ...(options?.composer?.mode === undefined ? {} : { composerMode: options.composer.mode }),
      sessions: new Set(),
      active: true,
    }
    this.records.add(record)
    const host = new BoundSourceHost(record, () => `binding-${this.nextBinding++}`)
    const mount: CordisXPageMount = markAgentConversationPageMount(mountContext => {
      if (!record.active || this.visibility?.visible(record.effect) === false) {
        throw new Error('Agent conversation shell source generation is unavailable')
      }
      const selected = mountContext.params.roomId
      const request: AgentConversationShellBindRequest = immutableSnapshot({
        requestId: `request-${this.nextRequest++}`,
        ownerGeneration: record.ownerGeneration,
        routeSelection: {
          scope: 'room-or-new',
          ...(typeof selected === 'string' && selected !== '' ? { selectedRoomParam: selected } : {}),
        },
      })
      let mounted = true
      const result = host.bindNow(request)
      let session: MountedConversation | undefined
      if (result.status === 'accepted' && mounted && record.active) {
        const roomId = mountContext.params.roomId
        const routeId = mountContext.routeDefinitionId
        const scenarioOwner = this.scenarioOwner?.(record.owner, record.effect.moduleGeneration)
        if (
          scenarioOwner !== undefined && typeof roomId === 'string' && roomId !== ''
          && typeof routeId === 'string' && routeId !== ''
        ) {
          // A v6 continuation can be claimed only here, while the Host owns
          // the newly issued binding and the exact local Room route records.
          this.scenarioSource?.claimBootstrapRoute({
            owner: scenarioOwner,
            binding: Object.freeze({
              binding: Object.freeze({
                bindingId: result.binding.bindingId,
                ownerGeneration: result.binding.ownerGeneration,
              }),
              generation: record.effect.moduleGeneration ?? record.ownerGeneration,
              route: Object.freeze({ routeId, param: 'roomId' as const, roomId }),
            }),
            active: () => mounted && record.active && !mountContext.signal.aborted,
          })
        }
        session = new MountedConversation(
          record,
          result.binding,
          mountContext,
          this.commands,
          this.i18n,
          this.console,
          this.identity,
          this.selectedNavigationActions,
          this.scenarioSource,
          this.scenarioOwner,
        )
        record.sessions.add(session)
        session.start()
      }
      return () => {
        mounted = false
        session?.dispose()
      }
    })
    let active = true
    return {
      mount,
      dispose: () => {
        if (!active) return
        active = false
        this.disposeRecord(record)
      },
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.disconnectVisibility?.()
    for (const record of [...this.records]) this.disposeRecord(record)
  }

  private disposeRecord(record: RegisteredSource): void {
    if (!record.active) return
    record.active = false
    this.records.delete(record)
    for (const session of [...record.sessions]) session.dispose()
  }
}

export interface CordisXAgentConversationShellServiceOptions {
  readonly registry?: AgentConversationShellRegistry
  readonly console?: PluginConsoleAspect
  readonly identity?: AgentConversationRendererProps['identity']
  readonly selectedNavigationActions?: SelectedNavigationActionRegistry
  readonly scenarioSource?: PlaygroundScenarioConversationSourceAuthority
  readonly scenarioOwner?: PlaygroundScenarioConversationOwnerResolver
}

/** Fiber-aware public service; the renderer and binding authority stay Host-owned. */
export class CordisXAgentConversationShellService extends Service implements CordisXAgentConversationShell {
  static readonly inject = ['commands', 'i18n']
  private readonly registry: AgentConversationShellRegistry
  private readonly console: PluginConsoleAspect | undefined

  constructor(ctx: Context, options: CordisXAgentConversationShellServiceOptions = {}) {
    super(ctx, 'agentConversationShell')
    this.console = options.console
    this.registry = options.registry ?? new AgentConversationShellRegistry(
      ctx.commands as CordisXCommandService,
      ctx.i18n as CordisXI18nService,
      generationVisibilityFromContext(ctx),
      options.console,
      options.identity,
      options.scenarioSource,
      options.scenarioOwner,
      options.selectedNavigationActions,
    )
    ctx.effect(() => () => this.registry.dispose(), 'cordisx: Agent conversation shell registry')
  }

  registerSource(
    factory:
      | CordisXAgentConversationShellSourceFactory
      | CordisXAgentConversationShellSourceFactoryV2
      | CordisXAgentConversationShellSourceFactoryV3,
  ): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSource()')
    if (registration === undefined) throw new Error('Agent conversation shell source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }

  registerSourceV4(factory: CordisXAgentConversationShellSourceFactoryV4): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 4)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV4()')
    if (registration === undefined) throw new Error('Agent conversation Shell v4 source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }

  registerSourceV5(factory: CordisXAgentConversationShellSourceFactoryV5): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 5)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV5()')
    if (registration === undefined) throw new Error('Agent conversation Shell v5 source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }

  registerSourceV6(factory: CordisXAgentConversationShellSourceFactoryV6): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 6)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV6()')
    if (registration === undefined) throw new Error('Agent conversation Shell v6 source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }

  registerSourceV7(factory: CordisXAgentConversationShellSourceFactoryV7): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 7)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV7()')
    if (registration === undefined) throw new Error('Agent conversation Shell v7 source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }

  registerSourceV8(factory: CordisXAgentConversationShellSourceFactoryV8): CordisXAgentConversationShellRegistration {
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 8)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV8()')
    if (registration === undefined) throw new Error('Agent conversation Shell v8 source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }

  registerSourceV9(
    factory: CordisXAgentConversationShellSourceFactoryV9,
    options: CordisXAgentConversationShellSourceOptionsV9 = {},
  ): CordisXAgentConversationShellRegistration {
    plainObject(options, 'Agent conversation Shell v9 options')
    exactKeys(options, ['composer'], 'Agent conversation Shell v9 options')
    if (options.composer !== undefined) {
      plainObject(options.composer, 'Agent conversation Shell v9 composer options')
      exactKeys(options.composer, ['mode'], 'Agent conversation Shell v9 composer options')
      if (options.composer.mode !== 'page-composer-v2') {
        throw new Error('Agent conversation Shell v9 composer mode is invalid')
      }
    }
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 9, options)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV9()')
    if (registration === undefined) throw new Error('Agent conversation Shell v9 source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }

  registerSourceV10(
    factory: CordisXAgentConversationShellSourceFactoryV10,
    options: CordisXAgentConversationShellSourceOptionsV9 = {},
  ): CordisXAgentConversationShellRegistration {
    plainObject(options, 'Agent conversation Shell v10 options')
    exactKeys(options, ['composer'], 'Agent conversation Shell v10 options')
    if (options.composer !== undefined) {
      plainObject(options.composer, 'Agent conversation Shell v10 composer options')
      exactKeys(options.composer, ['mode'], 'Agent conversation Shell v10 composer options')
      if (options.composer.mode !== 'page-composer-v2') {
        throw new Error('Agent conversation Shell v10 composer mode is invalid')
      }
    }
    const principal = this.console?.tokenFromContext(this.ctx)
    let registration: CordisXAgentConversationShellRegistration | undefined
    const dispose = this.ctx.effect(() => {
      registration = this.registry.register(this.ctx, factory, principal, 10, options)
      return () => registration?.dispose()
    }, 'agentConversationShell.registerSourceV10()')
    if (registration === undefined) throw new Error('Agent conversation Shell v10 source registration failed')
    return {
      mount: registration.mount,
      dispose: () => {
        dispose()
      },
    }
  }
}
