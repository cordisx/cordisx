import type {
  AgentConversationShellBinding,
  AgentConversationShellBindRequest,
  AgentConversationShellBindResult,
  AgentConversationShellHost,
  AgentConversationShellSubscription,
} from '@cordisx/protocol/agent-conversation-shell/v1'
import type {
  AgentConversationShellPage as AgentConversationShellPageV3,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV3,
  AgentConversationShellSource as AgentConversationShellSourceV3,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV3,
} from '@cordisx/protocol/agent-conversation-shell/v3'
import type {
  AgentConversationShellPage as AgentConversationShellPageV4,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV4,
  AgentConversationShellSource as AgentConversationShellSourceV4,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV4,
  AgentConversationShellSubscription as AgentConversationShellSubscriptionV4,
} from '@cordisx/protocol/agent-conversation-shell/v4'
import type {
  AgentConversationShellPage as AgentConversationShellPageV5,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV5,
  AgentConversationShellSource as AgentConversationShellSourceV5,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV5,
  AgentConversationShellSubscription as AgentConversationShellSubscriptionV5,
} from '@cordisx/protocol/agent-conversation-shell/v5'
import type {
  AgentConversationShellPage as AgentConversationShellPageV6,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV6,
  AgentConversationShellSource as AgentConversationShellSourceV6,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV6,
  AgentConversationShellSubscription as AgentConversationShellSubscriptionV6,
} from '@cordisx/protocol/agent-conversation-shell/v6'
import type {
  AgentConversationShellPage as AgentConversationShellPageV7,
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV7,
  AgentConversationShellSource as AgentConversationShellSourceV7,
  AgentConversationShellSubscribeRuntimeResult as AgentConversationShellSubscribeRuntimeResultV7,
  AgentConversationShellSubscription as AgentConversationShellSubscriptionV7,
} from '@cordisx/protocol/agent-conversation-shell/v7'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV8,
  AgentConversationShellSource as AgentConversationShellSourceV8,
} from '@cordisx/protocol/agent-conversation-shell/v8'
import type { AgentConversationShellSource as AgentConversationShellSourceV9 } from '@cordisx/protocol/agent-conversation-shell/v9'
import { createRoot, type Root } from 'react-dom/client'
import type {
  CordisXAgentConversationShellSourceFactory,
  CordisXAgentConversationShellSourceFactoryV2,
  CordisXAgentConversationShellSourceFactoryV3,
  CordisXAgentConversationShellSourceFactoryV4,
  CordisXAgentConversationShellSourceFactoryV5,
  CordisXAgentConversationShellSourceFactoryV6,
  CordisXAgentConversationShellSourceFactoryV7,
  CordisXAgentConversationShellSourceFactoryV8,
  CordisXAgentConversationShellSourceFactoryV9,
  CordisXPageMountContext,
} from '../contracts.js'
import type { CordisXCommandService } from './commands.js'
import type { PluginGenerationEffectIdentity } from './generation-visibility.js'
import type { AgentConversationRendererProps } from './host-ui/conversation/AgentConversationRenderer.js'
import type { CordisXI18nService } from './i18n.js'
import { HostThemeProjection } from './host-theme.js'
import type { PluginConsoleAspect, PluginPrincipalToken } from './plugin-console.js'
import type { PlaygroundScenarioConversationSourceAuthority } from './playground-scenario-session-scope.js'
import type { SelectedNavigationActionRegistry } from './selected-navigation-actions.js'
import { immutableSnapshot } from './validation.js'
import {
  type AgentConversationShellPage,
  type AgentConversationShellSnapshot,
  type AgentConversationShellSource,
  assertSnapshot,
  exactKeys,
  opaque,
  plainObject,
  type PlaygroundScenarioConversationOwnerResolver,
} from './agent-conversation-shell-validation.js'
import {
  assertSnapshotV4,
  assertSnapshotV5,
  assertSnapshotV6,
  assertSnapshotV7,
  assertSubscription,
  sameBinding,
  sameSubscription,
} from './agent-conversation-shell-validation-v4.js'
import {
  projectAgentConversationShellSnapshotV4,
  projectAgentConversationShellSnapshotV5,
  projectAgentConversationShellSnapshotV6,
  projectAgentConversationShellSnapshotV7,
  projectSnapshot,
} from './agent-conversation-shell-projection.js'

