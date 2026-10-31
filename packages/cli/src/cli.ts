#!/usr/bin/env node
import { ModelExportChoiceError } from './cli/model-export-choice.js'
import { runCordisXCli } from './cli/run.js'
import { CordisXManagementCommandError } from './cli/management-command.js'

const argv = process.argv.slice(2)

runCordisXCli(argv).catch((error) => {
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
  process.exitCode = argv[0] === 'cli' && error instanceof Error && 'exitCode' in error
      && Number.isSafeInteger(error.exitCode)
    ? error.exitCode as number
    : (error instanceof CordisXManagementCommandError || error instanceof ModelExportChoiceError)
    ? error.exitCode
    : 1
})
