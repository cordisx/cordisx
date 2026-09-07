import type {
  AgentConversationRoomSettingsPatch,
  AgentConversationRoomSettingsUpdateRequest,
  AgentConversationRoomSettingsUpdateResult,
} from '@cordisx/protocol/agent-conversation-shell/v3'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV4,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV4,
} from '@cordisx/protocol/agent-conversation-shell/v4'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV5,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV5,
} from '@cordisx/protocol/agent-conversation-shell/v5'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV6,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV6,
} from '@cordisx/protocol/agent-conversation-shell/v6'
import type {
  AgentConversationShellSnapshot as AgentConversationShellSnapshotV7,
  AgentConversationShellSubscriptionClosed as AgentConversationShellSubscriptionClosedV7,
} from '@cordisx/protocol/agent-conversation-shell/v7'
import type { AgentConversationShellCommandContext as AgentConversationShellCommandContextV9 } from '@cordisx/protocol/agent-conversation-shell/v9'
import type { AgentBootstrapCommandOrigin } from '@cordisx/protocol/agent-admission/v4'
import * as React from 'react'
import { AgentConversationRenderer } from './host-ui/conversation/AgentConversationRenderer.js'
import { AgentConversationCommandController } from './host-ui/conversation/commands.js'
import { AGENT_CONVERSATION_STYLES } from './host-ui/conversation/styles.js'
import { immutableSnapshot } from './validation.js'
import {
  type AgentConversationShellSnapshot,
  assertRoomSettingsPatch,
  exactKeys,
  opaque,
  plainObject,
} from './agent-conversation-shell-validation.js'
import { sameBinding } from './agent-conversation-shell-validation-v4.js'
import {
  projectAgentConversationShellSnapshotV4,
  projectAgentConversationShellSnapshotV5,
  projectAgentConversationShellSnapshotV6,
  projectAgentConversationShellSnapshotV7,
  type ProjectionLocalization,
  projectSnapshot,
  protocolMessage,
  rendererCopy,
} from './agent-conversation-shell-projection.js'
import { MountedConversationUpdates } from './agent-conversation-shell-updates.js'

