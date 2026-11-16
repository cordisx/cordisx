import type { ChannelConversationPolicyReadbackV1 } from '@cordisx/protocol/channel-conversation-policy/v1'
import type { ChannelConversationPolicyReadbackV3 } from '@cordisx/protocol/channel-conversation-policy/v3'
import type { ChannelConversationPolicyReadbackV2 } from '@cordisx/protocol/channel-conversation-policy/v2'
import type { ChannelManagerActionResult } from '../launcher/channel-manager-api.js'
import {
  channelConversationPolicyV1,
  channelConversationPolicyV2,
  mergeLegacyChannelPolicy,
  parseChannelConversationPolicy,
} from '../launcher/channel-conversation-policy.js'
import { configureChannelPolicyPrompt } from './channel-policy-prompt.js'
import type { ChannelManagerFormOptionsV1, ChannelManagerFormOutcomeV1 } from '@cordisx/protocol/channel-manager/v7'
import { ChannelPolicyForm } from './channel-policy-form.js'
import {
  channelPolicyFormValue,
  channelPolicySectionChanged,
  channelPolicySectionFields,
  mergeChannelPolicySection,
} from './channel-policy-form-model.js'
import type { ChannelSettingsDraft } from './channel-settings-draft.js'
import type { ChannelSettingsFormSectionV1 } from '@cordisx/protocol/channel-manager/v11'
import { mountChannelHostForm } from './channel-form-mount.js'
import { createElement } from 'react'

/** Policy writes always originate from the Host form, never a plugin-owned draft or event. */
export class ChannelPolicyWorkflow {
  private busy = false
  get document(): Document {
    return this.input.document
  }
  constructor(
    private readonly input: {
      readonly document: Document
      readonly profileId: string
      readonly hostGeneration: string
      readonly signal: AbortSignal
      readonly isCurrent: () => boolean
      run(action: 'policy' | 'policy-set', request: Record<string, unknown>): Promise<ChannelManagerActionResult>
    },
  ) {}

  private live(signal: AbortSignal): boolean {
    return !signal.aborted && !this.input.signal.aborted && this.input.isCurrent()
  }

  async readWorkflow(signal: AbortSignal): Promise<ChannelConversationPolicyReadbackV3> {
    if (!this.live(signal)) throw new Error('STALE_GENERATION')
    const result = await this.input.run('policy', {})
    if (!this.live(signal)) throw new Error('STALE_GENERATION')
    const value = result.conversationPolicy
    if (result.status !== 'applied' || !value || !Number.isSafeInteger(value.revision) || value.revision < 0) {
      throw new Error('CHANNEL_POLICY_UNAVAILABLE')
    }
    return {
      contract: 'cordisx.channel-conversation-policy-readback/v3',
      schemaVersion: 3,
      profileId: this.input.profileId,
      hostGeneration: this.input.hostGeneration,
      revision: value.revision,
      policy: parseChannelConversationPolicy(value.policy),
    }
  }

  async readReply(signal: AbortSignal): Promise<ChannelConversationPolicyReadbackV2> {
    const readback = await this.readWorkflow(signal)
    return {
      ...readback,
      contract: 'cordisx.channel-conversation-policy-readback/v2',
      schemaVersion: 2,
      policy: channelConversationPolicyV2(readback.policy),
    }
  }

  async read(signal: AbortSignal): Promise<ChannelConversationPolicyReadbackV1> {
    const readback = await this.readReply(signal)
    return {
      ...readback,
      contract: 'cordisx.channel-conversation-policy-readback/v1',
      schemaVersion: 1,
      policy: channelConversationPolicyV1(readback.policy),
    }
  }

  async configure(owner: string, signal: AbortSignal, callerLive: () => boolean = () => true, replyFields = false) {
    if (this.busy) return { status: 'conflict' as const, code: 'OPERATION_IN_PROGRESS' }
    this.busy = true
    try {
      const readback = await this.readWorkflow(signal)
      if (!callerLive()) return { status: 'unavailable' as const, code: 'STALE_GENERATION' }
      return await configureChannelPolicyPrompt({
        document: this.input.document,
        owner,
        policy: readback.policy,
        replyFields,
        signal: AbortSignal.any([signal, this.input.signal]),
        save: async policy => {
          if (!this.live(signal) || !callerLive()) return { status: 'unavailable', code: 'STALE_GENERATION' }
          const result = await this.input.run('policy-set', { policy, expectedRevision: readback.revision })
          // A completed commit remains applied even if its initiating page was closed in flight.
          if (result.status === 'applied') return { status: 'applied', code: 'APPLIED' }
          return {
            status: result.code === 'REVISION_CONFLICT' ? 'conflict' : 'rejected',
            code: result.code ?? 'POLICY_CONFIGURATION_FAILED',
          }
        },
      })
    } catch {
      return { status: 'unavailable' as const, code: 'CHANNEL_POLICY_UNAVAILABLE' }
    } finally {
      this.busy = false
    }
  }

