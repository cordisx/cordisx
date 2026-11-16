import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { AccountIdentityVisual } from '../packages/cli/src/renderer/host-ui/AccountIdentityVisual.js'
import { assertManagerCollectionVisual } from '../packages/cli/src/renderer/manager-collection-visual.js'
import { REACT_MANAGER_STYLES } from '../packages/cli/src/renderer/manager/styles.js'
import { cssDeclarations } from './helpers/css-declarations.js'

const image = {
  $schema:
    'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
  contract: 'cordisx.raster-image-snapshot/v1',
  schemaVersion: 1,
  mediaType: 'image/png',
  encoding: 'base64',
  width: 1,
  height: 1,
  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
} as const

it('keeps identity visuals versioned and validates avatar bytes before rendering', () => {
  const visual = { kind: 'identity', icon: 'host:chat', avatar: image } as const
  expect(() => assertManagerCollectionVisual(visual, 'connection', 2)).not.toThrow()
  expect(() => assertManagerCollectionVisual(visual, 'connection', 1)).toThrow('kind')
  expect(() => assertManagerCollectionVisual({ ...visual, avatar: { ...image, width: 2 } }, 'connection', 2)).toThrow()
  expect(() => assertManagerCollectionVisual({ ...visual, url: 'https://example.test' } as never, 'connection', 2))
    .toThrow('unknown')
})

it('renders a decorative avatar with lower-right platform badge and falls back after image failure', async () => {
  const dom = new JSDOM('<!doctype html><body><button aria-label="Account"><span id="root"></span></button>')
  const keys = [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'MutationObserver',
    'IS_REACT_ACT_ENVIRONMENT',
  ] as const
  const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  Object.assign(globalThis, {
    window: dom.window,
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    Element: dom.window.Element,
    Node: dom.window.Node,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const container = dom.window.document.getElementById('root')!
  const root = createRoot(container)
  try {
    await act(async () => root.render(<AccountIdentityVisual icon="host:chat" avatar={image} />))
    const avatar = container.querySelector<HTMLImageElement>('.cxr-account-identity-avatar')!
    expect(avatar.alt).toBe('')
    expect(container.querySelector('.cxr-account-identity-badge')).not.toBeNull()
    expect(container.querySelector('.cxr-account-identity')?.getAttribute('aria-hidden')).toBe('true')
    expect(cssDeclarations(REACT_MANAGER_STYLES, '.cxr-account-identity-badge')).toMatchObject({
      position: 'absolute',
      right: '-3px',
      bottom: '-3px',
    })
    await act(async () => avatar.dispatchEvent(new dom.window.Event('error')))
    expect(container.querySelector('.cxr-account-identity-avatar')).toBeNull()
    expect(container.querySelector('.cxr-account-identity-badge')).toBeNull()
    expect(container.querySelector('.cxr-account-identity-platform')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
    dom.window.close()
  }
})
