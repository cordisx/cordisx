import {
  CORDISX_ROOM_COMPOSITE_AVATAR_MAX_PARTICIPANTS,
  type CordisXRoomCompositeAvatarLeadingVisual,
} from '../../contracts.js'
import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { HostAgentAvatar } from './conversation/AgentAvatar.js'

type CompositeCategory = '0' | '1' | '2' | '3' | '4+'
type CompositeParticipant = CordisXRoomCompositeAvatarLeadingVisual['participants'][number]

export type HostRoomCompositeAvatarSize = 'navigation' | 'compact' | 'header'

export interface HostRoomCompositeAvatarProjection {
  readonly participants: readonly CompositeParticipant[]
  readonly visible: readonly CompositeParticipant[]
  readonly count: number
  readonly overflow: number
  readonly category: CompositeCategory
}

function category(count: number): CompositeCategory {
  if (count >= 4) return '4+'
  return String(count) as CompositeCategory
}

/** One ordered/capped raw AvatarRef projection shared by every Host Room surface. */
export function createHostRoomCompositeAvatarProjection(
  input: readonly CompositeParticipant[],
): HostRoomCompositeAvatarProjection {
  // The collection contract permits participants without an AvatarRef.  A
  // Room row must remain raw supplied avatar artwork, so omit those entries
  // rather than rendering a generated initials tile in a group composition.
  const participantIds = new Set<string>()
  const participants = input.filter(participant => {
    if (participant.avatar === undefined || participantIds.has(participant.participantId)) return false
    participantIds.add(participant.participantId)
    return true
  }).slice(0, CORDISX_ROOM_COMPOSITE_AVATAR_MAX_PARTICIPANTS)
  const count = participants.length
  const visible = count >= 4 ? participants.slice(0, 3) : participants
  return Object.freeze({
    participants: Object.freeze(participants),
    visible: Object.freeze(visible),
    count,
    overflow: Math.max(0, count - visible.length),
    category: category(count),
  })
}

/** Host-owned raw stack; callers may change only the explicit size token. */
export function HostRoomCompositeAvatarStack({
  projection,
  size,
  renderOverflow = true,
}: {
  readonly projection: HostRoomCompositeAvatarProjection
  readonly size: HostRoomCompositeAvatarSize
  readonly renderOverflow?: boolean
}) {
  const { count, visible, overflow } = projection
  return <span
    className="cxrv-composite"
    aria-hidden="true"
    data-room-composite-count={String(count)}
    data-room-composite-category={projection.category}
    data-room-composite-size={size}
  >
    {count === 0
      ? <span className="cxrv-empty">{[0, 1, 2, 3].map(index => <i key={index} />)}</span>
      : visible.map((participant, index) => <span
          className="cxrv-participant"
          data-participant-slot={String(index)}
          key={participant.participantId}
        >
          <HostAgentAvatar participant={{
            id: participant.participantId,
            role: 'agent',
            name: participant.participantId,
            ...(participant.avatar === undefined ? {} : { avatar: participant.avatar }),
          }} fallback="neutral" />
        </span>)}
    {!renderOverflow || overflow === 0 ? null : <span className="cxrv-overflow">+{overflow}</span>}
  </span>
}

function HostRoomCompositeAvatar({ visual }: { readonly visual: CordisXRoomCompositeAvatarLeadingVisual }) {
  return <HostRoomCompositeAvatarStack
    projection={createHostRoomCompositeAvatarProjection(visual.participants)}
    size="navigation"
  />
}

export function mountHostRoomCompositeAvatar(
  container: HTMLElement,
  visual: CordisXRoomCompositeAvatarLeadingVisual,
): () => void {
  const root = createRoot(container)
  flushSync(() => root.render(<HostRoomCompositeAvatar visual={visual} />))
  return () => root.unmount()
}

