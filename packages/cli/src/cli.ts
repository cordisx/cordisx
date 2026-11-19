#!/usr/bin/env node

const argv = process.argv.slice(2)

// Preserve bare App/profile launch syntax; only reserved tools enter the Codex API.
const codexTool = argv[0] === 'codex'
  && ['help', '--help', '-h', 'capabilities', 'providers', 'chats', 'defaults'].includes(argv[1] ?? '')

if (codexTool || argv[0] === 'models') {
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
