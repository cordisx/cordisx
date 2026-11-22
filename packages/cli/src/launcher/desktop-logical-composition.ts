import type { NativeSubmissionControlServer } from './native-submission-control-server.js'
import type { NativeSubmissionScope } from './native-submission-controller-contracts.js'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import type { ChannelNativeSessions } from './channel-native-sessions.js'
import { DesktopLogicalTurnAuthority } from './desktop-logical-turn-authority.js'
import { desktopLogicalTurnPreparation } from './desktop-logical-turn-preparation.js'
import { createDesktopLogicalHistory } from './desktop-logical-history.js'
import { desktopLogicalMigration } from './desktop-logical-migration.js'
import type { ModelReasoningEffort } from '../model-reasoning-capabilities.js'

/** One Desktop owner coordinates account tickets and the shared history callback. */
export function createDesktopLogicalComposition(input: {
  control: NativeSubmissionControlServer
  owner?: ProfileLogicalConversationOwner | undefined
  profileId?: string | undefined
  identity(scope: NativeSubmissionScope): Promise<string | undefined>
  ownerIdentity?(scope: NativeSubmissionScope): Promise<string | undefined>
  channelHistory?: ((params: unknown) => Promise<unknown>) | undefined
}) {
  const turns = input.owner && input.profileId
    ? new DesktopLogicalTurnAuthority(input.identity, input.ownerIdentity ?? input.identity)
    : undefined
  if (turns) input.control.bindLogicalTurns(turns)
  let desktopHistory: ((params: unknown) => Promise<unknown>) | undefined
  const preparation = turns && input.owner && input.profileId
    ? desktopLogicalTurnPreparation({
      owner: input.owner,
      turns,
      identity: input.identity,
      appId: 'codex',
      profileId: input.profileId,
      ready: () => desktopHistory !== undefined,
    })
    : undefined
  if (input.channelHistory || input.owner) {
    input.control.bindLogicalHistory(async params => {
      const channel = await Promise.resolve().then(() => input.channelHistory?.(params)).catch(() => undefined)
      if (channel && typeof channel === 'object' && 'success' in channel && channel.success === true) return channel
      return await desktopHistory?.(params)
        ?? { success: false, contentItems: [{ type: 'inputText', text: '{"status":"unavailable"}' }] }
    })
  }
  return {
    preparation,
    historyReady: () => desktopHistory !== undefined,
    bindNative(native: ChannelNativeSessions) {
      if (!turns || !input.owner || !input.profileId) return
      desktopHistory = createDesktopLogicalHistory({
        owner: input.owner,
        native,
        appId: 'codex',
        profileId: input.profileId,
        activeIdentity: (threadId, turnId) => turns.activeIdentity(threadId, turnId),
      })
    },
  }
}

/** Assemble Desktop migration and history under the same profile owner. */
export function createDesktopLogicalServices(
  input: Parameters<typeof createDesktopLogicalComposition>[0] & {
    native(): ChannelNativeSessions | undefined
    targetAllowed(providerId: string, model: string, effort?: ModelReasoningEffort): Promise<boolean>
  },
) {
  const composition = createDesktopLogicalComposition(input)
  const migration = input.owner && input.profileId
    ? desktopLogicalMigration({
      owner: input.owner,
      control: input.control,
      native: input.native,
      profileId: input.profileId,
      identity: input.identity,
      targetAllowed: input.targetAllowed,
      historyReady: composition.historyReady,
    })
    : undefined
  return { composition, migration }
}
