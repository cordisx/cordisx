import { createElement } from 'cordisx/react'
import { HoverCard, type HoverCardProps } from 'cordisx/ui'

const props = {
  trigger: createElement('button', { type: 'button' }, 'Lead'),
  content: createElement('div', undefined, 'Coordinates the room.'),
  placement: 'top',
  'aria-label': 'Lead information',
} as const satisfies HoverCardProps

createElement(HoverCard, props)
