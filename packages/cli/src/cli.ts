#!/usr/bin/env node
import { runCordisXCli } from './cli/run.js'
import { CordisXManagementCommandError } from './cli/management-command.js'

const argv = process.argv.slice(2)

runCordisXCli(argv).catch((error) => {
  if (!(error instanceof CordisXManagementCommandError && error.reported)) {
    const message = error instanceof Error ? error.message : String(error)
    const managementJson = (argv[0] === 'plugin' || argv[0] === 'source') && argv.includes('--json')
    if (managementJson) {
      const code = error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'management-command-failed'
      console.log(JSON.stringify({ status: 'error', error: { code, message } }))
    } else {
      console.error(`[cordisx] ${message}`)
    }
  }
  process.exitCode = error instanceof CordisXManagementCommandError ? error.exitCode : 1
})
