import { connectorProductionPlugin } from './connector-production-plugin-base.js'
const plugin = connectorProductionPlugin('connector-harness-owner-replay', 'owner-replay')
export const inject = plugin.inject
export const manifest = plugin.manifest
export const apply = plugin.apply
