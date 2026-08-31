import * as React from 'react'
import { HostSurfaceIcon } from '../HostSurfaceIcon.js'
import { HostAgentAvatar } from './AgentAvatar.js'
import type { AgentConversationParticipant } from './model.js'

export interface HostRoomCompositeAvatarProps {
  readonly participants: readonly AgentConversationParticipant[]
  readonly size: 'header' | 'compact'
  readonly label: string
  readonly moreLabel: (count: number) => string
  readonly onOpen: () => void
}

/**
 * Host-private raw avatar composition. Only exact AvatarRef-bearing
 * participants enter the visual stack; participant order is never guessed.
 */
export function HostRoomCompositeAvatar({ participants, size, label, moreLabel, onOpen }: HostRoomCompositeAvatarProps) {
  const participantCount = participants.length
  const layout = participantCount === 0 ? 'zero' : participantCount === 1 ? 'one' : participantCount === 2 ? 'two' : participantCount === 3 ? 'three' : 'many'
  const visible = participants.slice(0, participantCount >= 4 ? 3 : participantCount)
  const more = Math.max(0, participantCount - visible.length)
  return <span className="cxa-room-avatar-seat" data-room-avatar-size={size}>
    <button type="button" className="cxa-room-avatar-button" aria-label={label} onClick={onOpen}>
      <span
        className="cxa-room-avatar"
        data-count={layout}
        data-participant-count={participantCount}
        data-avatar-count={participants.filter(participant => participant.avatar !== undefined).length}
      >
        {participantCount === 0
          ? <span className="cxa-room-avatar-fallback"><HostSurfaceIcon token="host:layers" /></span>
          : visible.map((participant, index) => <span key={participant.id} className="cxa-room-avatar-cell" data-index={index} data-participant-id={participant.id}><HostAgentAvatar participant={participant} /></span>)}
      </span>
    </button>
    {more === 0 ? null : <button type="button" className="cxa-room-avatar-more" aria-label={moreLabel(more)} onClick={onOpen}>+{more}</button>}
  </span>
}