export class MountedConversation extends MountedConversationUpdates {
  protected render(): void {
    if (this.disposed || this.snapshot === undefined) return
    const localization: ProjectionLocalization = {
      resolve: (message, site) => {
        const key = `conversation:${this.binding.bindingId}:${site}`
        this.diagnosticSites.add(key)
        return this.i18n.resolveFor(this.record.owner, protocolMessage(message), key).text
      },
    }
    try {
      const model = this.record.version >= 7
        ? projectAgentConversationShellSnapshotV7(
          this.record.owner,
          this.snapshot as AgentConversationShellSnapshotV7,
          localization,
        )
        : this.record.version === 6
        ? projectAgentConversationShellSnapshotV6(
          this.record.owner,
          this.snapshot as AgentConversationShellSnapshotV6,
          localization,
        )
        : this.record.version === 5
        ? projectAgentConversationShellSnapshotV5(
          this.record.owner,
          this.snapshot as AgentConversationShellSnapshotV5,
          localization,
        )
        : this.record.version === 4
        ? projectAgentConversationShellSnapshotV4(
          this.record.owner,
          this.snapshot as AgentConversationShellSnapshotV4,
          localization,
        )
        : projectSnapshot(this.record.owner, this.snapshot as AgentConversationShellSnapshot, localization)
      const controller = new AgentConversationCommandController({
        execute: async request => {
          const isComposerCommand = request.context.scope === 'composer-submit'
          if (this.record.version === 9 && this.record.composerMode === 'page-composer-v2' && isComposerCommand) {
            const pageComposer = this.mountContext.pageComposer
            if (pageComposer === undefined) {
              throw new Error('Page composer admission is unavailable for this mounted conversation')
            }
            const result = await pageComposer.execute({
              $schema:
                'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-page-composer-command-request.v1.schema.json',
              contract: 'cordisx.agent-page-composer-command-request/v1',
              schemaVersion: 1,
              command: request.reference,
              submitPayload: request.context.submitPayload,
            })
            if (result.status !== 'accepted') {
              throw new Error(`Page composer admission was not accepted: ${result.code}`)
            }
            return result
          }
          const isComposerSubmit = isComposerCommand && model.selection.kind === 'room'
          const activeRuns = model.selection.kind === 'room' ? model.selection.activeRuns ?? [] : []
          const runs = activeRuns.flatMap(run => (
            'sessionId' in run
              ? [{
                runId: run.runId,
                sessionId: run.sessionId,
                participantId: run.participantId,
                memberId: run.memberId,
              }]
              : []
          ))
          const roomId = model.selection.kind === 'room' ? model.selection.roomId : undefined
          const admissionOrigin =
            this.record.version === 8 && isComposerSubmit && roomId !== undefined && activeRuns.length >= 1
              ? (() => {
                // Frozen Shell v8 behavior: keep its historical first active
                // Room run selection exactly as-is.
                const run = activeRuns[0]!
                return Object.freeze({
                  $schema:
                    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json' as const,
                  contract: 'cordisx.agent-command-origin/v1' as const,
                  schemaVersion: 1 as const,
                  originId: `cx-command-origin.${crypto.randomUUID()}`,
                  binding: Object.freeze({
                    bindingId: this.binding.bindingId,
                    ownerGeneration: this.binding.ownerGeneration,
                  }),
                  generation: this.record.effect.moduleGeneration ?? this.record.ownerGeneration,
                  executionId: request.invocationKey,
                  commandId: request.reference.id,
                  scope: 'composer-submit' as const,
                  room: Object.freeze({
                    roomId,
                    participantId: run.participantId,
                    memberId: run.memberId,
                    runId: run.runId,
                  }),
                })
              })()
              : this.record.version === 9 && isComposerSubmit && roomId !== undefined && runs.length >= 1
              ? (() => {
                // A mounted v9 Room already has an exact Session-backed
                // target. Preserve that public v1 authority so v3 can issue
                // one opaque capability per known delivery; bootstrap is only
                // for a command that has no such target yet.
                const run = runs[0]!
                return Object.freeze({
                  $schema:
                    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-command-origin.v1.schema.json' as const,
                  contract: 'cordisx.agent-command-origin/v1' as const,
                  schemaVersion: 1 as const,
                  originId: `cx-command-origin.${crypto.randomUUID()}`,
                  binding: Object.freeze({
                    bindingId: this.binding.bindingId,
                    ownerGeneration: this.binding.ownerGeneration,
                  }),
                  generation: this.record.effect.moduleGeneration ?? this.record.ownerGeneration,
                  executionId: request.invocationKey,
                  commandId: request.reference.id,
                  scope: 'composer-submit' as const,
                  room: Object.freeze({
                    roomId,
                    participantId: run.participantId,
                    memberId: run.memberId,
                    runId: run.runId,
                  }),
                })
              })()
              : undefined
          const bootstrapOrigin: AgentBootstrapCommandOrigin | undefined =
            this.record.version !== 9 || !isComposerCommand || admissionOrigin !== undefined
              ? undefined
              : Object.freeze({
                $schema:
                  'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-bootstrap-command-origin.v1.schema.json' as const,
                contract: 'cordisx.agent-bootstrap-command-origin/v1' as const,
                schemaVersion: 1 as const,
                originId: `cx-bootstrap-command-origin.${crypto.randomUUID()}`,
                binding: Object.freeze({
                  bindingId: this.binding.bindingId,
                  ownerGeneration: this.binding.ownerGeneration,
                }),
                generation: this.record.effect.moduleGeneration ?? this.record.ownerGeneration,
                executionId: request.invocationKey,
                commandId: request.reference.id,
                scope: 'composer-submit' as const,
              })
          const execute = async () => {
            if (bootstrapOrigin !== undefined) {
              if (request.context.scope !== 'composer-submit') {
                throw new Error('Shell v9 bootstrap origin crossed its composer scope')
              }
              const context: AgentConversationShellCommandContextV9 = { ...request.context, origin: bootstrapOrigin }
              return await this.commands.executeConversationFor(
                request.ownerId,
                request.reference,
                request.invocationKey,
                context,
              )
            }
            if (admissionOrigin !== undefined) {
              const context = { ...request.context, origin: admissionOrigin }
              return await this.commands.executeConversationFor(
                request.ownerId,
                request.reference,
                request.invocationKey,
                context,
              )
            }
            // v1–v7 and frozen v8 calls without a valid one-run Room origin
            // retain their predecessor command behavior without retyping a v8
            // context as one that has an origin.
            return await this.commands.executeConversationFor(
              request.ownerId,
              request.reference,
              request.invocationKey,
              request.context,
            )
          }
          // Shell v9 uses bootstrap only when no exact Session-backed Room
          // target exists. A mounted Room keeps v1/v3 source capture on its
          // current binding; fresh Room replacement remains the v6 claim path.
          const capturesBootstrapCommand = this.record.version === 9 && bootstrapOrigin !== undefined
          const capturesExistingV9TargetCommand = this.record.version === 9 && admissionOrigin !== undefined
          const capturesPredecessorCommand = this.record.version !== 9 && isComposerSubmit
            && roomId !== undefined && runs.length > 0
          if (
            this.scenarioSource === undefined
            || !(capturesBootstrapCommand || capturesExistingV9TargetCommand || capturesPredecessorCommand)
          ) return await execute()
          const scenarioOwner = this.scenarioOwner?.(this.record.owner, this.record.effect.moduleGeneration)
          if (scenarioOwner === undefined) return await execute()
          const snapshotGeneration = model.generation
          const sourceStillActive = (): boolean => {
            if (
              this.disposed || this.terminal || this.mountContext.signal.aborted || !this.record.active
              || (this.record.version !== 8 && this.record.version !== 9
                && this.snapshot?.generation !== snapshotGeneration)
            ) return false
            const currentSelection = this.snapshot?.selection
            if (this.record.version === 9) {
              // A bootstrap source started from no-room cannot retrospectively
              // infer the Room created by the handler. Its binding/execution
              // fence stays live for this command; disposal/replacement still
              // fences it, while the v4 opaque token fixes the declared target.
              return roomId === undefined || (currentSelection?.kind === 'room' && currentSelection.roomId === roomId)
            }
            if (currentSelection?.kind !== 'room' || currentSelection.roomId !== roomId) return false
            if (this.record.version === 8) return true
            const currentRuns = currentSelection.activeRuns ?? []
            return runs.every(run =>
              currentRuns.some(current =>
                'sessionId' in current
                && current.runId === run.runId && current.sessionId === run.sessionId
              )
            )
          }
          const scenarioOrigin = {
            owner: Object.freeze({ ...scenarioOwner }),
            bindingId: this.binding.bindingId,
            ownerGeneration: this.binding.ownerGeneration,
            snapshotGeneration,
            ...(roomId === undefined ? {} : { roomId }),
            routeId: this.mountContext.routeId,
            runs,
            active: sourceStillActive,
          }
          return await this.scenarioSource.execute(
            bootstrapOrigin !== undefined
              ? { ...scenarioOrigin, bootstrapOrigin }
              : admissionOrigin === undefined
              ? scenarioOrigin
              : { ...scenarioOrigin, admissionOrigin },
            execute,
          )
        },
      }, model)
      const navigationActions = model.selection.kind !== 'room'
          || this.mountContext.routeDefinitionId === undefined
        ? undefined
        : this.selectedNavigationActions?.selected(this.record.owner, {
          id: this.mountContext.routeDefinitionId,
          params: this.mountContext.params,
        })?.actions
      this.root.render(
        <AgentConversationRenderer
          model={model}
          commands={controller}
          copy={rendererCopy(this.i18n.getSnapshot().locale)}
          {...(navigationActions === undefined ? {} : { navigationActions })}
          {...(typeof this.source?.updateRoomSettings !== 'function' || model.selection.kind !== 'room' ? {} : {
            roomSettings: {
              update: async (patch: AgentConversationRoomSettingsPatch) => await this.updateRoomSettings(patch),
            },
          })}
          {...(this.identity === undefined ? {} : { identity: this.identity })}
        />,
      )
    } catch (error) {
      this.fail(error)
    }
  }

