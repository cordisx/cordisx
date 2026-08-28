import { runCordisXCli } from '../../packages/cli/src/cli/run.js'
import { buildConnectorProductionBundle } from './connector-production-bundle.js'

runCordisXCli(process.argv.slice(2), { internalBuildRendererBundle: buildConnectorProductionBundle }).catch(error => {
  console.error(`[connector-production-smoke] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
