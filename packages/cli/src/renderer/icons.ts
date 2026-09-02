import {
  isSemanticIconKey,
  type IconState,
  type IconVariant,
  type NormalizedVectorCommand,
  type NormalizedVectorDescriptor,
  type SemanticIconKey,
} from '../icon-theme-contracts.js'
import {
  BUILTIN_HOST_SURFACE_ICON_KEYS,
  resolveBuiltinHostSurfaceIconDescriptor,
  resolveBuiltinReiconDescriptor,
  type BuiltinHostSurfaceIconKey,
} from './reicon-icon-backend.js'
import { resolveHostTheme, type HostAppTheme } from './host-theme.js'
import type { IconThemeRegistry } from './icon-theme-registry.js'

const documentRegistries = new WeakMap<Document, IconThemeRegistry>()

export function bindIconThemeRegistry(document: Document, registry: IconThemeRegistry): () => void {
  documentRegistries.set(document, registry)
  return () => { if (documentRegistries.get(document) === registry) documentRegistries.delete(document) }
}

export function iconThemeRegistryForDocument(document: Document): IconThemeRegistry | undefined {
  return documentRegistries.get(document)
}

export const MANAGER_ICON_TOKENS = [
  'add', 'back', 'capability-fallback', 'close', 'configuration', 'copy', 'delete', 'edit', 'move', 'console-clear', 'console-copy',
  'console-export', 'console-follow', 'console-pause', 'console-resume', 'contributions', 'acknowledgements',
  'diagnostics', 'document', 'external-link', 'launcher', 'marketplace', 'marketplace-certified',
  'marketplace-official', 'marketplace-source-add', 'marketplace-source-copy',
  'marketplace-source-edit', 'marketplace-source-move-down', 'marketplace-source-move-up',
  'models-read', 'outlets', 'overview', 'permissions', 'plugins', 'point-info', 'routes',
  'runtime', 'search', 'settings', 'tasks-catalog-read', 'tasks-content-read', 'tasks-control',
  'tasks-create', 'turns-control', 'turns-submit', 'authors-source', 'disable-plugin',
  'enable-plugin', 'favorite', 'favorite-active', 'import-plugin', 'more', 'reload-plugin',
  'reset-configuration', 'save-configuration', 'share-plugin', 'uninstall-plugin',
] as const

export type ManagerIconToken = typeof MANAGER_ICON_TOKENS[number]
export type HostIconKey = SemanticIconKey
export type HostIconState = 'default' | 'active' | 'favorite'

/** Existing Host chrome terms map explicitly into Protocol v1 semantics. */
export const MANAGER_ICON_SEMANTICS: Readonly<Partial<Record<ManagerIconToken, SemanticIconKey>>> = Object.freeze({
  add: 'action.add',
  back: 'action.back',
  'capability-fallback': 'status.info',
  close: 'action.close',
  configuration: 'action.settings',
  copy: 'action.copy',
  delete: 'action.delete',
  edit: 'action.edit',
  move: 'action.move',
  'console-clear': 'action.delete',
  'console-copy': 'action.copy',
  'console-export': 'action.export',
  'console-follow': 'action.follow',
  'console-pause': 'action.pause',
  'console-resume': 'action.resume',
  contributions: 'content.contributions',
  acknowledgements: 'content.acknowledgements',
  diagnostics: 'status.error',
  document: 'content.files',
  'external-link': 'action.external-link',
  launcher: 'navigation.launcher',
  marketplace: 'navigation.marketplace',
  'marketplace-certified': 'trust.certified',
  'marketplace-official': 'trust.official',
  'marketplace-source-add': 'action.add',
  'marketplace-source-copy': 'action.copy',
  'marketplace-source-edit': 'action.edit',
  'marketplace-source-move-down': 'control.chevron-down',
  'marketplace-source-move-up': 'control.chevron-up',
  'models-read': 'agent.reasoning',
  more: 'action.more',
  outlets: 'content.layers',
  overview: 'navigation.overview',
  permissions: 'content.key',
  plugins: 'navigation.plugins',
  'point-info': 'status.info',
  'reload-plugin': 'action.refresh',
  'reset-configuration': 'action.reset',
  routes: 'navigation.routes',
  runtime: 'navigation.runtime',
  'save-configuration': 'action.save',
  search: 'action.search',
  settings: 'action.settings',
  'share-plugin': 'action.share',
  'tasks-catalog-read': 'content.panel',
  'tasks-content-read': 'content.files',
  'tasks-control': 'action.settings',
  'tasks-create': 'action.add',
  'turns-control': 'agent.turn-control',
  'turns-submit': 'action.submit',
  'authors-source': 'action.external-link',
  'disable-plugin': 'action.disable',
  'enable-plugin': 'action.enable',
  favorite: 'action.favorite',
  'favorite-active': 'action.favorite',
  'import-plugin': 'action.import',
  'uninstall-plugin': 'action.delete',
})

