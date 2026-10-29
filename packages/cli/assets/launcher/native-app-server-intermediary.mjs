#!/bin/sh
':' // ; exec "${CORDISX_NATIVE_NODE_PATH:-${CORDISX_NATIVE_REAL_CODEX_PATH%%/Contents/Resources/*}/Contents/Resources/cua_node/bin/node}" "$0" "$@"
import { spawn } from 'node:child_process'

const args = process.argv.slice(2)
const appServer = args.includes('app-server')
  && !args.some(argument => ['--help', '-h', '--version', '-V'].includes(argument))
if (appServer) {
  await import('./native-app-server-protocol.mjs')
} else {
  // Version/help and other ordinary CLI calls must never reserve the single app-server control peer.
  const executable = process.env.CORDISX_NATIVE_REAL_CODEX_PATH
  if (!executable?.startsWith('/')) throw new Error('Native CLI path is not configured')
  const environment = { ...process.env }
  for (
    const key of [
      'CODEX_CLI_PATH',
      'CORDISX_NATIVE_CONTROL_SOCKET',
      'CORDISX_NATIVE_CONTROL_NONCE',
      'CORDISX_NATIVE_REAL_CODEX_PATH',
      'CORDISX_NATIVE_NODE_PATH',
      'CORDISX_NATIVE_AGENT_MODELS_BINDING',
    ]
  ) delete environment[key]
  const child = spawn(executable, args, { stdio: 'inherit', env: environment })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal))
  child.on('error', error => {
    const code = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code) ? error.code : 'unknown'
    process.stderr.write(`[cordisx] Native CLI pass-through failed: ${code}\n`)
    process.exitCode = 1
  })
  child.on('exit', (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal)
      process.kill(process.pid, signal)
    } else process.exitCode = code ?? 1
  })
}
