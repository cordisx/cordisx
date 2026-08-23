#!/usr/bin/env node
import { runCordisXCli } from './cli/run.js'

runCordisXCli(process.argv.slice(2)).catch((error) => {
  console.error(`[cordisx] ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
