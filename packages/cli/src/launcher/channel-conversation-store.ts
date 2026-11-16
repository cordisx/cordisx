import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import type { ChannelThreadRef, ChannelUserInput } from '@cordisx/channel-runtime'
import type { ChannelCommandAddressing } from './channel-command-users.js'
import type { ChannelAutoReplyMode, ChannelReplyDefaults, ChannelReplyMode } from './channel-reply-routing.js'
import {
  CHANNEL_CONVERSATION_POLICY_INITIAL,
  type ChannelConversationPolicy,
  parseChannelConversationPolicy,
} from './channel-conversation-policy.js'

export interface ChannelChatBinding {
  readonly id: string
  readonly channel: ChannelThreadRef
  readonly sessionId: string
  readonly hostId: 'local'
  readonly profileId: string
  readonly createdAt: string
  readonly fromSequence: number
  readonly mode: 'listen' | 'deliver'
  readonly autoReply: boolean
  readonly replyMode?: ChannelAutoReplyMode
  readonly replyFallbackMode?: ChannelReplyMode
  state: 'active' | 'archived'
}
export interface ChannelConversationInput {
  readonly recordId: string
  readonly input: ChannelUserInput
  readonly mentionedBot: boolean
  readonly sequence: number
  readonly persisted: boolean
  readonly addressing?: ChannelCommandAddressing
  accepted: boolean
  routed: boolean
}
export interface ChannelConversationJob {
  readonly id: string
  readonly recordId: string
  bindingId?: string
  readonly autoCreate: boolean
  readonly creationReason?: 'bind-command'
  state:
    | 'queued'
    | 'dispatching'
    | 'running'
    | 'replying'
    | 'completed'
    | 'failed'
    | 'reconciliation-required'
    | 'cancelled'
  sessionId?: string
  turnId?: string
  deliveryId?: string
  /** Captured before native dispatch; a later opt-in must not export an earlier local-only turn. */
  finalDeliveryEnabled?: boolean
  replyDefaults?: ChannelReplyDefaults
  replyMode?: ChannelReplyMode
  replyTarget?: ChannelThreadRef
  code?: string
}
export interface ChannelConversationState {
  readonly contract: 'cordisx.channel-conversation-store/v1'
  readonly schemaVersion: 1
  revision: number
  policyRevision: number
  policy: ChannelConversationPolicy
  nextSequence: number
  inputCursor: string
  bindings: Record<string, ChannelChatBinding>
  inputs: Record<string, ChannelConversationInput>
  jobs: Record<string, ChannelConversationJob>
}

function initial(): ChannelConversationState {
  return {
    contract: 'cordisx.channel-conversation-store/v1',
    schemaVersion: 1,
    revision: 0,
    policyRevision: 0,
    policy: CHANNEL_CONVERSATION_POLICY_INITIAL,
    nextSequence: 1,
    inputCursor: 'channel-input:0:empty',
    bindings: {},
    inputs: {},
    jobs: {},
  }
}

/** Host-owned bindings and dispatch receipts. This is not a Channel connection store or shared Codex DB. */
export class ChannelConversationStore {
  private tail: Promise<void> = Promise.resolve()
  private constructor(private readonly file: string, private value: ChannelConversationState) {}
  static async open(file: string): Promise<ChannelConversationStore> {
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
    let value = initial()
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as ChannelConversationState
      if (
        parsed.contract !== value.contract || parsed.schemaVersion !== 1 || !Number.isSafeInteger(parsed.revision)
        || !Number.isSafeInteger(parsed.nextSequence) || typeof parsed.inputCursor !== 'string'
        || !parsed.bindings || !parsed.inputs || !parsed.jobs
      ) throw new Error('INVALID_CONVERSATION_STORE')
      parsed.policy = parseChannelConversationPolicy(parsed.policy)
      parsed.policyRevision ??= 0
      if (!Number.isSafeInteger(parsed.policyRevision) || parsed.policyRevision < 0) {
        throw new Error('INVALID_CONVERSATION_STORE')
      }
      value = parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const store = new ChannelConversationStore(file, value)
    // A process died after reserving a native effect. Never blindly recreate/resend it.
    await store.mutate(state => {
      for (const job of Object.values(state.jobs)) {
        if (job.state === 'dispatching') {
          job.state = 'reconciliation-required'
          job.code = 'NATIVE_EFFECT_UNCERTAIN'
        }
      }
    })
    return store
  }
  snapshot(): ChannelConversationState {
    return structuredClone(this.value)
  }
  async mutate<T>(update: (draft: ChannelConversationState) => T): Promise<T> {
    let result!: T
    const task = this.tail.then(async () => {
      const value = structuredClone(this.value)
      result = update(value)
      if (JSON.stringify(value) === JSON.stringify(this.value)) return
      value.revision += 1
      const temporary = this.file + '.' + randomUUID() + '.tmp'
      const handle = await open(temporary, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(value) + '\n')
        await handle.sync()
        await handle.close()
        await rename(temporary, this.file)
        const directory = await open(path.dirname(this.file), 'r')
        try {
          await directory.sync()
        } finally {
          await directory.close()
        }
        this.value = value
      } finally {
        await handle.close().catch(() => undefined)
        await rm(temporary, { force: true })
      }
    })
    this.tail = task.catch(() => undefined)
    await task
    return result
  }
  async close(): Promise<void> {
    await this.tail
  }
}
