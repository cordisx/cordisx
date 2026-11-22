import type { ConversationContinuationPreferenceV1 } from '@cordisx/protocol/conversation-continuation/v1'
import type { LogicalContinuationState } from './logical-continuation-control.js'

type Scope = ConversationContinuationPreferenceV1['scope']
type Mode = ConversationContinuationPreferenceV1['mode']
const key = (scope: Scope) => JSON.stringify([scope.kind, scope.id])
const validScope = (scope: Scope) =>
  scope && ['profile', 'project', 'conversation'].includes(scope.kind)
  && typeof scope.id === 'string' && scope.id.length > 0 && scope.id.length <= 512
  && !/[\u0000-\u001f\u007f]/u.test(scope.id) && Object.keys(scope).every(field => ['kind', 'id'].includes(field))

/** A preference selects a mode; it never grants history or checkpoint consent. */
export function setLogicalContinuationPreference(
  state: LogicalContinuationState,
  scope: Scope,
  mode: Mode | null,
  expectedRevision: number,
) {
  if (
    !validScope(scope) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0
    || expectedRevision >= Number.MAX_SAFE_INTEGER || mode !== null && !['linked', 'fork'].includes(mode)
  ) {
    throw new Error('INVALID_CONTINUATION_PREFERENCE')
  }
  const id = key(scope)
  if ((state.preferenceRevisions?.[id] ?? 0) !== expectedRevision) throw new Error('REVISION_CONFLICT')
  const preferences = state.preferences ??= {}, revisions = state.preferenceRevisions ??= {}
  revisions[id] = expectedRevision + 1
  if (mode === null) {
    delete preferences[id]
    return undefined
  }
  const result: ConversationContinuationPreferenceV1 = {
    contract: 'cordisx.conversation-continuation-preference/v1',
    revision: expectedRevision + 1,
    scope: structuredClone(scope),
    mode,
  }
  preferences[id] = result
  return structuredClone(result)
}
export function logicalPreferenceRevision(state: LogicalContinuationState, scope: Scope): number {
  if (!validScope(scope)) throw new Error('INVALID_CONTINUATION_PREFERENCE')
  return state.preferenceRevisions?.[key(scope)] ?? 0
}

export function resolveLogicalContinuationPreference(
  state: LogicalContinuationState,
  scope: { readonly profileId: string; readonly projectId?: string; readonly conversationId?: string },
) {
  const scopes: Scope[] = [
    ...(scope.conversationId ? [{ kind: 'conversation' as const, id: scope.conversationId }] : []),
    ...(scope.projectId ? [{ kind: 'project' as const, id: scope.projectId }] : []),
    { kind: 'profile', id: scope.profileId },
  ]
  if (scopes.some(value => !validScope(value))) throw new Error('INVALID_CONTINUATION_PREFERENCE')
  const preference = scopes.map(value => state.preferences?.[key(value)]).find(value => value !== undefined)
  return preference && structuredClone(preference)
}
