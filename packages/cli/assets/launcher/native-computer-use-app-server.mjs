import { spawn } from 'node:child_process'
import { nativeCliPath } from './native-cli-path.mjs'

/** Native identity/policy queries have their own lifetime, never chat's single control peer. */
export function startComputerUseAppServer(args, input) {
  const executable = nativeCliPath()
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CORDISX_NATIVE_') || key === 'CODEX_CLI_PATH') delete environment[key]
  }
  // Keep the signed App's Node/executable chain and native account/organization policy checks.
  // Client identity selects a narrow query channel; it grants no model or browser permission.
  const child = spawn(executable, args, { stdio: ['pipe', 'pipe', 'inherit'], env: environment })
  let closed = false
  const stop = () => {
    if (closed) return
    closed = true
    input.destroy()
    child.stdin.destroy()
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
  }
  const allowed = new Set(['initialize', 'initialized', 'account/read', 'getAuthStatus', 'configRequirements/read'])
  const nativeRequests = new Set()
  const forward = line => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      stop()
      return
    }
    const nativeResponse = message?.method === undefined && nativeRequests.delete(message?.id)
    if (allowed.has(message?.method) || nativeResponse) {
      if (!child.stdin.write(`${line}\n`)) {
        input.pause()
        child.stdin.once('drain', () => input.resume())
      }
    } else if (typeof message?.id === 'string' || typeof message?.id === 'number') {
      process.stdout.write(`${
        JSON.stringify({
          id: message.id,
          error: {
            code: -32601,
            message: 'Computer Use auxiliary app-server supports native identity and policy queries only',
          },
        })
      }\n`)
    }
  }
  let buffer = ''
  const frameLimit = 8 * 1024 * 1024
  input.setEncoding('utf8')
  input.on('data', chunk => {
    buffer += chunk
    let newline
    while (!closed && (newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (Buffer.byteLength(line) > frameLimit) {
        stop()
        return
      }
      if (line) forward(line)
    }
    if (Buffer.byteLength(buffer) > frameLimit) stop()
  })
  input.once('end', () => buffer.trim() ? stop() : child.stdin.end())
  input.on('error', stop)
  // Local method rejections share stdout: only complete native frames may cross,
  // otherwise a partial child write can interleave with the rejection JSON.
  let output = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => {
    output += chunk
    let newline
    while ((newline = output.indexOf('\n')) >= 0) {
      const line = output.slice(0, newline)
      output = output.slice(newline + 1)
      if (Buffer.byteLength(line) > frameLimit) {
        stop()
        return
      }
      try {
        const message = JSON.parse(line)
        if (typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number')) {
          if (nativeRequests.size >= 64 || nativeRequests.has(message.id)) {
            stop()
            return
          }
          nativeRequests.add(message.id)
        }
      } catch {
        stop()
        return
      }
      process.stdout.write(`${line}\n`)
    }
    if (Buffer.byteLength(output) > frameLimit) stop()
  })
  child.stdout.once('end', () => {
    if (output.trim()) {
      process.exitCode = 1
      stop()
    }
  })
  child.stdin.on('error', stop)
  process.stdout.on('error', stop)
  child.on('error', () => {
    process.stderr.write('[cordisx] Native Computer Use app-server spawn failed\n')
    process.exitCode = 1
    stop()
  })
  child.on('close', (code, signal) => {
    process.exitCode = code ?? (signal ? 1 : 0)
    stop()
  })
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, stop)
  return child
}
