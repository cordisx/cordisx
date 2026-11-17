import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import type { ChannelManagerFormOptionsV1 } from '@cordisx/protocol/channel-manager/v7'
import type { ChannelManagerActionsApi } from './channel-manager.js'
import { mountChannelHostForm } from './channel-form-mount.js'
import { managedConsoleSeatFor } from './managed-console-seats.js'
import { ChannelContinuationDefaultsForm, type ContinuationDefaults } from './channel-continuation-defaults-form.js'

export async function mountContinuationDefaults(input: {
  ctx: Context
  owner: string
  target: HTMLElement
  options: ChannelManagerFormOptionsV1
  workflow: ChannelContinuationDefaultsWorkflow | undefined
  live(): boolean
  authorizeRead(): Promise<boolean>
  authorizeWrite(): Promise<boolean>
}) {
  if (
    !managedConsoleSeatFor(input.target, input.owner) || input.options.signal.aborted || !input.workflow
    || !await input.authorizeRead()
  ) return { status: 'unavailable' as const, code: 'HOST_FORM_UNAVAILABLE' }
  const lifetime = new AbortController()
  const dispose = input.ctx.effect(() => () => lifetime.abort(), 'channelManager continuation defaults form')
  try {
    const result = await input.workflow.mount({
      owner: input.owner,
      target: input.target,
      options: { ...input.options, signal: AbortSignal.any([input.options.signal, lifetime.signal]) },
      live: input.live,
      authorize: input.authorizeWrite,
    })
    if (result.status === 'mounted') void result.closed.then(() => dispose())
    else dispose()
    return result
  } catch {
    dispose()
    return { status: 'unavailable' as const, code: 'CONTINUATION_DEFAULTS_UNAVAILABLE' }
  }
}

function readback(result: Awaited<ReturnType<ChannelManagerActionsApi['run']>>): ContinuationDefaults {
  const value = (result as typeof result & { continuationDefaults?: unknown }).continuationDefaults
  if (result.status !== 'applied' || !value || typeof value !== 'object') {
    throw new Error(result.code ?? 'CONTINUATION_DEFAULTS_UNAVAILABLE')
  }
  const candidate = value as ContinuationDefaults
  if (
    !Number.isSafeInteger(candidate.revision) || candidate.revision < 0
    || typeof candidate.policy?.enabled !== 'boolean'
    || !Number.isFinite(candidate.policy.thresholdRatio) || candidate.policy.thresholdRatio <= 0
    || candidate.policy.thresholdRatio > .95
  ) {
    throw new Error('CONTINUATION_DEFAULTS_UNAVAILABLE')
  }
  return structuredClone(candidate)
}

export class ChannelContinuationDefaultsWorkflow {
  constructor(
    private readonly input: {
      document: Document
      lifetime: AbortSignal
      live(): boolean
      run: ChannelManagerActionsApi['run']
    },
  ) {}
  private async read(): Promise<ContinuationDefaults> {
    const result = await this.input.run('continuation-defaults', {})
    if (this.input.lifetime.aborted || !this.input.live()) throw new Error('STALE_GENERATION')
    return readback(result)
  }
  async mount(
    input: {
      owner: string
      target: HTMLElement
      options: ChannelManagerFormOptionsV1
      live(): boolean
      authorize(): Promise<boolean>
    },
  ) {
    const initial = await this.read()
    return mountChannelHostForm({
      ...input,
      lifetime: this.input.lifetime,
      render: signal =>
        createElement(ChannelContinuationDefaultsForm, {
          initial,
          locale: this.input.document.documentElement.lang || 'en',
          signal,
          read: () => this.read(),
          save: async (policy, expectedRevision) => {
            if (signal.aborted || !input.live()) throw new Error('STALE_GENERATION')
            if (!await input.authorize()) throw new Error('PERMISSION_DENIED')
            if (signal.aborted || !input.live()) throw new Error('STALE_GENERATION')
            const result = await this.input.run('continuation-defaults-set', { expectedRevision, policy })
            return readback(result)
          },
          onResult: result => {
            if (input.live() && !signal.aborted) input.options.onResult?.(result)
          },
        }),
    })
  }
}
