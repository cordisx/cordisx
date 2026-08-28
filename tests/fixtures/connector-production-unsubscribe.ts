import { connectorProductionPlugin } from './connector-production-plugin-base.js'
const plugin = connectorProductionPlugin('connector-harness-unsubscribe', 'unsubscribe')
export const inject = plugin.inject
export const manifest = plugin.manifest
export const apply = plugin.apply
