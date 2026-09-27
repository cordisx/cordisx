import React from 'react'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EmptyState } from '../packages/cli/src/renderer/host-ui/EmptyState.js'
import {
  type EmptyStateFamily,
  emptyStateIllustrations,
} from '../packages/cli/src/renderer/host-ui/empty-state-illustrations.js'
import { reactManagerFixture } from './helpers/react-manager.js'

const assetRoot = new URL('../packages/cli/assets/illustrations/empty-state/v4-flat/', import.meta.url)
const receipt = JSON.parse(readFileSync(new URL('receipt.json', assetRoot), 'utf8'))

// Exercise Vite's real ?raw/?inline imports. A stubbed CSS module misses lost animation rules.
describe('approved Host empty-state artwork', () => {
  it('loads every original pair through the renderer and preserves the receipt and full static scene', () => {
    expect(Object.keys(emptyStateIllustrations)).toHaveLength(10)
    expect(receipt.files).toHaveLength(20)
    for (const [family, asset] of Object.entries(emptyStateIllustrations)) {
      for (const extension of ['svg', 'css']) {
        const file = `${family}.${extension}`
        const bytes = readFileSync(new URL(file, assetRoot))
        const expected = receipt.files.find((entry: { file: string }) => entry.file === file)
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected.sha256)
        expect(bytes.length).toBe(expected.bytes)
      }
      expect(asset.markup).toContain('viewBox="0 0 320 180"')
      expect(asset.markup).not.toMatch(/<script|<foreignObject|linearGradient|radialGradient|<filter/u)
      expect(asset.styles).toContain('@keyframes')
      expect(asset.styles).toMatch(/prefers-reduced-motion:\s*reduce/u)
      expect(asset.styles).toMatch(/animation:\s*none/u)
    }
  })

  it('inherits every exact owner light/dark variable from the production theme stylesheet', () => {
    const css = readFileSync(
      new URL('../packages/cli/src/renderer/host-ui/empty-state-illustration-theme.css', import.meta.url),
      'utf8',
    ).replace(/\s+/gu, ' ')
    for (
      const [family, theme] of Object.entries(receipt.ownerThemes) as [
        string,
        Record<string, { color: string; variableValues: Record<string, string> }>,
      ][]
    ) {
      for (const mode of ['light', 'dark']) {
        const selector = `${
          mode === 'dark' ? '[data-cordisx-app-theme="dark"] ' : ''
        }.cxh-empty-illustration[data-empty-family="${family}"]`
        const block = css.slice(css.indexOf(selector), css.indexOf('}', css.indexOf(selector)))
        expect(block).toContain(`color: ${theme[mode].color};`)
        for (const [variable, value] of Object.entries(theme[mode].variableValues)) {
          expect(block).toContain(`${variable}: ${value};`)
        }
      }
    }
  })

  it('retains SVG DOM across loading, empty, search and theme updates, and never renders a loading action', async () => {
    const fixture = reactManagerFixture()
    const action = { label: 'Create', onClick: () => {} }
    try {
      await fixture.render(
        <EmptyState icon="plugins" family="plugins" state="loading" title="Loading" action={action} />,
      )
      const svg = fixture.element('[data-empty-family="plugins"] svg')
      expect(fixture.element('[data-empty-state]').querySelector('button')).toBeNull()
      await fixture.render(<EmptyState icon="plugins" family="plugins" title="Empty" action={action} />)
      expect(fixture.element('[data-empty-family="plugins"] svg')).toBe(svg)
      fixture.document.getElementById('root')!.dataset.cordisxAppTheme = 'dark'
      await fixture.render(<EmptyState icon="plugins" family="plugins" state="search" title="No matches" />)
      expect(fixture.element('[data-empty-family="plugins"] svg')).toBe(svg)
      expect(fixture.element('[data-empty-family="plugins"]').dataset.emptySearch).toBe('true')
    } finally {
      await fixture.dispose()
    }
  })

  it('uses compact geometry for local states for every family without inserting a hero', async () => {
    const fixture = reactManagerFixture()
    try {
      for (const family of Object.keys(emptyStateIllustrations) as EmptyStateFamily[]) {
        await fixture.render(<EmptyState icon="plugins" family={family} presentation="compact" title="Local status" />)
        expect(fixture.element('[data-empty-state]').dataset.emptyPresentation).toBe('compact')
        expect(fixture.element('[data-empty-family]').dataset.emptySize).toBe('compact')
        expect(fixture.element('[data-empty-family]').getAttribute('aria-hidden')).toBe('true')
      }
    } finally {
      await fixture.dispose()
    }
  })
})