const HOST_SURFACE_ICON_MAP: Readonly<Record<string, SemanticIconKey>> = Object.freeze({
  'host:analytics': 'navigation.dashboard', 'host:back': 'action.back',
  'host:calendar': 'content.calendar', 'host:close': 'action.close', 'host:error': 'status.error',
  'host:chat': 'navigation.channels',
  'host:copy': 'action.copy', 'host:delete': 'action.delete',
  'host:files': 'content.files', 'host:folder': 'content.folder', 'host:history': 'navigation.history',
  'host:info': 'status.info', 'host:layers': 'content.layers', 'host:key': 'content.key',
  'host:marketplace': 'navigation.marketplace',
  'host:more': 'action.more', 'host:new': 'action.add', 'host:open': 'action.external-link',
  'host:palette': 'content.palette', 'host:playground': 'navigation.overview',
  'host:refresh': 'action.refresh', 'host:reset': 'action.reset', 'host:review': 'control.check',
  'host:settings': 'action.settings', 'host:save': 'action.save', 'host:clock': 'content.clock',
  'host:success': 'status.success', 'host:warning': 'status.warning', 'host:tags': 'content.tags',
})

export interface HostIconRenderOptions {
  readonly theme?: HostAppTheme
  readonly size?: number | string
  readonly variant?: IconVariant
  readonly state?: IconState | HostIconState
}

export interface HostIconResolution {
  readonly key: string
  readonly provider: string
  readonly fallback: 'none' | 'reicon' | 'neutral'
  readonly state: IconState
  readonly theme: HostAppTheme
  readonly variant: IconVariant
}

function normalizedState(value: HostIconRenderOptions['state']): IconState {
  if (value === 'favorite') return 'selected'
  if (value === 'active') return 'active'
  return value ?? 'default'
}

function normalizedVariant(options: HostIconRenderOptions): IconVariant {
  if (options.variant !== undefined) return options.variant
  const state = normalizedState(options.state)
  return state === 'active' || state === 'selected' ? 'filled' : 'regular'
}

export function normalizedVectorCommandData(command: NormalizedVectorCommand): string {
  if (command.op === 'move') return `M${command.x} ${command.y}`
  if (command.op === 'line') return `L${command.x} ${command.y}`
  if (command.op === 'cubic') return `C${command.x1} ${command.y1} ${command.x2} ${command.y2} ${command.x} ${command.y}`
  if (command.op === 'quadratic') return `Q${command.x1} ${command.y1} ${command.x} ${command.y}`
  return 'Z'
}

export function renderNormalizedIconSvg(
  document: Document,
  descriptor: NormalizedVectorDescriptor,
  resolution: HostIconResolution,
  size: number | string = '100%',
): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  svg.setAttribute('draggable', 'false')
  svg.setAttribute('data-host-icon-key', resolution.key)
  svg.setAttribute('data-host-icon-provider', resolution.provider)
  svg.setAttribute('data-host-icon-fallback', resolution.fallback)
  svg.setAttribute('data-host-icon-theme', resolution.theme)
  svg.setAttribute('data-host-icon-state', resolution.state)
  svg.setAttribute('data-host-icon-variant', resolution.variant)
  for (const vectorPath of descriptor.paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', vectorPath.commands.map(normalizedVectorCommandData).join(' '))
    if (vectorPath.paint === 'fill') {
      path.setAttribute('fill', 'currentColor')
      if (vectorPath.fillRule !== undefined) path.setAttribute('fill-rule', vectorPath.fillRule)
    } else {
      path.setAttribute('fill', 'none')
      path.setAttribute('stroke', 'currentColor')
      path.setAttribute('stroke-width', String(vectorPath.strokeWidth))
      path.setAttribute('stroke-linecap', vectorPath.lineCap)
      path.setAttribute('stroke-linejoin', vectorPath.lineJoin)
    }
    if (vectorPath.opacity !== undefined) path.setAttribute('opacity', String(vectorPath.opacity))
    svg.append(path)
  }
  return svg
}

export function resolveBuiltinHostIcon(
  requestedKey: string,
  options: HostIconRenderOptions = {},
): { readonly descriptor: NormalizedVectorDescriptor; readonly resolution: HostIconResolution } {
  const known = isSemanticIconKey(requestedKey)
  const descriptorKey = known ? requestedKey : 'control.minus'
  const state = normalizedState(options.state)
  const variant = normalizedVariant(options)
  return {
    descriptor: resolveBuiltinReiconDescriptor(descriptorKey, variant, state),
    resolution: {
      key: requestedKey,
      provider: known ? 'builtin:reicon' : 'host:neutral',
      fallback: known ? 'none' : 'neutral',
      state,
      theme: options.theme ?? 'light',
      variant,
    },
  }
}

