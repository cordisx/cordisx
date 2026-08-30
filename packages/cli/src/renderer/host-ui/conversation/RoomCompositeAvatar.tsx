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
  const avatarParticipants = participants.filter(participant => participant.avatar !== undefined)
  const count = avatarParticipants.length
  const layout = count === 0 ? 'zero' : count === 1 ? 'one' : count === 2 ? 'two' : count === 3 ? 'three' : 'many'
  const visible = count >= 4 ? avatarParticipants.slice(0, 3) : avatarParticipants
  const more = Math.max(0, count - 3)
  return <span className="cxa-room-avatar-seat" data-room-avatar-size={size}>
    <button type="button" className="cxa-room-avatar-button" aria-label={label} onClick={onOpen}>
      <span
        className="cxa-room-avatar"
        data-count={layout}
        data-participant-count={participants.length}
        data-avatar-count={count}
      >
        {count === 0
          ? <span className="cxa-room-avatar-fallback"><HostSurfaceIcon token="host:layers" /></span>
          : visible.map((participant, index) => <span key={participant.id} className="cxa-room-avatar-cell" data-index={index} data-participant-id={participant.id}><HostAgentAvatar participant={participant} /></span>)}
      </span>
    </button>
    {more === 0 ? null : <button type="button" className="cxa-room-avatar-more" aria-label={moreLabel(more)} onClick={onOpen}>+{more}</button>}
  </span>
}
