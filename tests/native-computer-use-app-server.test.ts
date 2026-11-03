import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { harness } from './fixtures/native-intermediary-harness.js'

describe('Computer Use auxiliary app-server', () => {
  it('keeps fragmented native output separate from local rejections and returns native auth responses', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cx-cua-frame-'))
    const fixture = path.join(root, 'native.mjs')
    const executable = path.join(root, 'native')
    await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' '${fixture}'\n`, { mode: 0o700 })
    await writeFile(
      fixture,
      `import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);
if(m.method==='initialize') {
process.stdout.write('{"id":1,"result":');process.stderr.write('partial\\n');
setTimeout(()=>{process.stdout.write('{} }\\n');process.stdout.write('{"id":"auth-refresh","method":"account/chatgptAuthTokens/refresh","params":{}}\\n');},100);
} else if(m.id==='auth-refresh') console.log(JSON.stringify({id:2,result:{nativeAuthResponse:m.result}}));
});`,
    )
    const entry = path.join(root, 'entry.mjs')
    const helper = path.resolve('packages/cli/assets/launcher/native-computer-use-app-server.mjs')
    await writeFile(
      entry,
      `import {startComputerUseAppServer} from ${
        JSON.stringify(new URL(`file://${helper}`).href)
      };startComputerUseAppServer([],process.stdin)`,
    )
    const child = spawn(process.execPath, [entry], {
      env: { ...process.env, CORDISX_NATIVE_REAL_CODEX_PATH: executable },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const closed = once(child, 'close')
    let output = '', errors = ''
    child.stdout.on('data', chunk => output += String(chunk))
    child.stderr.on('data', chunk => errors += String(chunk))
    try {
      child.stdin.write('{"id":1,"method":"initialize","params":{}}\n')
      await vi.waitFor(() => expect(errors).toContain('partial'))
      child.stdin.write('{"id":3,"method":"turn/start","params":{}}\n')
      await vi.waitFor(() => expect(output).toContain('auth-refresh'))
      child.stdin.end('{"id":"auth-refresh","result":{"acknowledged":true}}\n')
      expect(await closed).toEqual([0, null])
      const messages = output.trim().split('\n').map(line => JSON.parse(line))
      expect(messages.find(m => m.id === 1)).toEqual({ id: 1, result: {} })
      expect(messages.find(m => m.id === 3).error.code).toBe(-32601)
      expect(messages.find(m => m.id === 2).result.nativeAuthResponse).toEqual({ acknowledged: true })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
      await closed
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each([{ clientName: 'codex-computer-use', disablePlugins: true }, {
    clientName: 'codex-browser-use',
    disablePlugins: true,
  }, { clientName: 'codex-browser-use', disablePlugins: false }])(
    '%s queries native policy with an occupied chat peer and rejects inference',
    async ({ clientName, disablePlugins }) => {
      const h = await harness()
      const root = await mkdtemp(path.join(os.tmpdir(), 'cx-cua-server-'))
      const executable = path.join(root, 'native')
      await writeFile(
        executable,
        `#!${process.execPath}
import { createInterface } from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);
if(m.id!==undefined) console.log(JSON.stringify({id:m.id,result:{method:m.method,args:process.argv.slice(2),leaked:Object.keys(process.env).filter(k=>k.startsWith('CORDISX_NATIVE_')||k==='CODEX_CLI_PATH')}}));
});
`,
        { mode: 0o700 },
      )
      const args = [
        'app-server',
        '--listen',
        'stdio://',
        ...(disablePlugins ? ['--config', 'features.plugins=false'] : []),
      ]
      const child = spawn(process.execPath, [
        path.resolve('packages/cli/assets/launcher/native-app-server-intermediary.mjs'),
        ...args,
      ], {
        env: {
          ...process.env,
          CODEX_CLI_PATH: 'PRIVATE_PATH',
          CORDISX_NATIVE_CONTROL_SOCKET: h.server.socketPath,
          CORDISX_NATIVE_CONTROL_NONCE: h.server.nonce,
          CORDISX_NATIVE_REAL_CODEX_PATH: executable,
          CORDISX_NATIVE_AGENT_MODELS_BINDING: 'PRIVATE_BINDING',
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const closed = once(child, 'close')
      let output = '', stderr = ''
      child.stdout.on('data', chunk => output += String(chunk))
      child.stderr.on('data', chunk => stderr += String(chunk))
      try {
        h.send({ id: 'before', method: 'echo/bytes', params: {} })
        await h.read()
        const initialize = JSON.stringify({
          id: 1,
          method: 'initialize',
          params: { clientInfo: { name: clientName } },
        })
        child.stdin.write(initialize.slice(0, 31))
        child.stdin.write(`${initialize.slice(31)}\n${JSON.stringify({ method: 'initialized', params: {} })}\n`)
        child.stdin.write(`${JSON.stringify({ id: 2, method: 'configRequirements/read', params: null })}\n`)
        child.stdin.write(`${JSON.stringify({ id: 3, method: 'account/read', params: { refreshToken: false } })}\n`)
        for (const [id, method] of [[4, 'thread/start'], [5, 'turn/start'], [6, 'config/value/write']] as const) {
          child.stdin.write(`${JSON.stringify({ id, method, params: {} })}\n`)
        }
        child.stdin.end()
        expect(await closed).toEqual([0, null])
        const messages = output.trim().split('\n').map(line => JSON.parse(line))
        expect(messages.filter(m => m.result).map(m => m.result.method)).toEqual([
          'initialize',
          'configRequirements/read',
          'account/read',
        ])
        for (const message of messages.filter(m => m.result)) {
          expect(message.result.args).toEqual(args)
          expect(message.result.leaked).toEqual([])
        }
        expect(messages.filter(m => m.error).map(m => [m.id, m.error.code])).toEqual([[4, -32601], [5, -32601], [
          6,
          -32601,
        ]])
        expect(stderr).toBe('')
        h.send({ id: 'after', method: 'echo/bytes', params: {} })
        expect(JSON.parse(await h.read()).id).toBe('after')
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
        await closed
        await h.close()
        await rm(root, { recursive: true, force: true })
      }
    },
  )

  it('does not classify a different plugin-disabled client as Computer Use', async () => {
    const child = spawn(process.execPath, [
      path.resolve('packages/cli/assets/launcher/native-app-server-intermediary.mjs'),
      'app-server',
      '--config=features.plugins=false',
    ], {
      env: { ...process.env, CORDISX_NATIVE_CONTROL_SOCKET: '', CORDISX_NATIVE_CONTROL_NONCE: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const closed = once(child, 'close')
    let errors = ''
    child.stderr.on('data', chunk => errors += String(chunk))
    child.stdin.end(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'desktop' } } })}\n`)
    await vi.waitFor(() => expect(errors).toContain('Native intermediary is not configured'))
    expect((await closed)[0]).toBe(1)
  })
})
