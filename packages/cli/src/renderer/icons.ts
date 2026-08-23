import accountTree from '@material-symbols/svg-400/rounded/account_tree.svg'
import chevronLeft from '@material-symbols/svg-400/rounded/chevron_left.svg'
import chevronRight from '@material-symbols/svg-400/rounded/chevron_right.svg'
import close from '@material-symbols/svg-400/rounded/close.svg'
import description from '@material-symbols/svg-400/rounded/description.svg'
import diagnosis from '@material-symbols/svg-400/rounded/diagnosis.svg'
import extension from '@material-symbols/svg-400/rounded/extension.svg'
import help from '@material-symbols/svg-400/rounded/help.svg'
import hub from '@material-symbols/svg-400/rounded/hub.svg'
import info from '@material-symbols/svg-400/rounded/info.svg'
import modelTraining from '@material-symbols/svg-400/rounded/model_training.svg'
import monitorHeart from '@material-symbols/svg-400/rounded/monitor_heart.svg'
import noteAdd from '@material-symbols/svg-400/rounded/note_add.svg'
import openInNew from '@material-symbols/svg-400/rounded/open_in_new.svg'
import overview from '@material-symbols/svg-400/rounded/overview.svg'
import pauseCircle from '@material-symbols/svg-400/rounded/pause_circle.svg'
import person from '@material-symbols/svg-400/rounded/person.svg'
import rocketLaunch from '@material-symbols/svg-400/rounded/rocket_launch.svg'
import route from '@material-symbols/svg-400/rounded/route.svg'
import send from '@material-symbols/svg-400/rounded/send.svg'
import settings from '@material-symbols/svg-400/rounded/settings.svg'
import shield from '@material-symbols/svg-400/rounded/shield.svg'
import storefront from '@material-symbols/svg-400/rounded/storefront.svg'
import summarize from '@material-symbols/svg-400/rounded/summarize.svg'
import tune from '@material-symbols/svg-400/rounded/tune.svg'
import viewList from '@material-symbols/svg-400/rounded/view_list.svg'

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
  'settings',
  'tasks-catalog-read',
  'tasks-content-read',
  'tasks-control',
  'tasks-create',
  'turns-control',
  'turns-submit',
  'view-detail',
  'authors-source',
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
  settings,
  'tasks-catalog-read': viewList,
  'tasks-content-read': summarize,
  'tasks-control': tune,
  'tasks-create': noteAdd,
  'turns-control': pauseCircle,
  'turns-submit': send,
  'view-detail': chevronRight,
  'authors-source': person,
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
  icon.innerHTML = MANAGER_ICON_SOURCES[token]
  const svg = icon.querySelector('svg')
  svg?.setAttribute('aria-hidden', 'true')
  svg?.setAttribute('focusable', 'false')
  svg?.setAttribute('draggable', 'false')
  return icon
}