export function resolveHostIcon(
  document: Document | undefined,
  requestedKey: string,
  options: HostIconRenderOptions = {},
): { readonly descriptor: NormalizedVectorDescriptor; readonly resolution: HostIconResolution } {
  if (!isSemanticIconKey(requestedKey)) return resolveBuiltinHostIcon(requestedKey, options)
  const registry = document === undefined ? undefined : documentRegistries.get(document)
  if (registry === undefined) return resolveBuiltinHostIcon(requestedKey, options)
  const state = normalizedState(options.state)
  const variant = normalizedVariant(options)
  const result = registry.resolve(requestedKey, variant, state)
  return {
    descriptor: result.descriptor,
    resolution: {
      key: requestedKey,
      provider: result.provider.providerId,
      fallback: result.fallback,
      state,
      theme: options.theme ?? 'light',
      variant,
    },
  }
}

export function resolveManagerIcon(
  document: Document | undefined,
  token: ManagerIconToken,
  options: HostIconRenderOptions = {},
): { readonly descriptor: NormalizedVectorDescriptor; readonly resolution: HostIconResolution } {
  const semantic = MANAGER_ICON_SEMANTICS[token]
  if (semantic !== undefined) return resolveHostIcon(document, semantic, options)
  return resolveBuiltinHostIcon(token, options)
}

export function renderHostIconSvg(
  document: Document,
  requestedKey: string,
  options: HostIconRenderOptions = {},
): { readonly svg: SVGSVGElement; readonly resolution: HostIconResolution } {
  const result = resolveHostIcon(document, requestedKey, options)
  return { svg: renderNormalizedIconSvg(document, result.descriptor, result.resolution, options.size), resolution: result.resolution }
}

export function renderHostSurfaceIconSvg(
  document: Document,
  token: string | undefined,
  options: HostIconRenderOptions = {},
): { readonly svg: SVGSVGElement; readonly resolution: HostIconResolution } {
  const requested = token ?? 'host:more'
  const key = hostSurfaceIconKey(requested)
  const state = normalizedState(options.state ?? (requested === 'host:pinned' ? 'selected' : undefined))
  const variant = normalizedVariant({ ...options, state })
  const theme = options.theme ?? resolveHostTheme(document).theme
  const privateSurfaceKey = (BUILTIN_HOST_SURFACE_ICON_KEYS as readonly string[]).includes(requested)
    ? requested as BuiltinHostSurfaceIconKey
    : undefined
  if (privateSurfaceKey === undefined) return renderHostIconSvg(document, key ?? requested, { ...options, theme, state, variant })
  const resolution: HostIconResolution = {
    key: requested,
    provider: 'builtin:reicon',
    fallback: 'none',
    state,
    theme,
    variant,
  }
  return {
    svg: renderNormalizedIconSvg(
      document,
      resolveBuiltinHostSurfaceIconDescriptor(privateSurfaceKey, variant, state),
      resolution,
      options.size,
    ),
    resolution,
  }
}

export function renderManagerIconSvg(
  document: Document,
  token: ManagerIconToken,
  options: HostIconRenderOptions = {},
): { readonly svg: SVGSVGElement; readonly resolution: HostIconResolution } {
  const result = resolveManagerIcon(document, token, options)
  return { svg: renderNormalizedIconSvg(document, result.descriptor, result.resolution, options.size), resolution: result.resolution }
}

export function createManagerIcon(
  document: Document,
  token: ManagerIconToken,
  className?: string,
  options: HostIconRenderOptions = {},
): HTMLSpanElement {
  const icon = document.createElement('span')
  icon.className = ['cordisx-host-icon', 'cxm-host-icon', className].filter(Boolean).join(' ')
  icon.dataset.hostIconKey = token
  icon.setAttribute('aria-hidden', 'true')
  icon.draggable = false
  const state = options.state ?? (token === 'favorite-active' ? 'favorite' : 'default')
  icon.append(renderManagerIconSvg(document, token, {
    ...options,
    state,
    theme: options.theme ?? resolveHostTheme(document).theme,
  }).svg)
  return icon
}

export function hostSurfaceIconKey(token: string | undefined): SemanticIconKey | undefined {
  return HOST_SURFACE_ICON_MAP[token ?? 'host:more']
}

export function createHostSurfaceIcon(
  document: Document,
  token: string | undefined,
  options: HostIconRenderOptions = {},
): HTMLSpanElement {
  const requested = token ?? 'host:more'
  const icon = document.createElement('span')
  icon.className = 'cordisx-host-icon'
  icon.dataset.hostIcon = requested
  icon.setAttribute('aria-hidden', 'true')
  icon.draggable = false
  icon.append(renderHostSurfaceIconSvg(document, requested, options).svg)
  return icon
}

export const HOST_ICON_16PX_CSS = String.raw`
  .cordisx-host-icon {
    display: inline-flex;
    flex: 0 0 16px;
    inline-size: 16px;
    block-size: 16px;
    align-items: center;
    justify-content: center;
    color: currentColor;
    line-height: 0;
    pointer-events: none;
    user-select: none;
    -webkit-user-select: none;
    -webkit-user-drag: none;
  }
  .cordisx-host-icon > svg {
    display: block;
    inline-size: 100%;
    block-size: 100%;
    color: currentColor;
    pointer-events: none;
  }
`
