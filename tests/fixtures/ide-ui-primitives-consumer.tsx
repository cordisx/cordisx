import { createElement, createRef } from 'cordisx/react'
import {
  HorizontalSplitPane,
  type HorizontalSplitPaneProps,
  Icon,
  type IconName,
  PanZoomCanvas,
  type PanZoomCanvasHandle,
  Select,
} from 'cordisx/ui'

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

const canvas = createRef<PanZoomCanvasHandle>()
createElement(PanZoomCanvas, {
  'aria-label': 'Team structure',
  fill: true,
  controllerRef: canvas,
  minScale: 0.4,
  maxScale: 2,
  children: createElement('div', undefined, 'Tree'),
})
canvas.current?.fitToView()
canvas.current?.reset()
canvas.current?.getScale()

createElement(Select, {
  'aria-label': 'Role',
  value: 'all',
  density: 'compact',
  prefixIcon: createElement(Icon, { name: 'role' }),
  options: [{ value: 'all', label: 'All roles' }],
  onChange: () => {},
})
const semanticIcons: readonly IconName[] = ['role', 'session', 'relationship']
semanticIcons.map(name => createElement(Icon, { name }))
