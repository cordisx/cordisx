import React, { act } from 'react'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  ICON_STATES,
  ICON_VARIANTS,
  SEMANTIC_ICON_KEYS,
  isNormalizedVectorDescriptor,
} from '../packages/cli/src/icon-theme-contracts.js'
import { HostIcon } from '../packages/cli/src/renderer/host-ui/HostIcon.js'
import {
  HOST_ICON_16PX_CSS,
  MANAGER_ICON_SEMANTICS,
  createManagerIcon,
  hostSurfaceIconKey,
  renderHostIconSvg,
} from '../packages/cli/src/renderer/icons.js'
import { resolveBuiltinReiconDescriptor } from '../packages/cli/src/renderer/reicon-icon-backend.js'

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  return (await Promise.all(entries.map(async entry => {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'vendor' ? [] : sourceFiles(absolute)
    return /\.tsx?$/u.test(entry.name) ? [absolute] : []
  }))).flat()
}

describe('Host Reicon normalized backend', () => {
  it('privately compiles and validates all 1,224 formal Protocol tuples', () => {
    let tuples = 0
    for (const key of SEMANTIC_ICON_KEYS) for (const variant of ICON_VARIANTS) for (const state of ICON_STATES) {
      let descriptor
      try { descriptor = resolveBuiltinReiconDescriptor(key, variant, state) } catch (error) {
        throw new Error(`failed tuple ${key}/${variant}/${state}`, { cause: error })
      }
      expect(isNormalizedVectorDescriptor(descriptor), `${key}/${variant}/${state}`).toBe(true)
      tuples += 1
    }
    expect(tuples).toBe(1224)
  })

  it('keeps normal geometry regular and reserves filled geometry for explicit active/favorite state', () => {
    const dom = new JSDOM('<!doctype html>')
    const normal = createManagerIcon(dom.window.document, 'favorite').querySelector('svg')!
    const favorite = createManagerIcon(dom.window.document, 'favorite-active').querySelector('svg')!
    const active = createManagerIcon(dom.window.document, 'plugins', undefined, { state: 'active' }).querySelector('svg')!
    expect(normal.dataset.hostIconVariant).toBe('regular')
    expect(favorite.dataset.hostIconVariant).toBe('filled')
    expect(active.dataset.hostIconVariant).toBe('filled')
    expect(normal.innerHTML).not.toBe(favorite.innerHTML)
    dom.window.close()
  })

  it('preserves Reicon compound outline holes instead of filling every contour', () => {
    const compoundOutlineKeys = [
      'action.copy', 'action.search', 'action.settings', 'content.files', 'content.layers',
      'navigation.marketplace', 'navigation.plugins', 'navigation.routes', 'status.info',
    ] as const
    const dom = new JSDOM('<!doctype html>')
    for (const key of compoundOutlineKeys) {
      const descriptor = resolveBuiltinReiconDescriptor(key, 'regular', 'default')
      const compound = descriptor.paths.find(path => path.paint === 'fill'
        && path.fillRule === 'evenodd'
        && path.commands.filter(command => command.op === 'move').length > 1)
      expect(compound, key).toBeDefined()
      expect(compound?.commands.filter(command => command.op === 'close'), key).toHaveLength(1)
      expect(compound?.commands.at(-1)?.op, key).toBe('close')
      const rendered = renderHostIconSvg(dom.window.document, key).svg.querySelector('path[fill-rule="evenodd"]')
      expect(rendered?.getAttribute('d')?.match(/M/gu)?.length, key).toBeGreaterThan(1)
      expect(rendered?.getAttribute('d')?.match(/Z/gu), key).toHaveLength(1)
    }
    dom.window.close()
  })

  it('keeps size, theme, a11y, color and pointer policy Host-owned', () => {
    const dom = new JSDOM('<!doctype html><html class="electron-light"><body></body></html>')
    const light = createManagerIcon(dom.window.document, 'search', undefined, { size: 20 })
    const lightSvg = light.querySelector('svg')!
    expect(lightSvg.dataset.hostIconTheme).toBe('light')
    expect(lightSvg.dataset.hostIconProvider).toBe('builtin:reicon')
    expect(lightSvg.getAttribute('width')).toBe('20')
    expect(lightSvg.getAttribute('height')).toBe('20')
    expect(lightSvg.getAttribute('aria-hidden')).toBe('true')
    expect(lightSvg.getAttribute('focusable')).toBe('false')
    expect(lightSvg.getAttribute('draggable')).toBe('false')
    expect(light.getAttribute('aria-hidden')).toBe('true')
    expect(HOST_ICON_16PX_CSS).toContain('pointer-events: none')
    expect(HOST_ICON_16PX_CSS).toContain('color: currentColor')
    dom.window.document.documentElement.className = 'electron-dark'
    expect(createManagerIcon(dom.window.document, 'search').querySelector('svg')?.dataset.hostIconTheme).toBe('dark')
    dom.window.close()
  })

  it('uses a Host neutral descriptor for an unknown key', () => {
    const dom = new JSDOM('<!doctype html>')
    const unknown = renderHostIconSvg(dom.window.document, 'provider.private-key')
    expect(unknown.resolution).toMatchObject({ key: 'control.minus', provider: 'host:neutral', fallback: 'neutral' })
    expect(unknown.svg.querySelector('path')).not.toBeNull()
    dom.window.close()
  })

  it('maps every legacy Host surface token to a formal semantic key', () => {
    const tokens = ['analytics', 'back', 'calendar', 'close', 'error', 'files', 'folder', 'history', 'info', 'layers', 'key', 'more', 'open', 'palette', 'refresh', 'reset', 'review', 'settings', 'save', 'clock', 'success', 'warning', 'tags']
    expect(tokens.map(name => hostSurfaceIconKey(`host:${name}`))).not.toContain(undefined)
    expect(hostSurfaceIconKey('host:unknown')).toBeUndefined()
  })

  it('keeps simultaneous marketplace trust semantics and glyphs distinct', () => {
    expect(MANAGER_ICON_SEMANTICS['marketplace-certified']).toBe('trust.certified')
    expect(MANAGER_ICON_SEMANTICS['marketplace-official']).toBe('trust.official')
    for (const variant of ICON_VARIANTS) {
      const certified = resolveBuiltinReiconDescriptor('trust.certified', variant, 'default')
      const official = resolveBuiltinReiconDescriptor('trust.official', variant, 'default')
      expect(certified, variant).not.toEqual(official)
    }
  })

  it('uses the same normalized geometry for React and imperative DOM', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
    const previous = { document: globalThis.document, window: globalThis.window, MutationObserver: globalThis.MutationObserver, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
    Object.assign(globalThis, { document: dom.window.document, window: dom.window, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => root.render(<HostIcon token="routes" />))
      const reactSvg = dom.window.document.querySelector('#root svg')!
      const imperativeSvg = createManagerIcon(dom.window.document, 'routes').querySelector('svg')!
      expect(reactSvg.querySelector('path')?.getAttribute('d')).toBe(imperativeSvg.querySelector('path')?.getAttribute('d'))
      expect(reactSvg.dataset.hostIconKey).toBe(imperativeSvg.dataset.hostIconKey)
    } finally {
      await act(async () => root.unmount())
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })

  it('allows icon-library imports only for Reicon in the private backend', async () => {
    const rendererRoot = path.join(repositoryRoot, 'packages/cli/src/renderer')
    const files = await sourceFiles(rendererRoot)
    const violations: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const relative = path.relative(repositoryRoot, file)
      if (file === path.join(rendererRoot, 'reicon-icon-backend.ts')) {
        if (/from ['"](?:tdesign-icons-react|@material-symbols[^'"]*)['"]/u.test(source)) violations.push(relative)
        continue
      }
      if (/from ['"](?:reicon(?:\/[^'"]*)?|tdesign-icons-react|@material-symbols[^'"]*)['"]/u.test(source)) violations.push(relative)
    }
    expect(violations).toEqual([])
  })
})
