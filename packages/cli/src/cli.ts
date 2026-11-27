#!/usr/bin/env node

const argv = process.argv.slice(2)

// Preserve bare App/profile launch syntax; only reserved tools enter the Codex API.
const codexTool = argv[0] === 'codex'
  && ['help', '--help', '-h', 'capabilities', 'providers', 'chats', 'defaults'].includes(argv[1] ?? '')

if (argv[0] === 'manager') {
  void import('./cli/manager-command.js').then(({ runManagerCommand }) => runManagerCommand(argv.slice(1))).catch(
    error => {
      const code = error instanceof Error && /^[A-Z][A-Z_]+$/u.test(error.message) ? error.message : 'MANAGER_FAILED'
      const hint = code === 'MANAGER_OWNER_NOT_RUNNING'
        ? ' Start the selected CordisX profile first; this command does not replace an existing owner.'
        : code === 'BROWSER_OPEN_UNAVAILABLE'
        ? ' To open locally without a graphical launcher, run manager open --print-url in a trusted terminal.'
        : code === 'MANAGER_OWNER_CHANGED'
        ? ' The profile owner changed. Wait for the old manager to stop, then reopen it.'
        : code === 'MANAGER_STOP_UNCONFIRMED'
        ? ' The previous manager has not confirmed shutdown. Reopen it after it exits.'
        : code === 'MANAGER_SERVICE_OWNED'
        ? ' This Web gateway belongs to the service; stop the service to stop it.'
        : code === 'MANAGER_SERVICE_WEB_DISABLED'
        ? ' Web is disabled for this service; enable it when restarting the service.'
        : code === 'MANAGER_SERVICE_WEB_UNAVAILABLE'
        ? ' Web is unavailable for this service; check its status before restarting it.'
        : code === 'MANAGER_OWNER_STARTING'
        ? ' The service is still starting; try again after it is ready.'
        : code === 'MANAGER_PRIVATE_ENTRY_UNSUPPORTED'
        ? ' The independent manager is not available on Windows until private entry ACLs are supported.'
        : ''
      console.error(`[cordisx] ${code}.${hint}`)
      process.exitCode = 1
    },
  )
} else if (codexTool || argv[0] === 'models') {
  void import('./cli/codex-command.js').then(({ runCodexCommand }) =>
    runCodexCommand(argv.slice(1), argv[0] === 'models')
  ).catch(async error => {
    const { CodexCommandRejected, codexCommandError } = await import('./cli/codex-command.js')
    if (!(error instanceof CodexCommandRejected)) console.error(JSON.stringify(codexCommandError(error)))
    process.exitCode = 1
  })
} else if (argv[0] === 'channel') {
  void import('./cli/channel-command.js').then(({ runChannelCommand }) => runChannelCommand(argv.slice(1))).catch(
    async error => {
      const { channelCommandError } = await import('./cli/channel-command-error.js')
      console.error(JSON.stringify({ status: 'failed', ...channelCommandError(error), automaticRetry: false }))
      process.exitCode = 1
    },
  )
} else {
  void Promise.all([
    import('./cli/model-export-choice.js'),
    import('./cli/run.js'),
    import('./cli/management-command.js'),
  ]).then(async ([{ ModelExportChoiceError }, { runCordisXCli }, { CordisXManagementCommandError }]) => {
    await runCordisXCli(argv).catch((error) => {
      if (
        !((error instanceof CordisXManagementCommandError || error instanceof ModelExportChoiceError) && error.reported)
      ) {
        const message = error instanceof Error ? error.message : String(error)
        const machineJson = (argv[0] === 'plugin' || argv[0] === 'source' || argv[0] === 'feedback')
          && argv.includes('--json')
        if (machineJson) {
          const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
            ? error.code
            : argv[0] === 'feedback'
            ? 'feedback-command-failed'
            : 'management-command-failed'
          console.log(JSON.stringify({ status: 'error', error: { code, message } }))
        } else {
          console.error(`[cordisx] ${message}`)
        }
      }
      process.exitCode = error instanceof Error && 'exitCode' in error
          && Number.isSafeInteger(error.exitCode)
        ? error.exitCode as number
        : (error instanceof CordisXManagementCommandError || error instanceof ModelExportChoiceError)
        ? error.exitCode
        : 1
    })
  }).catch(error => {
    console.error(`[cordisx] ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}