  async mount(
    owner: string,
    target: HTMLElement,
    options: ChannelManagerFormOptionsV1,
    callerLive: () => boolean,
    authorizeWrite: () => Promise<boolean>,
    workflowFields = false,
    settings?: {
      readonly draft: ChannelSettingsDraft
      readonly section: Exclude<ChannelSettingsFormSectionV1, 'new-chats'>
    },
  ) {
    const readback = await this.readWorkflow(options.signal)
    let revision = readback.revision
    const live = () => this.live(options.signal) && callerLive()
    return mountChannelHostForm({
      target,
      owner,
      options,
      lifetime: this.input.signal,
      live,
      render: signal =>
        createElement(ChannelPolicyForm, {
          policy: workflowFields ? readback.policy : channelConversationPolicyV2(readback.policy),
          workflowFields,
          revision: readback.revision,
          ...(settings === undefined ? {} : { draft: settings.draft, section: settings.section }),
          locale: this.input.document.documentElement.lang || 'en',
          signal,
          refresh: async () => {
            if (!live() || signal.aborted) throw new Error('STALE_GENERATION')
            const current = await this.readWorkflow(signal)
            if (!live() || signal.aborted) throw new Error('STALE_GENERATION')
            revision = current.revision
            return settings === undefined
              ? workflowFields ? current.policy : channelConversationPolicyV2(current.policy)
              : { policy: current.policy, revision: current.revision }
          },
          onResult: result => {
            if (live() && !signal.aborted) options.onResult?.(result)
          },
          save: async policy => {
            const submittedDraft = settings?.draft.snapshot()
            if (!live() || signal.aborted) return { status: 'unavailable', code: 'STALE_GENERATION' }
            if (!await authorizeWrite()) return { status: 'rejected', code: 'PERMISSION_DENIED' }
            if (!live() || signal.aborted) return { status: 'unavailable', code: 'STALE_GENERATION' }
            if (this.busy) return { status: 'conflict', code: 'OPERATION_IN_PROGRESS' }
            this.busy = true
            try {
              const latest = await this.readWorkflow(signal)
              let submitted: unknown = workflowFields
                ? policy
                : mergeLegacyChannelPolicy(latest.policy, parseChannelConversationPolicy(policy))
              if (settings) {
                const snapshot = submittedDraft!
                if (
                  latest.revision !== snapshot.revision
                  && channelPolicySectionChanged(latest.policy, snapshot.baseline, settings.section)
                ) {
                  return { status: 'conflict', code: 'REVISION_CONFLICT' }
                }
                submitted = mergeChannelPolicySection(
                  latest.policy,
                  policy as Record<string, unknown>,
                  settings.section,
                )
              }
              if (!live() || signal.aborted) return { status: 'unavailable', code: 'STALE_GENERATION' }
              const result = await this.input.run('policy-set', {
                policy: submitted,
                expectedRevision: settings ? latest.revision : revision,
              })
              if (result.status === 'applied') {
                revision = result.conversationPolicy?.revision ?? revision + 1
                if (settings) {
                  settings.draft.commitFields(
                    channelPolicyFormValue(parseChannelConversationPolicy(submitted), true),
                    revision,
                    channelPolicySectionFields[settings.section],
                    submittedDraft?.value,
                  )
                }
                return { status: 'applied', code: 'APPLIED' }
              }
              return {
                status: result.code === 'REVISION_CONFLICT' ? 'conflict' : 'rejected',
                code: result.code ?? 'POLICY_CONFIGURATION_FAILED',
              } satisfies ChannelManagerFormOutcomeV1
            } finally {
              this.busy = false
            }
          },
        }),
    })
  }
}