export interface RegisteredSource {
  readonly version: 3 | 4 | 5 | 6 | 7 | 8 | 9
  readonly owner: string
  readonly ownerGeneration: string
  readonly effect: PluginGenerationEffectIdentity
  readonly factory:
    | CordisXAgentConversationShellSourceFactory
    | CordisXAgentConversationShellSourceFactoryV2
    | CordisXAgentConversationShellSourceFactoryV3
    | CordisXAgentConversationShellSourceFactoryV4
    | CordisXAgentConversationShellSourceFactoryV5
    | CordisXAgentConversationShellSourceFactoryV6
    | CordisXAgentConversationShellSourceFactoryV7
    | CordisXAgentConversationShellSourceFactoryV8
    | CordisXAgentConversationShellSourceFactoryV9
  readonly principal?: PluginPrincipalToken
  readonly composerMode?: 'page-composer-v2'
  readonly sessions: Set<MountedConversationBase>
  active: boolean
}

export class BoundSourceHost implements AgentConversationShellHost {
  constructor(
    protected readonly record: RegisteredSource,
    protected readonly issueBindingId: () => string,
  ) {}

  bind(requestInput: AgentConversationShellBindRequest): Promise<AgentConversationShellBindResult> {
    return Promise.resolve(this.bindNow(requestInput))
  }

  /** The Host page mount needs the authenticated binding before navigation resolves. */
  bindNow(requestInput: AgentConversationShellBindRequest): AgentConversationShellBindResult {
    const request = immutableSnapshot(requestInput)
    plainObject(request, 'bind request')
    exactKeys(request, ['requestId', 'ownerGeneration', 'routeSelection'], 'bind request')
    opaque(request.requestId, 'bind request.requestId')
    opaque(request.ownerGeneration, 'bind request.ownerGeneration')
    plainObject(request.routeSelection, 'bind request.routeSelection')
    exactKeys(request.routeSelection, ['scope', 'selectedRoomParam'], 'bind request.routeSelection')
    if (request.routeSelection.scope !== 'room-or-new') throw new Error('bind request.routeSelection.scope is invalid')
    if (request.routeSelection.selectedRoomParam !== undefined) {
      opaque(request.routeSelection.selectedRoomParam, 'bind request.routeSelection.selectedRoomParam')
    }
    if (!this.record.active) return { type: 'bind', status: 'unavailable', code: 'disposed' }
    if (request.ownerGeneration !== this.record.ownerGeneration) {
      return { type: 'bind', status: 'unavailable', code: 'generation-replaced' }
    }
    const binding: AgentConversationShellBinding = immutableSnapshot({
      bindingId: this.issueBindingId(),
      shell: 'agent-desktop',
      ownerGeneration: this.record.ownerGeneration,
      routeSelection: request.routeSelection,
    })
    return { type: 'bind', status: 'accepted', code: 'allowed', binding }
  }
}

export abstract class MountedConversationBase {
  protected source:
    | AgentConversationShellSource
    | AgentConversationShellSourceV4
    | AgentConversationShellSourceV5
    | AgentConversationShellSourceV6
    | AgentConversationShellSourceV7
    | AgentConversationShellSourceV8
    | AgentConversationShellSourceV9
    | undefined
  protected subscription:
    | AgentConversationShellSubscription
    | AgentConversationShellSubscriptionV4
    | AgentConversationShellSubscriptionV5
    | AgentConversationShellSubscriptionV6
    | AgentConversationShellSubscriptionV7
    | undefined
  protected unsubscribe: (() => void | Promise<unknown>) | undefined
  protected snapshot:
    | AgentConversationShellSnapshot
    | AgentConversationShellSnapshotV4
    | AgentConversationShellSnapshotV5
    | AgentConversationShellSnapshotV6
    | AgentConversationShellSnapshotV7
    | AgentConversationShellSnapshotV8
    | undefined
  protected cursor = 0
  protected terminal = false
  protected disposed = false
  protected readonly root: Root
  protected readonly diagnosticSites = new Set<string>()
  protected readonly disconnectLocale: () => void
  protected readonly disconnectNavigationActions: () => void
  protected readonly detachTheme: () => void
  protected readonly previousOverflow: string
  protected readonly previousMinHeight: string

  constructor(
    protected readonly record: RegisteredSource,
    protected readonly binding: AgentConversationShellBinding,
    protected readonly mountContext: CordisXPageMountContext,
    protected readonly commands: CordisXCommandService,
    protected readonly i18n: CordisXI18nService,
    protected readonly console: PluginConsoleAspect | undefined,
    protected readonly identity: AgentConversationRendererProps['identity'],
    protected readonly selectedNavigationActions: SelectedNavigationActionRegistry | undefined,
    protected readonly scenarioSource: PlaygroundScenarioConversationSourceAuthority | undefined,
    protected readonly scenarioOwner: PlaygroundScenarioConversationOwnerResolver | undefined,
  ) {
    this.root = createRoot(mountContext.container)
    this.detachTheme = new HostThemeProjection(mountContext.document).attach(mountContext.container)
    this.previousOverflow = mountContext.container.style.overflow
    this.previousMinHeight = mountContext.container.style.minHeight
    mountContext.container.style.overflow = 'hidden'
    mountContext.container.style.minHeight = '0'
    this.disconnectLocale = i18n.subscribeInternal(() => this.render())
    this.disconnectNavigationActions = selectedNavigationActions?.subscribe(() => this.render()) ?? (() => {})
    this.renderStatus('loading')
  }

