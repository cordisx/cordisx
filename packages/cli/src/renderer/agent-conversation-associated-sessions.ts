import { agentLoopHandle, exactKeys, opaque, plainObject } from './agent-conversation-shell-validation.js'

/** Validate persisted correlation without assigning a live lifecycle or execution authority. */
export function assertAssociatedSessions(value: unknown, participants: unknown, activeRuns: unknown): void {
  if (value === undefined) return
  if (!Array.isArray(value) || value.length > 64 || !Array.isArray(participants)) {
    throw new Error('Associated Sessions are invalid')
  }
  const agents = new Set(
    participants.filter(participant => participant.role === 'agent' && participant.agentIdentity !== undefined).map(
      participant => participant.participantId,
    ),
  )
  if (activeRuns !== undefined && !Array.isArray(activeRuns)) throw new Error('Active runs are invalid')
  const sessions = new Set<unknown>((activeRuns ?? []).map((run: { sessionId?: string }) => run.sessionId))
  for (const entry of value) {
    plainObject(entry, 'associated Session')
    exactKeys(entry, ['participantId', 'memberId', 'runId', 'sessionId', 'state', 'details'], 'associated Session')
    for (const field of ['participantId', 'memberId', 'runId', 'sessionId']) opaque(entry[field], field)
    if (entry.state !== 'unloaded' || !agents.has(entry.participantId)) {
      throw new Error('Associated Session participant or state is invalid')
    }
    if (sessions.has(entry.sessionId)) throw new Error('Associated Session duplicates a live or persisted Session')
    sessions.add(entry.sessionId)
    if (entry.details !== undefined) {
      plainObject(entry.details, 'associated Session details')
      exactKeys(entry.details, ['kind', 'ref'], 'associated Session details')
      if (entry.details.kind !== 'host') throw new Error('Associated Session details must be Host-issued')
      agentLoopHandle(entry.details.ref, 'associated Session details ref')
    }
  }
}
