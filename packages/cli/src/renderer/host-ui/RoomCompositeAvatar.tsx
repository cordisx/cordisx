import type { CordisXRoomCompositeAvatarLeadingVisual } from '../../contracts.js'
import * as React from 'react'
import { flushSync } from 'react-dom'
import { createRoot } from 'react-dom/client'
import { HostAgentAvatar } from './conversation/AgentAvatar.js'

type CompositeCategory = '0' | '1' | '2' | '3' | '4+'

function category(count: number): CompositeCategory {
  if (count >= 4) return '4+'
  return String(count) as CompositeCategory
}

function HostRoomCompositeAvatar({ visual }: { readonly visual: CordisXRoomCompositeAvatarLeadingVisual }) {
  const count = visual.participants.length
  const visible = count >= 4 ? visual.participants.slice(0, 3) : visual.participants
  return <span
    className="cxrv-composite"
    aria-hidden="true"
    data-room-composite-count={String(count)}
    data-room-composite-category={category(count)}
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
          }} />
        </span>)}
    {count >= 4 ? <span className="cxrv-overflow">+{count - 3}</span> : null}
  </span>
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
  .cordisx-room-composite-seat { position: relative; display: block; width: 16px; height: 16px; overflow: visible; pointer-events: none; }
  .cxrv-composite { position: absolute; inset: 0; display: block; width: 16px; height: 16px; }
  .cxrv-participant, .cxrv-overflow { position: absolute; display: grid; box-sizing: border-box; place-items: center; overflow: hidden; border: 1px solid var(--color-background-elevated-secondary,var(--color-background-primary,#181818)); border-radius: 50%; background: var(--color-background-primary,#282828); color: var(--color-text-primary,currentColor); }
  .cxrv-participant > .cxa-avatar { display: grid; width: 100%; height: 100%; place-items: center; overflow: hidden; border: 0; border-radius: inherit; background: color-mix(in srgb,var(--color-text-primary,currentColor) 10%,transparent); font: 700 5px/1 system-ui,sans-serif; letter-spacing: 0; }
  .cxrv-participant .cxa-avatar-initials { display: grid; width: 100%; height: 100%; place-items: center; }
  .cxrv-participant .cxa-avatar-renderer, .cxrv-participant .oneworks-avatar, .cxrv-participant .oneworks-avatar svg, .cxrv-participant .oneworks-avatar canvas { display: block; width: 100%; height: 100%; }
  .cxrv-composite[data-room-composite-category="1"] .cxrv-participant { inset: 0; width: 16px; height: 16px; }
  .cxrv-composite[data-room-composite-category="2"] .cxrv-participant { width: 11px; height: 11px; }
  .cxrv-composite[data-room-composite-category="2"] .cxrv-participant[data-participant-slot="0"] { top: 0; left: 0; }
  .cxrv-composite[data-room-composite-category="2"] .cxrv-participant[data-participant-slot="1"] { right: 0; bottom: 0; }
  .cxrv-composite[data-room-composite-category="3"] .cxrv-participant { width: 10px; height: 10px; }
  .cxrv-composite[data-room-composite-category="3"] .cxrv-participant[data-participant-slot="0"] { top: 0; left: 3px; }
  .cxrv-composite[data-room-composite-category="3"] .cxrv-participant[data-participant-slot="1"] { bottom: 0; left: 0; }
  .cxrv-composite[data-room-composite-category="3"] .cxrv-participant[data-participant-slot="2"] { right: 0; bottom: 0; }
  .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant, .cxrv-composite[data-room-composite-category="4+"] .cxrv-overflow { width: 9px; height: 9px; }
  .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant[data-participant-slot="0"] { top: 0; left: 0; }
  .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant[data-participant-slot="1"] { top: 0; right: 0; }
  .cxrv-composite[data-room-composite-category="4+"] .cxrv-participant[data-participant-slot="2"] { bottom: 0; left: 0; }
  .cxrv-overflow { right: 0; bottom: 0; font: 700 5px/1 system-ui,sans-serif; }
  .cxrv-empty { position: absolute; inset: 1px; display: grid; grid-template-columns: repeat(2,1fr); gap: 2px; place-items: center; padding: 2px; border: 1px solid color-mix(in srgb,var(--color-text-tertiary,currentColor) 42%,transparent); border-radius: 50%; }
  .cxrv-empty > i { display: block; width: 2px; height: 2px; border-radius: 50%; background: var(--color-text-tertiary,currentColor); opacity: .75; }
`
