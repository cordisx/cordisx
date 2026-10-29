import { nativeCliInvocation } from '../packages/cli/assets/launcher/native-cli-invocation.mjs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { type DiagnosticEvent, withDiagnostics } from '../packages/cli/src/diagnostics/context.js'
import { harness } from './fixtures/native-intermediary-harness.js'

function cliProbe(args: readonly string[], environment: NodeJS.ProcessEnv = {}) {
  const entry = path.resolve('packages/cli/assets/launcher/native-app-server-intermediary.mjs')
  return spawn(process.platform === 'win32' ? process.execPath : entry, [
    ...(process.platform === 'win32' ? [entry] : []),
    ...args,
  ], {
    env: {
      ...process.env,
      CODEX_CLI_PATH: 'PRIVATE_WRAPPER',
      CORDISX_NATIVE_NODE_PATH: process.execPath,
      CORDISX_NATIVE_REAL_CODEX_PATH: process.execPath,
      CORDISX_NATIVE_CONTROL_SOCKET: undefined,
      CORDISX_NATIVE_CONTROL_NONCE: 'PRIVATE_NONCE',
      CORDISX_NATIVE_AGENT_MODELS_BINDING: 'PRIVATE_BINDING',
      ...environment,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
}

describe('native CLI entry and startup lifetime', () => {
  it.each([
    [['app-server'], 'app-server-stdio'],
    [['app-server', '--listen', 'stdio://', '--analytics-default-enabled'], 'app-server-stdio'],
    [['-c', 'model="app-server"', 'app-server', '--startup-client-info', '{"name":"--help"}'], 'app-server-stdio'],
    [['app-server', '--config=example="generate-ts"'], 'app-server-stdio'],
    [['app-server', '--print-startup-config'], 'startup-config'],
    [['app-server', 'generate-json-schema'], 'app-server-tool'],
    [['app-server', 'generate-ts'], 'app-server-tool'],
    [['app-server', '--listen', 'ws://127.0.0.1:1234'], 'other-cli'],
    [['app-server', '--listen', 'off'], 'other-cli'],
    [['exec', 'app-server'], 'other-cli'],
    [['--config', 'app-server'], 'other-cli'],
  ])('classifies actual CLI grammar without treating option values as commands', (args, expected) => {
    expect(nativeCliInvocation(args)).toBe(expected)
  })

  it.each([['--version'], ['app-server', '--help']])(
    'preserves ordinary CLI bytes, arguments and exit code without private control: %j',
    async (...arguments_: string[]) => {
      const child = cliProbe([
        '-e',
        `if (['CODEX_CLI_PATH','CORDISX_NATIVE_CONTROL_SOCKET','CORDISX_NATIVE_CONTROL_NONCE','CORDISX_NATIVE_AGENT_MODELS_BINDING'].some(key => process.env[key] !== undefined)) process.exit(91); if (process.argv.at(-1) !== 'PRIVATE_ARG') process.exit(92); process.exitCode=7; process.stdin.pipe(process.stdout)`,
        '--',
        ...arguments_,
        'PRIVATE_ARG',
      ])
      let output = '', errors = ''
      child.stdout.on('data', chunk => output += String(chunk))
      child.stderr.on('data', chunk => errors += String(chunk))
      child.stdin.end('PRIVATE_STDIN\0\n')
      const [code, signal] = await once(child, 'close')
      expect({ code, signal, output, errors }).toEqual({
        code: 7,
        signal: null,
        output: 'PRIVATE_STDIN\0\n',
        errors: '',
      })
    },
  )
  it('propagates an ordinary CLI termination signal', async () => {
    const child = cliProbe(['-e', 'process.kill(process.pid,"SIGTERM")'])
    const [code, signal] = await once(child, 'close')
    expect({ code, signal }).toEqual({ code: null, signal: 'SIGTERM' })
  })
  it.skipIf(process.platform === 'win32').each([['--version'], ['app-server', '--print-startup-config']])(
    'keeps ordinary CLI probes outside the occupied app-server control connection: %j',
    async (...extraArgs: string[]) => {
      const events: DiagnosticEvent[] = []
      await withDiagnostics({ emit: event => events.push(event) }, async () => {
        const h = await harness()
        try {
          h.send({ id: 'connected', method: 'echo/bytes', params: {} })
          await h.read()
          const toolRoot = await mkdtemp(path.join(os.tmpdir(), 'cx-cli-tool-'))
          const tool = path.join(toolRoot, 'cli')
          await writeFile(tool, "#!/bin/sh\nprintf 'fixture-version\\n'\n", { mode: 0o700 })
          const probe = spawn(
            path.resolve('packages/cli/assets/launcher/native-app-server-intermediary.mjs'),
            extraArgs,
            {
              env: {
                ...process.env,
                CORDISX_NATIVE_NODE_PATH: process.execPath,
                CORDISX_NATIVE_REAL_CODEX_PATH: tool,
                CORDISX_NATIVE_CONTROL_SOCKET: h.server.socketPath,
                CORDISX_NATIVE_CONTROL_NONCE: h.server.nonce,
              },
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          )
          let output = ''
          probe.stdout.on('data', chunk => output += String(chunk))
          const [code] = await once(probe, 'close')
          await rm(toolRoot, { recursive: true, force: true })
          expect(code).toBe(0)
          expect(output).toBe('fixture-version\n')
          expect(events.filter(event => event.event === 'native-control-peer-rejected')).toHaveLength(0)
          h.send({ id: 'still-connected', method: 'echo/bytes', params: {} })
          await h.read()
        } finally {
          await h.close()
        }
      })
    },
  )
  it('records initialize, desktop EOF and actual child exit separately without payloads', async () => {
    const events: DiagnosticEvent[] = []
    const h = await withDiagnostics({ emit: event => events.push(event) }, () => harness())
    try {
      h.send({ id: 'PRIVATE_INITIALIZE_ID', method: 'initialize', params: { input: 'PRIVATE_PAYLOAD' } })
      await h.read()
    } finally {
      await h.close()
    }
    const metadata = h.startupEvents()
    const phases = metadata.map(event => event.phase)
    expect(phases).toContain('control-authenticated')
    expect(phases.indexOf('initialize-issued')).toBeLessThan(phases.indexOf('initialize-response'))
    expect(phases.indexOf('desktop-input-ended')).toBeLessThan(phases.indexOf('child-exited'))
    expect(metadata).toContainEqual(expect.objectContaining({ phase: 'child-exited', exitCode: 0 }))
    expect(metadata.at(-1)).toMatchObject({ reason: 'desktop-input-ended', exitCode: 0, verified: true })
    expect(events).toContainEqual(expect.objectContaining({ event: 'native-control-peer-authenticated' }))
    expect(JSON.stringify({ metadata, events })).not.toMatch(/PRIVATE/u)
  })
})
