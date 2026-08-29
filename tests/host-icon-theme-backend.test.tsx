import React, { act } from 'react'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRoot } from 'react-dom/client'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import {
  ICON_STATES,
  ICON_VARIANTS,
  SEMANTIC_ICON_KEYS,
  isNormalizedVectorDescriptor,
} from '../packages/cli/src/icon-theme-contracts.js'
import { HostIcon } from '../packages/cli/src/renderer/host-ui/HostIcon.js'
import { HostSurfaceIcon } from '../packages/cli/src/renderer/host-ui/HostSurfaceIcon.js'
import { IconThemeRegistry } from '../packages/cli/src/renderer/icon-theme-registry.js'
import {
  HOST_ICON_16PX_CSS,
  MANAGER_ICON_SEMANTICS,
  bindIconThemeRegistry,
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

function importedModules(source: string): string[] {
  const file = ts.createSourceFile('guard.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const modules: string[] = []
  const add = (node: ts.Expression | undefined): void => {
    if (node !== undefined && ts.isStringLiteralLike(node)) modules.push(node.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) add(node.moduleSpecifier)
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression)
    if (ts.isCallExpression(node)) {
      const dynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword
      const commonJsRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require'
      if (dynamicImport || commonJsRequire) add(node.arguments[0])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return modules
}

function isIconLibrary(moduleName: string): boolean {
  return moduleName === 'reicon' || moduleName.startsWith('reicon/')
    || moduleName === 'tdesign-icons-react' || moduleName.startsWith('@material-symbols')
}

describe('Host Reicon normalized backend', () => {
  it('privately compiles and validates all 1,536 formal Protocol tuples', () => {
    let tuples = 0
    for (const key of SEMANTIC_ICON_KEYS) for (const variant of ICON_VARIANTS) for (const state of ICON_STATES) {
      let descriptor
      try { descriptor = resolveBuiltinReiconDescriptor(key, variant, state) } catch (error) {
        throw new Error(`failed tuple ${key}/${variant}/${state}`, { cause: error })
      }
      expect(isNormalizedVectorDescriptor(descriptor), `${key}/${variant}/${state}`).toBe(true)
      tuples += 1
    }
    expect(tuples).toBe(1536)
  })

  it('renders the complete regular/filled light/dark 16/18/24 visual DOM matrix', () => {
    const dom = new JSDOM('<!doctype html>')
    let rendered = 0
    for (const theme of ['light', 'dark'] as const) for (const size of [16, 18, 24]) {
      for (const key of SEMANTIC_ICON_KEYS) for (const [variant, state] of [['regular', 'default'], ['filled', 'active']] as const) {
        const icon = renderHostIconSvg(dom.window.document, key, { theme, size, variant, state }).svg
        expect(icon.dataset, `${theme}/${size}/${key}/${variant}`).toMatchObject({
          hostIconKey: key,
          hostIconProvider: 'builtin:reicon',
          hostIconFallback: 'none',
          hostIconTheme: theme,
          hostIconState: state,
          hostIconVariant: variant,
        })
        expect(icon.getAttribute('width')).toBe(String(size))
        expect(icon.getAttribute('height')).toBe(String(size))
        expect(icon.getAttribute('aria-hidden')).toBe('true')
        expect(icon.getAttribute('focusable')).toBe('false')
        expect(icon.querySelectorAll('path').length, key).toBeGreaterThan(0)
        rendered += 1
      }
    }
    expect(rendered).toBe(64 * 2 * 3 * 2)
    const newlyFormalKeys = [
      'action.disable', 'action.enable', 'action.export', 'action.favorite', 'action.follow',
      'action.import', 'action.move', 'action.pause', 'action.resume', 'action.submit',
      'agent.turn-control', 'content.acknowledgements', 'content.contributions',
    ] as const
    for (const key of newlyFormalKeys) {
      expect(resolveBuiltinReiconDescriptor(key, 'regular', 'default'), key)
        .not.toEqual(resolveBuiltinReiconDescriptor(key, 'filled', 'active'))
    }
    dom.window.close()
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
    expect(unknown.resolution).toMatchObject({ key: 'provider.private-key', provider: 'host:neutral', fallback: 'neutral' })
    expect(unknown.svg.querySelector('path')).not.toBeNull()
    dom.window.close()
  })

  it('maps every legacy Host surface token to a formal semantic key', () => {
    const tokens = ['analytics', 'back', 'calendar', 'close', 'error', 'files', 'folder', 'history', 'info', 'layers', 'key', 'more', 'new', 'open', 'palette', 'playground', 'refresh', 'reset', 'review', 'settings', 'save', 'clock', 'success', 'warning', 'tags']
    expect(tokens.map(name => hostSurfaceIconKey(`host:${name}`))).not.toContain(undefined)
    expect(hostSurfaceIconKey('host:new')).toBe('action.add')
    expect(hostSurfaceIconKey('host:playground')).toBe('navigation.overview')
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

  it('routes every newly formal Manager semantic to the selected descriptor-only provider', () => {
    const dom = new JSDOM('<!doctype html>')
    const registry = new IconThemeRegistry('host-formal64', 'profile-main')
    const rows = [
      ['move', 'action.move', 'regular', 'default'],
      ['console-export', 'action.export', 'regular', 'default'],
      ['console-follow', 'action.follow', 'regular', 'default'],
      ['console-pause', 'action.pause', 'regular', 'default'],
      ['console-resume', 'action.resume', 'regular', 'default'],
      ['contributions', 'content.contributions', 'regular', 'default'],
      ['acknowledgements', 'content.acknowledgements', 'regular', 'default'],
      ['turns-control', 'agent.turn-control', 'regular', 'default'],
      ['turns-submit', 'action.submit', 'regular', 'default'],
      ['disable-plugin', 'action.disable', 'regular', 'default'],
      ['enable-plugin', 'action.enable', 'regular', 'default'],
      ['favorite', 'action.favorite', 'regular', 'default'],
      ['favorite-active', 'action.favorite', 'filled', 'selected'],
      ['import-plugin', 'action.import', 'regular', 'default'],
    ] as const
    const registration = registry.registerPlugin('register', 0, 'host-formal64', {
      principalHandle: 'ipp_formal6400000001', pluginId: 'formal64', providerGeneration: 'formal64-1',
    }, {
      schemaVersion: 1,
      namespace: 'formal64',
      providerVersion: '1.0.0',
      descriptors: rows.map(([, key, variant, state]) => ({
        key, variant, state, descriptor: resolveBuiltinReiconDescriptor(key, variant, state),
      })),
    }).registration!
    registry.select('select', 1, 'host-formal64', registration.providerHandle, registration.providerGeneration)
    const resolve = vi.spyOn(registry, 'resolve')
    const unbind = bindIconThemeRegistry(dom.window.document, registry)
    try {
      for (const [token, key, variant, state] of rows) {
        expect(MANAGER_ICON_SEMANTICS[token], token).toBe(key)
        const svg = createManagerIcon(dom.window.document, token).querySelector('svg')!
        expect(svg.dataset, token).toMatchObject({
          hostIconProvider: 'plugin:formal64:formal64', hostIconFallback: 'none', hostIconKey: key,
          hostIconVariant: variant, hostIconState: state,
        })
      }
      expect(resolve).toHaveBeenCalledTimes(rows.length)
      expect(resolve.mock.calls.map(([key, variant, state]) => [key, variant, state])).toEqual(
        rows.map(([, key, variant, state]) => [key, variant, state]),
      )
    } finally {
      unbind()
      registry.dispose()
      dom.window.close()
    }
  })

  it('keeps each newly formal semantic glyph distinct from its former provisional alias', () => {
    const pairs = [
      ['action.move', 'content.layers'],
      ['action.export', 'action.open'],
      ['action.follow', 'action.open'],
      ['action.pause', 'status.pending'],
      ['action.resume', 'navigation.runtime'],
      ['content.contributions', 'content.panel'],
      ['content.acknowledgements', 'content.contributions'],
      ['agent.turn-control', 'action.settings'],
      ['action.submit', 'navigation.runtime'],
      ['action.disable', 'status.pending'],
      ['action.enable', 'navigation.runtime'],
      ['action.favorite', 'status.info'],
      ['action.import', 'content.folder'],
    ] as const
    for (const [semantic, formerAlias] of pairs) {
      expect(resolveBuiltinReiconDescriptor(semantic, 'regular', 'default'), `${semantic}/${formerAlias}`)
        .not.toEqual(resolveBuiltinReiconDescriptor(formerAlias, 'regular', 'default'))
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

  it('keeps an unknown React surface token neutral and outside provider routing', async () => {
    const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>')
    const previous = { document: globalThis.document, window: globalThis.window, MutationObserver: globalThis.MutationObserver, IS_REACT_ACT_ENVIRONMENT: globalThis.IS_REACT_ACT_ENVIRONMENT }
    Object.assign(globalThis, { document: dom.window.document, window: dom.window, MutationObserver: dom.window.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true })
    const registry = new IconThemeRegistry('host-react-unknown', 'profile-main')
    const resolve = vi.spyOn(registry, 'resolve')
    const unbind = bindIconThemeRegistry(dom.window.document, registry)
    const root = createRoot(dom.window.document.getElementById('root')!)
    try {
      await act(async () => root.render(<HostSurfaceIcon token={'host:provider-private' as never} />))
      const span = dom.window.document.querySelector('#root > span')!
      const svg = span.querySelector('svg')!
      expect(resolve).not.toHaveBeenCalled()
      expect(svg.dataset).toMatchObject({ hostIconProvider: 'host:neutral', hostIconFallback: 'neutral' })
      expect(svg.dataset.hostIconKey).toBe('host:provider-private')
      expect(span.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('aria-hidden')).toBe('true')
      expect(svg.getAttribute('focusable')).toBe('false')
    } finally {
      await act(async () => root.unmount())
      unbind()
      registry.dispose()
      Object.assign(globalThis, previous)
      dom.window.close()
    }
  })

  it('allows icon-library imports only for Reicon in the private backend', async () => {
    const sourceRoot = path.join(repositoryRoot, 'packages/cli/src')
    const rendererRoot = path.join(repositoryRoot, 'packages/cli/src/renderer')
    const files = await sourceFiles(sourceRoot)
    const violations: string[] = []
    for (const file of files) {
      const source = await readFile(file, 'utf8')
      const relative = path.relative(repositoryRoot, file)
      const imports = importedModules(source).filter(isIconLibrary)
      if (file === path.join(rendererRoot, 'reicon-icon-backend.ts')) {
        if (imports.some(moduleName => moduleName !== 'reicon' && !moduleName.startsWith('reicon/'))) violations.push(relative)
        continue
      }
      if (imports.length > 0) violations.push(relative)
    }
    expect(violations).toEqual([])
  })

  it('discriminates static, dynamic and CommonJS direct icon-library imports', () => {
    const positives = [
      `import { iconData } from 'reicon'`,
      `import\n'reicon/icons'`,
      `const icons = import ( "reicon" )`,
      `const icons = require ( 'reicon/private' )`,
      `import icons = require("reicon")`,
      `export { iconData } from '@material-symbols/svg-400'`,
    ]
    for (const source of positives) expect(importedModules(source).filter(isIconLibrary), source).not.toEqual([])
    const negatives = [
      `const note = "import('reicon')"`,
      `// require('reicon')\nexport const okay = true`,
      `const requireLater = (name: string) => name; requireLater('reicon')`,
      `import { resolveBuiltinReiconDescriptor } from './reicon-icon-backend.js'`,
    ]
    for (const source of negatives) expect(importedModules(source).filter(isIconLibrary), source).toEqual([])
  })
})
