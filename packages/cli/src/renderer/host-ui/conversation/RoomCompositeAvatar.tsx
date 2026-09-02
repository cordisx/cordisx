import * as React from 'react'
import {
  createHostRoomCompositeAvatarProjection,
  HostRoomCompositeAvatarStack,
} from '../RoomCompositeAvatar.js'
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
  const projection = createHostRoomCompositeAvatarProjection(participants.map(participant => ({
    participantId: participant.id,
    ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
  })))
  return <span className="cxa-room-avatar-seat" data-room-avatar-size={size}>
    <button type="button" className="cxa-room-avatar-button" aria-label={label} onClick={onOpen}>
      <HostRoomCompositeAvatarStack projection={projection} size={size} renderOverflow={false} />
    </button>
    {projection.overflow === 0 ? null : <button type="button" className="cxa-room-avatar-more" aria-label={moreLabel(projection.overflow)} onClick={onOpen}>+{projection.overflow}</button>}
  </span>
}
