import { spawn } from 'node:child_process'
import { access, chmod, lstat, symlink } from 'node:fs/promises'
import { createConnection } from 'node:net'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createNativeProviderCredentialBroker,
  type NativeProviderCredentialCommand,
  nativeProviderCredentialHelperPath,
  type NativeProviderCredentialPreparation,
} from '../packages/cli/src/launcher/native-provider-credential-broker.js'
import type { NativeManagedGatewayConnectionSession } from '../packages/cli/src/launcher/managed-service-native-connection.js'

const brokers: { close(): Promise<void> }[] = []
afterEach(async () => {
  await Promise.all(brokers.splice(0).map(broker => broker.close()))
})

function connection(options: {
  token?: string
  generation?: string
  pluginId?: string
  dispose?: () => void
} = {}): NativeManagedGatewayConnectionSession {
  return {
    value: {
      service: {
        pluginId: options.pluginId ?? 'fixture',
        serviceId: 'models',
        generation: options.generation ?? 'one',
      },
      endpoint: {
        origin: 'http://127.0.0.1:1',
        apiPath: '/v1',
        auth: options.token === undefined ? { scheme: 'none' } : { scheme: 'bearer', token: options.token },
      },
      models: {
        generation: 'models-one',
        defaultAlias: 'primary',
        aliases: [{ alias: 'primary', gatewayModelId: 'test' }],
      },
      cleanup: { authorityId: 'test' },
    },
    dispose: options.dispose ?? (() => undefined),
  }
}

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>(done => resolve = done)
  return { promise, resolve }
}

function auth(prepared: NativeProviderCredentialPreparation): NativeProviderCredentialCommand {
  if (prepared.scheme !== 'bearer') throw new Error('expected bearer')
  return prepared.auth
}

function execute(command: NativeProviderCredentialCommand) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const child = spawn(command.command, [...command.args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk)
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk)
    child.once('error', () => resolve({ code: -1, stdout, stderr }))
    child.once('close', code => resolve({ code, stdout, stderr }))
  })
}

function raw(socketPath: string, source: string): Promise<string> {
  return new Promise(resolve => {
    const socket = createConnection(socketPath)
    let response = ''
    socket.setTimeout(5000, () => socket.destroy())
    socket.setEncoding('utf8')
    socket.once('connect', () => socket.write(source))
    socket.on('data', chunk => response += chunk)
    socket.once('end', () => resolve(response))
    socket.once('error', () => resolve(response))
    socket.once('close', () => resolve(response))
  })
}

