import accountTree from '@material-symbols/svg-400/rounded/account_tree.svg'
import analytics from '@material-symbols/svg-400/rounded/analytics.svg'
import arrowBack from '@material-symbols/svg-400/rounded/arrow_back.svg'
import check from '@material-symbols/svg-400/rounded/check.svg'
import checkCircle from '@material-symbols/svg-400/rounded/check_circle.svg'
import chevronLeft from '@material-symbols/svg-400/rounded/chevron_left.svg'
import close from '@material-symbols/svg-400/rounded/close.svg'
import description from '@material-symbols/svg-400/rounded/description.svg'
import diagnosis from '@material-symbols/svg-400/rounded/diagnosis.svg'
import error from '@material-symbols/svg-400/rounded/error.svg'
import extension from '@material-symbols/svg-400/rounded/extension.svg'
import folder from '@material-symbols/svg-400/rounded/folder.svg'
import help from '@material-symbols/svg-400/rounded/help.svg'
import history from '@material-symbols/svg-400/rounded/history.svg'
import hub from '@material-symbols/svg-400/rounded/hub.svg'
import info from '@material-symbols/svg-400/rounded/info.svg'
import layers from '@material-symbols/svg-400/rounded/layers.svg'
import modelTraining from '@material-symbols/svg-400/rounded/model_training.svg'
import moreHoriz from '@material-symbols/svg-400/rounded/more_horiz.svg'
import monitorHeart from '@material-symbols/svg-400/rounded/monitor_heart.svg'
import noteAdd from '@material-symbols/svg-400/rounded/note_add.svg'
import openInNew from '@material-symbols/svg-400/rounded/open_in_new.svg'
import overview from '@material-symbols/svg-400/rounded/overview.svg'
import pauseCircle from '@material-symbols/svg-400/rounded/pause_circle.svg'
import person from '@material-symbols/svg-400/rounded/person.svg'
import rocketLaunch from '@material-symbols/svg-400/rounded/rocket_launch.svg'
import route from '@material-symbols/svg-400/rounded/route.svg'
import refresh from '@material-symbols/svg-400/rounded/refresh.svg'
import search from '@material-symbols/svg-400/rounded/search.svg'
import send from '@material-symbols/svg-400/rounded/send.svg'
import settings from '@material-symbols/svg-400/rounded/settings.svg'
import shield from '@material-symbols/svg-400/rounded/shield.svg'
import storefront from '@material-symbols/svg-400/rounded/storefront.svg'
import summarize from '@material-symbols/svg-400/rounded/summarize.svg'
import tune from '@material-symbols/svg-400/rounded/tune.svg'
import viewList from '@material-symbols/svg-400/rounded/view_list.svg'
import warning from '@material-symbols/svg-400/rounded/warning.svg'
import deleteForever from '@material-symbols/svg-400/rounded/delete_forever.svg'
import playCircle from '@material-symbols/svg-400/rounded/play_circle.svg'
import share from '@material-symbols/svg-400/rounded/share.svg'
import starFilled from '@material-symbols/svg-400/rounded/star-fill.svg'
import starOutline from '@material-symbols/svg-400/rounded/star.svg'

export const MANAGER_ICON_TOKENS = [
  'back',
  'capability-fallback',
  'close',
  'configuration',
  'contributions',
  'diagnostics',
  'document',
  'external-link',
  'launcher',
  'marketplace',
  'models-read',
  'outlets',
  'overview',
  'permissions',
  'plugins',
  'point-info',
  'routes',
  'runtime',
  'search',
  'settings',
  'tasks-catalog-read',
  'tasks-content-read',
  'tasks-control',
  'tasks-create',
  'turns-control',
  'turns-submit',
  'authors-source',
  'disable-plugin',
  'enable-plugin',
  'favorite',
  'favorite-active',
  'import-plugin',
  'more',
  'reload-plugin',
  'share-plugin',
  'uninstall-plugin',
] as const

export type ManagerIconToken = typeof MANAGER_ICON_TOKENS[number]

const MANAGER_ICON_SOURCES: Readonly<Record<ManagerIconToken, string>> = {
  back: chevronLeft,
  'capability-fallback': help,
  close,
  configuration: tune,
  contributions: hub,
  diagnostics: diagnosis,
  document: description,
  'external-link': openInNew,
  launcher: rocketLaunch,
  marketplace: storefront,
  'models-read': modelTraining,
  outlets: accountTree,
  overview,
  permissions: shield,
  plugins: extension,
  'point-info': info,
  routes: route,
  runtime: monitorHeart,
  search,
  settings,
  'tasks-catalog-read': viewList,
  'tasks-content-read': summarize,
  'tasks-control': tune,
  'tasks-create': noteAdd,
  'turns-control': pauseCircle,
  'turns-submit': send,
  'authors-source': person,
  'disable-plugin': pauseCircle,
  'enable-plugin': playCircle,
  favorite: starOutline,
  'favorite-active': starFilled,
  'import-plugin': folder,
  more: moreHoriz,
  'reload-plugin': refresh,
  'share-plugin': share,
  'uninstall-plugin': deleteForever,
}

function svgMarkup(source: string): string {
  if (!source.startsWith('data:image/svg+xml,')) return source
  try {
    return decodeURIComponent(source.slice('data:image/svg+xml,'.length))
  } catch {
    return source
  }
}

/** Create one decorative, host-owned icon from a compile-time bundled Material symbol. */
export function createManagerIcon(
  document: Document,
  token: ManagerIconToken,
  className?: string,
): HTMLSpanElement {
  const icon = document.createElement('span')
  icon.className = className === undefined ? 'cxm-material-icon' : `cxm-material-icon ${className}`
  icon.dataset.materialIcon = token
  icon.setAttribute('aria-hidden', 'true')
  icon.draggable = false
  icon.innerHTML = svgMarkup(MANAGER_ICON_SOURCES[token])
  const svg = icon.querySelector('svg')
  svg?.setAttribute('aria-hidden', 'true')
  svg?.setAttribute('focusable', 'false')
  svg?.setAttribute('draggable', 'false')
  return icon
}

const HOST_SURFACE_ICON_SOURCES: Readonly<Record<string, string>> = {
  'host:analytics': analytics,
  'host:back': arrowBack,
  'host:close': close,
  'host:error': error,
  'host:files': folder,
  'host:history': history,
  'host:info': info,
  'host:layers': layers,
  'host:more': moreHoriz,
  'host:open': openInNew,
  'host:refresh': refresh,
  'host:review': check,
  'host:settings': settings,
  'host:success': checkCircle,
  'host:warning': warning,
}

/** Render a protocol host icon with the same bundled Material geometry as manager chrome. */
export function createHostSurfaceIcon(document: Document, token: string | undefined): HTMLSpanElement {
  const icon = document.createElement('span')
  icon.className = 'cordisx-host-icon'
  icon.dataset.hostIcon = token ?? 'host:more'
  icon.setAttribute('aria-hidden', 'true')
  icon.draggable = false
  icon.innerHTML = svgMarkup(HOST_SURFACE_ICON_SOURCES[token ?? 'host:more'] ?? moreHoriz)
  const svg = icon.querySelector('svg')
  svg?.setAttribute('aria-hidden', 'true')
  svg?.setAttribute('focusable', 'false')
  svg?.setAttribute('draggable', 'false')
  svg?.classList.add('icon-xs')
  return icon
}
