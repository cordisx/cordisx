import { isDeepStrictEqual } from 'node:util'
import type { NativeSubmissionScope } from './native-submission-controller-contracts.js'
import type { ProfileLogicalConversationOwner } from './profile-logical-conversation-owner.js'
import type { DesktopLogicalTurnAuthority } from './desktop-logical-turn-authority.js'

/** Only a committed relation owned by the live Desktop account can issue a turn ticket. */
export function desktopLogicalTurnPreparation(input: {
  owner: ProfileLogicalConversationOwner
  turns: DesktopLogicalTurnAuthority
  identity(scope: NativeSubmissionScope): Promise<string | undefined>
  dispatchIdentity?(scope: NativeSubmissionScope): Promise<string | undefined>
  appId: string
  profileId: string
  ready?(): boolean
}) {
  const relationFor = (scope: NativeSubmissionScope) => {
    const logical = input.owner.store.snapshot().logicalContinuations
    const matches = Object.values(logical?.relations ?? {}).filter(relation =>
      relation.mode === 'linked' && relation.destination.hostId === 'local'
      && relation.destination.appId === input.appId && relation.destination.profileId === input.profileId
      && relation.destination.sessionId === scope.threadId
      && logical?.intents[relation.operationId]?.state === 'applied'
    )
    return { matches, logical }
  }
  const dispatchMatches = async (scope: NativeSubmissionScope, identity: string) =>
    !input.dispatchIdentity || await input.dispatchIdentity(scope) === identity
  return {
    async prepare(scope: NativeSubmissionScope) {
      let issued: string | undefined
      try {
        const { matches, logical } = relationFor(scope)
        if (!matches.length) return { state: 'not-needed' as const }
        if (matches.length !== 1 || !input.owner.store.hasCommitBarrier() || input.ready?.() === false) {
          return { state: 'unavailable' as const }
        }
        const relation = matches[0]!, intent = logical!.intents[relation.operationId]!
        const identity = await input.identity(scope)
        if (
          !identity || !await dispatchMatches(scope, identity)
          || !isDeepStrictEqual(intent.actor, {
            principal: identity,
            scope: `desktop:${input.appId}:${input.profileId}`,
          })
        ) {
          return { state: 'unavailable' as const }
        }
        const token = await input.turns.issue(scope)
        if (!token) return { state: 'unavailable' as const }
        issued = token
        const current = relationFor(scope)
        if (
          !input.owner.store.hasCommitBarrier() || input.ready?.() === false || current.matches.length !== 1
          || !isDeepStrictEqual(current.matches[0], relation)
          || !isDeepStrictEqual(current.logical?.intents[relation.operationId], intent)
          || await input.identity(scope) !== identity || !await dispatchMatches(scope, identity)
        ) {
          input.turns.cancel(token)
          return { state: 'unavailable' as const }
        }
        return { state: 'issued' as const, token }
      } catch {
        if (issued) input.turns.cancel(issued)
        return { state: 'unavailable' as const }
      }
    },
    async attach(scope: NativeSubmissionScope, destination: string, token: string) {
      let attached = false
      try {
        const target = { ...scope, threadId: destination }
        const { matches, logical } = relationFor(target)
        if (matches.length !== 1 || !input.owner.store.hasCommitBarrier() || input.ready?.() === false) return false
        const relation = matches[0]!, intent = logical!.intents[relation.operationId]!
        const identity = await input.identity(scope)
        if (
          !identity || !await dispatchMatches(scope, identity) || relation.source.sessionId !== scope.threadId
          || !isDeepStrictEqual(intent.actor, {
            principal: identity,
            scope: `desktop:${input.appId}:${input.profileId}`,
          })
        ) {
          return false
        }
        const issued = await input.turns.issue(scope, destination, token)
        attached = issued !== undefined
        const current = relationFor(target)
        if (
          !issued || !input.owner.store.hasCommitBarrier() || input.ready?.() === false
          || current.matches.length !== 1 || !isDeepStrictEqual(current.matches[0], relation)
          || !isDeepStrictEqual(current.logical?.intents[relation.operationId], intent)
          || await input.identity(scope) !== identity || !await dispatchMatches(scope, identity)
        ) {
          if (issued) input.turns.cancel(issued)
          return false
        }
        return true
      } catch {
        if (attached) input.turns.cancel(token)
        return false
      }
    },
    cancel: (scope: NativeSubmissionScope, token: string) =>
      !input.turns.attached(token) && input.turns.cancelForScope(token, scope),
    cancelAttached: (token: string) => {
      if (input.turns.attached(token)) input.turns.cancel(token)
    },
    releaseScope: (scope: NativeSubmissionScope) => input.turns.releaseScope(scope),
    dispose: () => input.turns.clear(),
  }
}