export const HOST_ROOM_COMPOSITE_AVATAR_STYLES = String.raw`
  .cordisx-nav-primary > .cordisx-room-composite-seat.cxsi-icon { position: relative; display: block; box-sizing: border-box; flex: 0 0 16px; width: 16px; min-width: 16px; max-width: 16px; height: 16px; min-height: 16px; max-height: 16px; gap: 0px; margin: 0; padding: 0; overflow: hidden; border: 0; border-radius: 0; background: transparent; box-shadow: none; color: inherit; font-size: 0; line-height: 0; pointer-events: none; }
  .cxrv-composite { --cxrv-size: 38px; position: relative; display: block; box-sizing: border-box; flex: none; width: var(--cxrv-size); min-width: var(--cxrv-size); max-width: var(--cxrv-size); height: var(--cxrv-size); min-height: var(--cxrv-size); max-height: var(--cxrv-size); gap: 0; margin: 0; padding: 0; overflow: hidden; border: 0; border-radius: 0; background: transparent; box-shadow: none; }
  .cxrv-composite[data-room-composite-size="navigation"] { --cxrv-size: 16px; }
  .cxrv-composite[data-room-composite-size="compact"] { --cxrv-size: 28px; }
  .cxrv-composite[data-room-composite-size="header"] { --cxrv-size: 38px; }
  .cordisx-room-composite-seat > .cxrv-composite { position: absolute; inset: 0; }
  .cxrv-participant, .cxrv-overflow { position: absolute; display: grid; box-sizing: border-box; place-items: center; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--cx-surface-raised,var(--color-background-elevated-secondary,var(--color-background-primary,#181818))); border-radius: 50%; background: var(--cx-surface,var(--color-background-primary,#282828)); box-shadow: none; color: var(--cx-text,var(--color-text-primary,currentColor)); }
  .cxrv-participant > .cxa-avatar { display: grid; width: 100%; height: 100%; place-items: center; overflow: hidden; border: 0; border-radius: inherit; background: color-mix(in srgb,var(--color-text-primary,currentColor) 10%,transparent); font: 700 5px/1 system-ui,sans-serif; letter-spacing: 0; }
  .cxrv-participant .cxa-avatar-initials { display: grid; width: 100%; height: 100%; place-items: center; }
  .cxrv-participant .cxa-avatar-renderer, .cxrv-participant .oneworks-avatar, .cxrv-participant .oneworks-avatar svg, .cxrv-participant .oneworks-avatar canvas { display: block; width: 100%; height: 100%; }
  .cxrv-composite[data-room-composite-category="1"] .cxrv-participant { inset: 0; width: 100%; height: 100%; }
  .cxrv-composite[data-room-composite-category="2"] .cxrv-participant, .cxrv-composite[data-room-composite-category="3"] .cxrv-participant, .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant, .cxrv-composite[data-room-composite-category="4+"] .cxrv-overflow { width: 60.526315%; height: 60.526315%; }
  .cxrv-composite[data-room-composite-category="2"] .cxrv-participant[data-participant-slot="0"] { top: 21.052632%; left: 2.631579%; z-index: 1; }
  .cxrv-composite[data-room-composite-category="2"] .cxrv-participant[data-participant-slot="1"] { top: 21.052632%; right: 2.631579%; z-index: 2; }
  .cxrv-composite[data-room-composite-category="3"] .cxrv-participant[data-participant-slot="0"] { top: 0; left: 21.052632%; z-index: 3; }
  .cxrv-composite[data-room-composite-category="3"] .cxrv-participant[data-participant-slot="1"] { bottom: 0; left: 0; }
  .cxrv-composite[data-room-composite-category="3"] .cxrv-participant[data-participant-slot="2"] { right: 0; bottom: 0; }
  .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant[data-participant-slot="0"] { top: 0; left: 0; z-index: 3; }
  .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant[data-participant-slot="1"] { top: 0; right: 0; z-index: 4; }
  .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant[data-participant-slot="2"] { bottom: 0; left: 0; }
  .cxrv-overflow { right: 0; bottom: 0; font: 700 calc(var(--cxrv-size) * .21)/1 system-ui,sans-serif; }
  .cxrv-empty { position: absolute; inset: 1px; display: grid; grid-template-columns: repeat(2,1fr); gap: 2px; place-items: center; padding: 2px; border: 1px solid color-mix(in srgb,var(--color-text-tertiary,currentColor) 42%,transparent); border-radius: 50%; }
  .cxrv-empty > i { display: block; width: 12.5%; height: 12.5%; border-radius: 50%; background: var(--cx-muted,var(--color-text-tertiary,currentColor)); opacity: .75; }
`
