import React, { act } from 'react'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { buildManagerStyles } from '../packages/cli/scripts/build-manager-styles.mjs'
import { installStandaloneManager } from '../packages/cli/src/renderer/manager/install-standalone.js'
import { managerModel, reactManagerFixture } from './helpers/react-manager.js'

vi.mock('../packages/cli/src/renderer/host-ui/BrandMark.js', () => ({
  BrandMark: () => <span />,
  createBrandMarkElement: (document: Document) => document.createElement('span'),
}))

it('builds the Host styles in their existing order with the standalone shell last', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'cx-manager-style-test-'))
  try {
    const output = path.join(directory, 'manager-host.css')
    await buildManagerStyles(output)
    const actual = await readFile(output, 'utf8')
    const root = 'packages/cli/src/renderer/manager'
    const ordered = await Promise.all([
      'manager-navigation.css',
      'manager-content.css',
      'manager-compact-shell.css',
      'manager-browse.css',
      'manager-standalone.css',
    ].map(file => readFile(path.join(root, file), 'utf8')))
    let previous = -1
    for (const css of ordered) {
      const position = actual.indexOf(css, previous + 1)
      expect(position).toBeGreaterThan(previous)
      previous = position
    }
    expect(actual.endsWith(ordered.at(-1)!)).toBe(true)
    await buildManagerStyles(output)
    expect(await readFile(output, 'utf8')).toBe(actual)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 30_000)

it('uses only the fixed same-origin stylesheet for an external standalone shell', async () => {
  const fixture = reactManagerFixture()
  let dispose: (() => void) | undefined
  try {
    expect(() =>
      installStandaloneManager(fixture.document, managerModel(), {
        standaloneStyleHref: 'https://example.test/unsafe.css' as '/manager-host.css',
      })
    ).toThrow('fixed same-origin asset')
    await act(async () => {
      dispose = installStandaloneManager(fixture.document, managerModel(), { standaloneStyleHref: '/manager-host.css' })
    })
    const asset = fixture.document.getElementById('cordisx-react-manager-style') as HTMLLinkElement
    expect(asset.tagName).toBe('LINK')
    expect(asset.getAttribute('rel')).toBe('stylesheet')
    expect(asset.getAttribute('href')).toBe('/manager-host.css')
    expect(fixture.document.querySelector('[data-manager-surface="standalone"] [data-unified-plugins-page]'))
      .not.toBeNull()
    await act(async () => dispose?.())
    dispose = undefined
    expect(fixture.document.getElementById('cordisx-react-manager-style')).toBeNull()
  } finally {
    await act(async () => dispose?.())
    await fixture.dispose()
  }
})