  start(): void {
    void this.initialize().catch(error => this.fail(error))
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.scenarioSource?.fenceBinding(this.binding.bindingId, 'route-replaced')
    this.disconnectLocale()
    this.disconnectNavigationActions()
    this.releaseSource()
    for (const site of this.diagnosticSites) this.i18n.clearDiagnosticSite(this.record.owner, site)
    this.diagnosticSites.clear()
    this.root.unmount()
    this.detachTheme()
    this.mountContext.container.style.overflow = this.previousOverflow
    this.mountContext.container.style.minHeight = this.previousMinHeight
    this.record.sessions.delete(this)
  }

  protected async initialize(): Promise<void> {
    const sourceCandidate = await this.runPlugin('agent-conversation-shell.source', () =>
      (
        this.record.factory as CordisXAgentConversationShellSourceFactoryV2
      )(this.binding as never))
    if (this.disposed) {
      sourceCandidate.dispose()
      return
    }
    if (
      sourceCandidate === null || typeof sourceCandidate !== 'object'
      || typeof sourceCandidate.snapshot !== 'function' || typeof sourceCandidate.subscribe !== 'function'
      || typeof sourceCandidate.dispose !== 'function'
    ) {
      throw new Error('conversation source must implement snapshot, subscribe, and dispose')
    }
    const source = sourceCandidate as unknown as
      | AgentConversationShellSource
      | AgentConversationShellSourceV4
      | AgentConversationShellSourceV5
      | AgentConversationShellSourceV6
      | AgentConversationShellSourceV7
      | AgentConversationShellSourceV8
      | AgentConversationShellSourceV9
    this.source = source
    const initial = immutableSnapshot(
      await this.runPlugin<unknown>('agent-conversation-shell.snapshot', () => source.snapshot()),
    )
    if (this.record.version >= 7) assertSnapshotV7(initial)
    else if (this.record.version === 6) assertSnapshotV6(initial)
    else if (this.record.version === 5) assertSnapshotV5(initial)
    else if (this.record.version === 4) assertSnapshotV4(initial)
    else assertSnapshot(initial)
    this.assertSnapshotFence(initial)
    if (this.record.version >= 7) {
      projectAgentConversationShellSnapshotV7(this.record.owner, initial as AgentConversationShellSnapshotV7, {
        resolve: message => message.fallback,
      })
    } else if (this.record.version === 6) {
      projectAgentConversationShellSnapshotV6(this.record.owner, initial as AgentConversationShellSnapshotV6, {
        resolve: message => message.fallback,
      })
    } else if (this.record.version === 5) {
      projectAgentConversationShellSnapshotV5(this.record.owner, initial as AgentConversationShellSnapshotV5, {
        resolve: message => message.fallback,
      })
    } else if (this.record.version === 4) {
      projectAgentConversationShellSnapshotV4(this.record.owner, initial as AgentConversationShellSnapshotV4, {
        resolve: message => message.fallback,
      })
    } else {projectSnapshot(this.record.owner, initial as AgentConversationShellSnapshot, {
        resolve: message => message.fallback,
      })}
    this.snapshot = initial
    this.cursor = initial.snapshotSequence
    const subscribed = await this.runPlugin<unknown>(
      'agent-conversation-shell.subscribe',
      () => source.subscribe(this.cursor),
    ) as
      | AgentConversationShellSubscribeRuntimeResultV3
      | AgentConversationShellSubscribeRuntimeResultV4
      | AgentConversationShellSubscribeRuntimeResultV5
      | AgentConversationShellSubscribeRuntimeResultV6
      | AgentConversationShellSubscribeRuntimeResultV7
    if (this.disposed) {
      if ('handle' in subscribed) subscribed.handle.unsubscribe()
      return
    }
    plainObject(subscribed, 'subscribe runtime result')
    plainObject(subscribed.result, 'subscribe result')
    if (subscribed.result.type !== 'subscribe') throw new Error('subscribe result type is invalid')
    if (subscribed.result.status !== 'accepted') {
      if ('handle' in subscribed) {
        const unexpected = subscribed.handle as unknown
        if (
          unexpected !== null && typeof unexpected === 'object'
          && typeof (unexpected as { unsubscribe?: unknown }).unsubscribe === 'function'
        ) {
          try {
            ;(unexpected as { unsubscribe(): void }).unsubscribe()
          } catch (error) {
            console.error('[cordisx] Agent conversation rejected runtime handle cleanup failed', error)
          }
        }
      }
      this.releaseSource()
      exactKeys(subscribed, ['result'], 'subscribe runtime result')
      exactKeys(subscribed.result, ['type', 'status', 'code'], 'subscribe result')
      if (subscribed.result.status !== 'denied' && subscribed.result.status !== 'unavailable') {
        throw new Error('subscribe result status is invalid')
      }
      if (subscribed.result.status === 'denied' && subscribed.result.code !== 'policy-denied') {
        throw new Error('denied subscribe result code is invalid')
      }
      if (
        subscribed.result.status === 'unavailable'
        && !['owner-unavailable', 'generation-replaced', 'disposed'].includes(subscribed.result.code)
      ) {
        throw new Error('unavailable subscribe result code is invalid')
      }
      this.renderStatus('unavailable')
      return
    }
    exactKeys(subscribed, ['result', 'handle'], 'subscribe runtime result')
    exactKeys(subscribed.result, ['type', 'status', 'code', 'subscription'], 'subscribe result')
    if (subscribed.result.code !== 'allowed' || !('handle' in subscribed)) {
      throw new Error('accepted subscribe result is missing its runtime handle')
    }
    plainObject(subscribed.handle, 'subscribe runtime handle')
    exactKeys(
      subscribed.handle,
      this.record.version >= 4
        ? ['subscription', 'pages', 'closed', 'unsubscribe']
        : ['subscription', 'pages', 'unsubscribe'],
      'subscribe runtime handle',
    )
    if (typeof subscribed.handle.unsubscribe !== 'function') {
      throw new Error('accepted subscribe result has an invalid runtime handle')
    }
    this.unsubscribe = () => subscribed.handle.unsubscribe()
    if (this.record.version >= 4) {
      const closed = (subscribed.handle as { readonly closed?: unknown }).closed
      if (
        closed === null || typeof closed !== 'object' || typeof (closed as PromiseLike<unknown>).then !== 'function'
      ) throw new Error(`v${this.record.version} subscribe runtime handle.closed is invalid`)
      void Promise.resolve(closed).then(value => this.observeVersionedClosed(value)).catch(error =>
        this.fail(new Error(`v${this.record.version} subscription closed Promise rejected: ${String(error)}`))
      )
    }
    assertSubscription(subscribed.result.subscription, 'subscribe result.subscription')
    assertSubscription(subscribed.handle.subscription, 'subscribe handle.subscription')
    if (!sameSubscription(subscribed.result.subscription, subscribed.handle.subscription)) {
      throw new Error('subscribe result and runtime handle descriptors differ')
    }
    const issued = subscribed.result.subscription
    if (
      !sameBinding(issued.binding, this.binding) || issued.generation !== initial.generation
      || issued.afterSequence !== this.cursor
    ) {
      throw new Error('subscribe result crossed its binding, generation, or cursor fence')
    }
    if (
      subscribed.handle.pages === null
      || typeof subscribed.handle.pages !== 'object'
      || !(Symbol.asyncIterator in subscribed.handle.pages)
    ) {
      throw new Error('accepted subscribe result has an invalid runtime handle')
    }
    this.subscription = immutableSnapshot(issued)
    this.render()
    await this.consume(
      subscribed.handle.pages as AsyncIterable<
        | AgentConversationShellPage
        | AgentConversationShellPageV4
        | AgentConversationShellPageV5
        | AgentConversationShellPageV6
        | AgentConversationShellPageV7
      >,
    )
  }

  protected abstract consume(
    pages: AsyncIterable<
      | AgentConversationShellPage
      | AgentConversationShellPageV4
      | AgentConversationShellPageV5
      | AgentConversationShellPageV6
      | AgentConversationShellPageV7
    >,
  ): Promise<void>
  protected abstract render(): void
  protected abstract renderStatus(state: 'loading' | 'unavailable' | 'error', detail?: string): void
  protected abstract fail(error: unknown): void
  protected abstract observeVersionedClosed(value: unknown): void
  protected abstract releaseSource(): void
  protected abstract runPlugin<Value>(operation: string, callback: () => Value | Promise<Value>): Promise<Value>
  protected abstract assertSnapshotFence(
    snapshot:
      | AgentConversationShellSnapshot
      | AgentConversationShellSnapshotV4
      | AgentConversationShellSnapshotV5
      | AgentConversationShellSnapshotV6
      | AgentConversationShellSnapshotV7,
  ): void
}
