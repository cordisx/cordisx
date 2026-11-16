import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { expect, it } from 'vitest'
import { IdentityVisual } from '../packages/cli/src/renderer/host-ui/PublicIdentityVisual.js'
import { cloneRasterImageSnapshot } from '../packages/cli/src/renderer/raster-image.js'

it('uses normalized artwork with a platform badge, then falls back to the platform on image failure', async () => {
  const previous = {
    document: globalThis.document,
    window: globalThis.window,
    MutationObserver: globalThis.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT,
  }
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>')
  Object.assign(globalThis, {
    document: dom.window.document,
    window: dom.window,
    MutationObserver: dom.window.MutationObserver,
    IS_REACT_ACT_ENVIRONMENT: true,
  })
  const root = createRoot(dom.window.document.getElementById('root')!)
  try {
    const avatar = cloneRasterImageSnapshot({
      $schema:
        'https://raw.githubusercontent.com/cordisx/cordisx-protocol/main/schemas/raster-image-snapshot.v1.schema.json',
      contract: 'cordisx.raster-image-snapshot/v1',
      schemaVersion: 1,
      mediaType: 'image/png',
      encoding: 'base64',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==',
      width: 1,
      height: 1,
    })
    await act(async () => root.render(<IdentityVisual icon="host:chat" avatar={avatar} />))
    const img = dom.window.document.querySelector('img')!
    expect(img.src).toMatch(/^data:image\/png;base64,/u)
    expect(dom.window.document.querySelector('.cxr-account-identity-badge')).not.toBeNull()
    await act(async () => img.dispatchEvent(new dom.window.Event('error')))
    expect(dom.window.document.querySelector('img')).toBeNull()
    expect(dom.window.document.querySelector('.cxr-account-identity-platform')).not.toBeNull()
  } finally {
    await act(async () => root.unmount())
    dom.window.close()
    Object.assign(globalThis, previous)
  }
})