describe('native provider credential broker', () => {
  it('does not create an auth command for no-auth providers and releases the session', async () => {
    let disposed = 0
    const broker = createNativeProviderCredentialBroker({ resolve: () => connection({ dispose: () => disposed++ }) })
    brokers.push(broker)
    const prepared = await broker.prepare('fixture')
    expect(prepared).toMatchObject({ scheme: 'none', serviceGeneration: 'one' })
    expect('auth' in prepared).toBe(false)
    prepared.dispose()
    prepared.dispose()
    expect(disposed).toBe(1)
  })

  it('resolves current credentials for concurrent helper runs without serializing secrets', async () => {
    let calls = 0
    let disposed = 0
    const broker = createNativeProviderCredentialBroker({
      resolve: () => connection({ token: `synthetic-${++calls}`, dispose: () => disposed++ }),
    })
    brokers.push(broker)
    const prepared = await broker.prepare('fixture')
    const command = auth(prepared)
    expect(command.command).toBe(process.execPath)
    expect(command.args[0]).toBe(nativeProviderCredentialHelperPath())
    expect(command.cwd).toBe(path.dirname(command.args[1]!))
    expect(JSON.stringify(prepared)).not.toContain('synthetic-')
    const results = await Promise.all([execute(command), execute(command)])
    expect(results.map(result => result.stdout).sort()).toEqual(['synthetic-2', 'synthetic-3'])
    expect(results.every(result => result.code === 0 && result.stderr === '')).toBe(true)
    expect(disposed).toBe(3)
  })

  it('keeps the binding live across later turns and refreshes until explicitly disposed', async () => {
    const broker = createNativeProviderCredentialBroker({ resolve: () => connection({ token: 'synthetic-current' }) })
    brokers.push(broker)
    const prepared = await broker.prepare('fixture')
    const command = auth(prepared)
    for (let index = 0; index < 66; index++) {
      expect(await raw(command.args[1]!, `${JSON.stringify({ operationHandle: command.args[2] })}\n`))
        .toBe('{"ok":true,"credential":"synthetic-current"}\n')
    }
    expect(await execute(command)).toEqual({ code: 0, stdout: 'synthetic-current', stderr: '' })
    prepared.dispose()
    prepared.dispose()
    expect(await execute(command)).toEqual({ code: 1, stdout: '', stderr: '' })
  })

  it('permanently revokes a replaced service identity or authentication scheme', async () => {
    let value = connection({ token: 'synthetic-token' })
    const broker = createNativeProviderCredentialBroker({ resolve: () => value })
    brokers.push(broker)
    const command = auth(await broker.prepare('fixture'))
    value = connection({ token: 'synthetic-token', pluginId: 'replacement' })
    expect(await execute(command)).toEqual({ code: 1, stdout: '', stderr: '' })
    value = connection({ token: 'synthetic-token' })
    expect(await execute(command)).toEqual({ code: 1, stdout: '', stderr: '' })
    const changedScheme = auth(await broker.prepare('fixture'))
    value = connection()
    expect(await execute(changedScheme)).toEqual({ code: 1, stdout: '', stderr: '' })
  })

  it('checks directory/socket permissions and rejects symlinked paths', async () => {
    const broker = createNativeProviderCredentialBroker({ resolve: () => connection({ token: 'synthetic-token' }) })
    brokers.push(broker)
    const command = auth(await broker.prepare('fixture'))
    expect((await lstat(command.cwd)).mode & 0o777).toBe(0o700)
    expect((await lstat(command.args[1]!)).mode & 0o777).toBe(0o600)
    const link = path.join(command.cwd, 'link.sock')
    await symlink(command.args[1]!, link)
    expect(await execute({ ...command, args: [command.args[0]!, link, command.args[2]!] }))
      .toEqual({ code: 1, stdout: '', stderr: '' })
    await chmod(command.cwd, 0o755)
    expect(await execute(command)).toEqual({ code: 1, stdout: '', stderr: '' })
    await chmod(command.cwd, 0o700)
  })

  it('rejects overload and revocation during an in-flight resolution without leaking the token', async () => {
    const started = deferred<void>()
    const gate = deferred<NativeManagedGatewayConnectionSession>()
    let calls = 0
    let disposed = 0
    const broker = createNativeProviderCredentialBroker({
      maxParallelRequests: 1,
      resolve: () => {
        if (++calls === 1) return connection({ token: 'synthetic-first' })
        started.resolve()
        return gate.promise
      },
    })
    brokers.push(broker)
    const prepared = await broker.prepare('fixture')
    const first = execute(auth(prepared))
    await started.promise
    expect(await execute(auth(prepared))).toEqual({ code: 1, stdout: '', stderr: '' })
    prepared.dispose()
    gate.resolve(connection({ token: 'synthetic-private', dispose: () => disposed++ }))
    expect(await first).toEqual({ code: 1, stdout: '', stderr: '' })
    expect(disposed).toBe(1)
  })

  it('bounds malformed requests and suppresses resolver errors', async () => {
    let fail = false
    const broker = createNativeProviderCredentialBroker({
      resolve: () => {
        if (fail) throw new Error('synthetic-private-error')
        return connection({ token: 'synthetic-private-token' })
      },
    })
    brokers.push(broker)
    const command = auth(await broker.prepare('fixture'))
    for (const value of ['null\n', '{}\n', 'x'.repeat(1025), '{"operationHandle":"bad"}\n']) {
      expect(await raw(command.args[1]!, value)).toBe('{"ok":false}\n')
    }
    fail = true
    expect(await execute(command)).toEqual({ code: 1, stdout: '', stderr: '' })
    await expect(broker.prepare('fixture')).rejects.toThrow('native provider credential unavailable')
  })

  it('disposes a resolution that arrives after the timeout', async () => {
    let disposed = 0
    const gate = deferred<NativeManagedGatewayConnectionSession>()
    const broker = createNativeProviderCredentialBroker({ resolve: () => gate.promise, resolveTimeoutMs: 10 })
    brokers.push(broker)
    await expect(broker.prepare('fixture')).rejects.toThrow('native provider credential unavailable')
    gate.resolve(connection({ token: 'synthetic-late', dispose: () => disposed++ }))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(disposed).toBe(1)
  })

  it('rejects a prepare racing close and removes owned resources idempotently', async () => {
    let disposed = 0
    const gate = deferred<NativeManagedGatewayConnectionSession>()
    const broker = createNativeProviderCredentialBroker({ resolve: () => gate.promise })
    const preparing = broker.prepare('fixture')
    await broker.close()
    gate.resolve(connection({ token: 'synthetic-late', dispose: () => disposed++ }))
    await expect(preparing).rejects.toThrow('native provider credential unavailable')
    expect(disposed).toBe(1)
    const live = createNativeProviderCredentialBroker({ resolve: () => connection({ token: 'synthetic-current' }) })
    const command = auth(await live.prepare('fixture'))
    const closing = live.close()
    expect(live.close()).toBe(closing)
    await closing
    await expect(access(command.cwd)).rejects.toThrow()
    expect(await execute(command)).toEqual({ code: 1, stdout: '', stderr: '' })
  })
})
