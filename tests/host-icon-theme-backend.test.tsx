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
  PENDING_MANAGER_ICON_TOKENS,
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
    expect(unknown.resolution).toMatchObject({ key: 'provider.private-key', provider: 'host:neutral', fallback: 'neutral' })
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

  it('keeps every pending Manager token on the Host-private builtin path', () => {
    const dom = new JSDOM('<!doctype html>')
    const registry = new IconThemeRegistry('host-pending', 'profile-main')
    const registration = registry.registerPlugin('register', 0, 'host-pending', {
      principalHandle: 'ipp_pending000000001', pluginId: 'pending', providerGeneration: 'pending-1',
    }, {
      schemaVersion: 1,
      namespace: 'pending',
      providerVersion: '1.0.0',
      descriptors: [{
        key: 'content.layers', variant: 'regular', state: 'default',
        descriptor: resolveBuiltinReiconDescriptor('content.layers', 'regular', 'default'),
      }],
    }).registration!
    registry.select('select', 1, 'host-pending', registration.providerHandle, registration.providerGeneration)
    const resolve = vi.spyOn(registry, 'resolve')
    const unbind = bindIconThemeRegistry(dom.window.document, registry)
    try {
      for (const token of PENDING_MANAGER_ICON_TOKENS) {
        expect(MANAGER_ICON_SEMANTICS[token], token).toBeUndefined()
        const svg = createManagerIcon(dom.window.document, token).querySelector('svg')!
        expect(svg.dataset.hostIconProvider, token).toBe('builtin:reicon')
        expect(svg.dataset.hostIconFallback, token).toBe('reicon')
        expect(svg.dataset.hostIconKey, token).toBe(token)
      }
      expect(resolve).not.toHaveBeenCalled()
      registry.rollback(
        'rollback-failed', 2, 'host-pending', registration.providerHandle, registration.providerGeneration,
        registry.builtinProviderHandle, 'reicon-stale',
      )
      const neutral = createManagerIcon(dom.window.document, 'move').querySelector('svg')!
      expect(neutral.dataset).toMatchObject({ hostIconProvider: 'host:neutral', hostIconFallback: 'neutral' })
      expect(resolve).not.toHaveBeenCalled()
    } finally {
      unbind()
      registry.dispose()
      dom.window.close()
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
