import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { IconButton } from '../packages/cli/src/renderer/host-ui/IconButton.js'

describe('IconButton element semantics', () => {
  it('keeps a disabled action as a native disabled button', () => {
    const markup = renderToStaticMarkup(<IconButton icon="close" label="Clear" disabled />)
    expect(markup).toMatch(/<button\b/)
    expect(markup).toMatch(/\bdisabled(?:="")?/)
    expect(markup).not.toMatch(/<div\b/)
  })

  it('preserves explicit link and tag choices', () => {
    const link = renderToStaticMarkup(<IconButton icon="close" label="Help" href="/help" />)
    const explicit = renderToStaticMarkup(<IconButton icon="close" label="Action" tag="button" />)
    expect(link).toMatch(/<a\b[^>]*href="\/help"/)
    expect(explicit).toMatch(/<button\b/)
  })
})
