#!/usr/bin/env node
import { createLiveSmokeBrowserTools } from './live-smoke/browser-tools.mjs'
import { connectLiveSmokeCdp } from './live-smoke/cdp-client.mjs'
import { runEnvironmentSetup } from './live-smoke/environment.mjs'
import { finalizeLiveSmoke } from './live-smoke/finalize.mjs'
import { runHostCollectionExercises } from './live-smoke/host-collection.mjs'
import { readInitialReport } from './live-smoke/initial-report.mjs'
import { runLifecycleExercises } from './live-smoke/lifecycle.mjs'
import { runManagerScreenshot } from './live-smoke/manager-screenshot.mjs'
import { parseLiveSmokeOptions } from './live-smoke/options.mjs'
import { runPermissionExercises } from './live-smoke/permission.mjs'
import { runPluginConsoleExercise } from './live-smoke/plugin-console.mjs'
import { runSettingsExercises } from './live-smoke/settings.mjs'
import { runUiCatalogExercises } from './live-smoke/ui-catalog.mjs'
import { runAuthorizationExercise } from './live-smoke/authorization.mjs'

const { values, port } = parseLiveSmokeOptions()
const { socket, runtimeExceptions, send, pointerClick, pressKey } = await connectLiveSmokeCdp(port)
const { evaluateByValue, ensureManagerVisible, ensureManagerClosed, capture } = createLiveSmokeBrowserTools(send)

await send('Runtime.enable')
await send('Log.enable')
await send('Page.enable')

const { locale, localeProjection, colorScheme, demoReport, pluginLifecycleReport } = await runEnvironmentSetup({
  values,
  send,
  evaluateByValue,
  pointerClick,
})
const { report } = await readInitialReport({ send })
const { exerciseReport, settingsTabsReport, configExerciseReport } = await runSettingsExercises({
  values,
  evaluateByValue,
  pointerClick,
  send,
  locale,
  pressKey,
})
const { hostCollectionMenuReport } = await runHostCollectionExercises({
  values,
  send,
  capture,
  report,
  evaluateByValue,
  pointerClick,
  pressKey,
})
const { managerLifecycleReport, generationTransactionReport } = await runLifecycleExercises({
  values,
  send,
  report,
  evaluateByValue,
  capture,
  pointerClick,
  pressKey,
})
const { permissionV2Report } = await runPermissionExercises({ values, report, evaluateByValue, capture })
const { uiCatalogReport } = await runUiCatalogExercises({
  values,
  evaluateByValue,
  report,
  capture,
  send,
  pointerClick,
})
const { authorizationReport } = await runAuthorizationExercise({ values, evaluateByValue, capture, pointerClick })
const pluginConsole = await runPluginConsoleExercise({
  values,
  locale,
  evaluateByValue,
  pointerClick,
  send,
  pressKey,
  capture,
})
const manager = await runManagerScreenshot({
  values,
  ensureManagerVisible,
  send,
  locale,
  colorScheme,
  evaluateByValue,
  pointerClick,
  capture,
  managerReport: pluginConsole.managerReport,
  managerServiceConfigurationFailure: pluginConsole.managerServiceConfigurationFailure,
  managerFormExerciseFailure: pluginConsole.managerFormExerciseFailure,
})
await finalizeLiveSmoke({
  values,
  send,
  capture,
  ensureManagerClosed,
  colorScheme,
  evaluateByValue,
  report,
  runtimeExceptions,
  localeProjection,
  managerReport: manager.managerReport,
  hostCollectionMenuReport,
  exerciseReport,
  settingsTabsReport,
  configExerciseReport,
  demoReport,
  pluginLifecycleReport,
  pluginConsoleReport: pluginConsole.pluginConsoleReport,
  authorizationReport,
  managerLifecycleReport,
  permissionV2Report,
  generationTransactionReport,
  uiCatalogReport,
  locale,
  socket,
  managerFormExerciseFailure: manager.managerFormExerciseFailure,
  managerServiceConfigurationFailure: manager.managerServiceConfigurationFailure,
  pluginConsoleAssertions: pluginConsole.pluginConsoleAssertions,
})
