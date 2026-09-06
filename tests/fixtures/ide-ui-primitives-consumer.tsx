import { createElement } from 'cordisx/react'
import { HorizontalSplitPane, type HorizontalSplitPaneProps, Icon, type IconName } from 'cordisx/ui'

declare const expanded: boolean

const folderIcon: IconName = expanded ? 'folder-open' : 'folder'
createElement(Icon, { name: folderIcon, 'aria-hidden': true })
createElement(Icon, { name: 'file', 'aria-hidden': true })

const split = {
  initialLeftSize: 270,
  minLeftSize: 220,
  maxLeftSize: 360,
  separatorLabel: 'Prompts',
  left: createElement('nav', undefined, 'Tree'),
  right: createElement('div', { role: 'tabpanel' }, 'Prompt'),
} satisfies HorizontalSplitPaneProps

createElement(HorizontalSplitPane, split)