  private async updateRoomSettings(patch: AgentConversationRoomSettingsPatch): Promise<void> {
    if (
      this.source === undefined || this.snapshot === undefined || this.snapshot.selection.kind !== 'room'
      || typeof this.source.updateRoomSettings !== 'function'
    ) throw new Error('Room settings are unavailable')
    assertRoomSettingsPatch(patch)
    const request: AgentConversationRoomSettingsUpdateRequest = immutableSnapshot({
      requestId: `settings-${crypto.randomUUID()}`,
      binding: this.snapshot.binding,
      generation: this.snapshot.generation,
      roomId: this.snapshot.selection.roomId,
      expectedSnapshotSequence: this.snapshot.snapshotSequence,
      patch,
    })
    const result = immutableSnapshot(
      await this.runPlugin(
        'agent-conversation-shell.update-room-settings',
        () => this.source!.updateRoomSettings(request as never),
      ),
    )
    this.assertRoomSettingsResult(result, request)
    if (result.status !== 'applied') throw new Error(`Room settings update ${result.code}`)
  }

  private assertRoomSettingsResult(
    result: AgentConversationRoomSettingsUpdateResult,
    request: AgentConversationRoomSettingsUpdateRequest,
  ): void {
    plainObject(result, 'room settings result')
    exactKeys(result, [
      'type',
      'requestId',
      'binding',
      'generation',
      'roomId',
      'expectedSnapshotSequence',
      'status',
      'code',
      'snapshotSequence',
      'currentSnapshotSequence',
    ], 'room settings result')
    if (
      result.type !== 'update-room-settings' || result.requestId !== request.requestId
      || !sameBinding(result.binding, request.binding) || result.generation !== request.generation
      || result.roomId !== request.roomId || result.expectedSnapshotSequence !== request.expectedSnapshotSequence
    ) {
      throw new Error('Room settings result crossed its request fence')
    }
    if (result.status === 'applied') {
      if (
        result.code !== 'applied' || !Number.isSafeInteger(result.snapshotSequence)
        || result.snapshotSequence <= request.expectedSnapshotSequence || result.currentSnapshotSequence !== undefined
      ) {
        throw new Error('Room settings applied result is invalid')
      }
      return
    }
    if (result.status === 'conflict') {
      if (
        !['request-conflict', 'owner-conflict', 'generation-conflict', 'room-conflict', 'snapshot-conflict'].includes(
          result.code,
        )
        || result.snapshotSequence !== undefined
        || result.currentSnapshotSequence !== undefined
          && (!Number.isSafeInteger(result.currentSnapshotSequence) || result.currentSnapshotSequence < 0)
      ) {
        throw new Error('Room settings conflict result is invalid')
      }
      return
    }
    if (result.status === 'unavailable') {
      if (
        !['owner-unavailable', 'settings-unavailable', 'disposed'].includes(result.code)
        || result.snapshotSequence !== undefined || result.currentSnapshotSequence !== undefined
      ) {
        throw new Error('Room settings unavailable result is invalid')
      }
      return
    }
    throw new Error('Room settings result status is invalid')
  }

