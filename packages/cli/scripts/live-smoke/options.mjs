import path from 'node:path'
import { parseArgs } from 'node:util'

export function parseLiveSmokeOptions(args = process.argv.slice(2)) {
  const parsed = parseArgs({
    args,
    options: {
      port: { type: 'string' },
      screenshot: { type: 'string' },
      'app-screenshot': { type: 'string' },
      'manager-screenshot': { type: 'string' },
      'manager-tab': { type: 'string' },
      'manager-plugin': { type: 'string' },
      'manager-detail-tab': { type: 'string' },
      'manager-permission-capability': { type: 'string' },
      'manager-settings-tab': { type: 'string' },
      'manager-settings-navigation-item': { type: 'string' },
      'manager-settings-navigation-exercise': { type: 'boolean', default: false },
      'manager-form-exercise': { type: 'boolean', default: false },
      'manager-form-value-exercise': { type: 'boolean', default: false },
      'manager-config-scroll-path': { type: 'string' },
      'manager-open-local-path-form': { type: 'boolean', default: false },
      'manager-open-select': { type: 'boolean', default: false },
      'config-exercise': { type: 'boolean', default: false },
      'manager-lifecycle-source': { type: 'string' },
      'permission-v2-source': { type: 'string' },
      'permission-v2-expanded-source': { type: 'string' },
      'manager-extension-point': { type: 'string' },
      'manager-extension-point-tab': { type: 'string' },
      'manager-route': { type: 'string' },
      'manager-marketplace-tab': { type: 'string' },
      'manager-marketplace-view': { type: 'string' },
      'manager-marketplace-open-menu': { type: 'boolean', default: false },
      'manager-marketplace-clipboard-exercise': { type: 'boolean', default: false },
      'manager-marketplace-source': { type: 'string' },
      'manager-marketplace-fixture': { type: 'string' },
      'manager-click-external': { type: 'boolean', default: false },
      'manager-viewport-width': { type: 'string' },
      'manager-breadcrumb-width': { type: 'string' },
      'manager-theme-cycle': { type: 'boolean', default: false },
      'channel-data-plane': { type: 'boolean', default: false },
      'channel-manager-exercise': { type: 'boolean', default: false },
      'channel-manager-existing-account': { type: 'boolean', default: false },
      'channel-manager-existing-account-save': { type: 'boolean', default: false },
      'host-collection-menu-exercise': { type: 'boolean', default: false },
      'host-collection-menu-screenshot': { type: 'string' },
      'manager-light-screenshot': { type: 'string' },
      'manager-dark-screenshot': { type: 'string' },
      'trigger-screenshot': { type: 'string' },
      'color-scheme': { type: 'string' },
      locale: { type: 'string' },
      'fetch-url': { type: 'string' },
      report: { type: 'string' },
      'select-thread': { type: 'string' },
      'plugin-owner': { type: 'string' },
      'open-route': { type: 'string' },
      'click-surface': { type: 'string' },
      'click-label': { type: 'string' },
      'session-id': { type: 'string' },
      'permission-capability': { type: 'string', multiple: true },
      'permission-policy': { type: 'string' },
      'authorization-plugin': { type: 'string' },
      'authorization-decision': { type: 'string' },
      'authorization-decline-optional': { type: 'boolean', default: false },
      'authorization-screenshot': { type: 'string' },
      'demo-kind': { type: 'string', multiple: true },
      'clear-demo': { type: 'boolean', default: false },
      'plugin-lifecycle': { type: 'boolean', default: false },
      'plugin-console-exercise': { type: 'boolean', default: false },
      'plugin-console-expanded-screenshot': { type: 'string' },
      'generation-transaction-exercise': { type: 'boolean', default: false },
      'adapter-commit': { type: 'string' },
      'protocol-commit': { type: 'string' },
      'host-version': { type: 'string' },
      'host-build': { type: 'string' },
      exercise: { type: 'boolean', default: false },
      generation: { type: 'boolean', default: false },
      'ui-catalog': { type: 'boolean', default: false },
    },
  })

  const port = Number(parsed.values.port)

  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(
      'Usage: npm run smoke -- --port <port> [--color-scheme light|dark] [--locale en|zh-CN] [--screenshot <png>] [--app-screenshot <png>] [--host-collection-menu-exercise --host-collection-menu-screenshot <png> --report <json>] [--plugin-owner <id> --open-route <id> | --click-surface <id> --click-label <aria-label>] [--permission-capability <name> --permission-policy allow|ask|deny] [--manager-screenshot <png> --manager-tab <tab> --manager-plugin <id> --manager-detail-tab <tab> --manager-permission-capability <name> --manager-settings-tab <tab> --manager-settings-navigation-item <qualified-id> --manager-extension-point <id> --manager-extension-point-tab <tab> --manager-route <qualified-id> --manager-marketplace-tab <tab> --manager-marketplace-view discovery|sources|create --manager-marketplace-open-menu --manager-marketplace-clipboard-exercise --manager-marketplace-source <https-url> --manager-marketplace-fixture <absolute-json> --manager-click-external --manager-viewport-width <pixels> --manager-breadcrumb-width <pixels>] [--manager-lifecycle-source <absolute-directory> --report <json>] [--trigger-screenshot <png>]',
    )
  }

  if (parsed.values['ui-catalog'] && parsed.values.report === undefined) {
    throw new Error(
      '--ui-catalog requires --report so screenshots and machine-readable assertions share one artifact directory',
    )
  }

  if (parsed.values['channel-data-plane'] && parsed.values.report === undefined) {
    throw new Error('--channel-data-plane requires --report')
  }

  if (
    parsed.values['channel-manager-exercise']
    && (!parsed.values['channel-data-plane'] || parsed.values['manager-screenshot'] === undefined)
  ) {
    throw new Error('--channel-manager-exercise requires --channel-data-plane and --manager-screenshot')
  }

  if (
    parsed.values['channel-manager-existing-account']
    && (!parsed.values['channel-data-plane'] || parsed.values['manager-screenshot'] === undefined)
  ) {
    throw new Error('--channel-manager-existing-account requires --channel-data-plane and --manager-screenshot')
  }

  if (parsed.values['channel-manager-existing-account-save'] && !parsed.values['channel-manager-existing-account']) {
    throw new Error('--channel-manager-existing-account-save requires --channel-manager-existing-account')
  }

  if (parsed.values['host-collection-menu-exercise'] && parsed.values.report === undefined) {
    throw new Error('--host-collection-menu-exercise requires --report')
  }

  if (
    parsed.values['host-collection-menu-screenshot'] !== undefined && !parsed.values['host-collection-menu-exercise']
  ) {
    throw new Error('--host-collection-menu-screenshot requires --host-collection-menu-exercise')
  }

  if (parsed.values['plugin-console-exercise'] && parsed.values.report === undefined) {
    throw new Error('--plugin-console-exercise requires --report')
  }

  if (parsed.values['plugin-console-expanded-screenshot'] !== undefined && !parsed.values['plugin-console-exercise']) {
    throw new Error('--plugin-console-expanded-screenshot requires --plugin-console-exercise')
  }

  if (parsed.values['generation-transaction-exercise'] && parsed.values['manager-lifecycle-source'] === undefined) {
    throw new Error('--generation-transaction-exercise requires --manager-lifecycle-source')
  }

  if (parsed.values['open-route'] !== undefined && parsed.values['click-surface'] !== undefined) {
    throw new Error('--open-route and --click-surface are mutually exclusive')
  }

  if ((parsed.values['permission-capability'] === undefined) !== (parsed.values['permission-policy'] === undefined)) {
    throw new Error('--permission-capability and --permission-policy must be provided together')
  }

  if (
    parsed.values['authorization-plugin'] === undefined && (
      parsed.values['authorization-decision'] !== undefined
      || parsed.values['authorization-decline-optional']
      || parsed.values['authorization-screenshot'] !== undefined
    )
  ) throw new Error('authorization smoke options require --authorization-plugin')

  if (
    (parsed.values['manager-light-screenshot'] !== undefined || parsed.values['manager-dark-screenshot'] !== undefined)
    && !parsed.values['manager-theme-cycle']
  ) throw new Error('manager theme screenshots require --manager-theme-cycle')

  if (parsed.values['manager-lifecycle-source'] !== undefined) {
    if (parsed.values.report === undefined) throw new Error('--manager-lifecycle-source requires --report')
    if (!path.isAbsolute(parsed.values['manager-lifecycle-source'])) {
      throw new Error('--manager-lifecycle-source must be an absolute local package directory')
    }
  }

  if (
    (parsed.values['permission-v2-source'] === undefined)
      !== (parsed.values['permission-v2-expanded-source'] === undefined)
  ) {
    throw new Error('--permission-v2-source and --permission-v2-expanded-source must be provided together')
  }

  for (const option of ['permission-v2-source', 'permission-v2-expanded-source']) {
    const value = parsed.values[option]
    if (value !== undefined && !path.isAbsolute(value)) {
      throw new Error(`--${option} must be an absolute local package directory`)
    }
  }

  if (parsed.values['permission-v2-source'] !== undefined && parsed.values.report === undefined) {
    throw new Error('--permission-v2-source requires --report')
  }
  return { values: parsed.values, port }
}