  protected renderStatus(state: 'loading' | 'unavailable' | 'error', detail?: string): void {
    const locale = this.i18n.getSnapshot().locale
    const chinese = locale.toLowerCase().startsWith('zh')
    const label = state === 'loading'
      ? chinese ? '正在加载对话…' : 'Loading conversation…'
      : state === 'unavailable'
      ? chinese ? '对话暂不可用。' : 'Conversation is unavailable.'
      : chinese
      ? '无法加载对话。'
      : 'Could not load conversation.'
    this.root.render(
      <section className="cxa-root" data-agent-conversation-runtime-state={state} role="status" aria-live="polite">
        <style data-agent-conversation-styles="production">{AGENT_CONVERSATION_STYLES}</style>
        <div className="cxa-runtime-status">
          <p>{label}</p>
          {detail === undefined ? null : <p className="cxa-live-region">{detail}</p>}
        </div>
      </section>,
    )
  }

  protected fail(error: unknown): void {
    if (this.disposed) return
    const detail = error instanceof Error ? error.message : String(error)
    this.releaseSource()
    this.renderStatus('error', detail)
    console.error('[cordisx] Agent conversation source failed', error)
  }

  protected observeVersionedClosed(value: unknown): void {
    if (this.disposed || this.record.version < 4) return
    const version = this.record.version
    plainObject(value, `v${version} subscription close`)
    exactKeys(value, [
      '$schema',
      'contract',
      'schemaVersion',
      'subscriptionId',
      'binding',
      'generation',
      'status',
      'code',
    ], `v${version} subscription close`)
    const close = value as unknown as
      | AgentConversationShellSubscriptionClosedV4
      | AgentConversationShellSubscriptionClosedV5
      | AgentConversationShellSubscriptionClosedV6
      | AgentConversationShellSubscriptionClosedV7
    if (
      close.$schema
        !== `https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/agent-conversation-shell-subscription-close.v${version}.schema.json`
      || close.contract !== `cordisx.agent-conversation-shell-subscription-close/v${version}`
      || close.schemaVersion !== version
      || close.status !== 'closed'
      || ![
        'unsubscribed',
        'explicit',
        'owner-disposed',
        'generation-replaced',
        'permission-revoked',
        'connection-replaced',
        'observer-failed',
      ].includes(close.code)
    ) {
      throw new Error(`v${version} subscription close is invalid`)
    }
    const subscription = this.subscription
    if (
      subscription === undefined || close.subscriptionId !== subscription.subscriptionId
      || !sameBinding(close.binding, subscription.binding) || close.generation !== subscription.generation
    ) throw new Error(`v${version} subscription close crossed its subscription fence`)
    if (!this.terminal) {
      this.terminal = true
      this.releaseSource()
      this.renderStatus('unavailable')
    }
  }

  protected releaseSource(): void {
    try {
      const result = this.unsubscribe?.()
      if (result !== undefined) {
        void Promise.resolve(result).catch(error =>
          console.error('[cordisx] Agent conversation unsubscribe failed', error)
        )
      }
    } catch (error) {
      console.error('[cordisx] Agent conversation unsubscribe failed', error)
    }
    this.unsubscribe = undefined
    try {
      this.source?.dispose()
    } catch (error) {
      console.error('[cordisx] Agent conversation source disposal failed', error)
    }
    this.source = undefined
  }

  protected async runPlugin<Value>(operation: string, callback: () => Value | Promise<Value>): Promise<Value> {
    if (this.record.principal === undefined || this.console === undefined) return await callback()
    return await this.console.runInPluginContext(this.record.principal, {
      trigger: { kind: 'registration', registrationId: `${operation}:${this.record.owner}` },
    }, callback)
  }
}
