import { type ChildProcess, spawn } from 'node:child_process'
import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'
import { openProductionPluginManagementComposition } from '../packages/cli/src/cli/production-plugin-management.js'
import { PluginLifecycleCoordinator } from '../packages/cli/src/launcher/plugin-lifecycle.js'
import { createServiceTerminalProvider } from '../packages/cli/src/launcher/service-terminal-provider.js'
import type { ManagedServiceNativeActivation } from '../packages/cli/src/launcher/managed-service-plugin-lifecycle.js'

// Explicitly opt in: this exercises installed CLI binaries, not test doubles.
// No model request is sent. The children only execute their --version command.
const codexCli = process.env.CORDISX_TEST_REAL_CODEX_CLI
const claudeCli = process.env.CORDISX_TEST_REAL_CLAUDE_CLI
const enabled = process.platform === 'darwin' && !!codexCli && !!claudeCli

function activation(origin: string) {
  const dispose = vi.fn()
  return {
    dispose,
    value: {
      startup: { hasProvider: () => false, providerReference: () => undefined, targets: () => [] },
      startupObserver: { read: async () => ({ entries: [] }) },
      revision: 1,
      nativeProviderIds: ['fixture-provider'],
      prepareNativeConnection: () => ({
        value: {
          service: { pluginId: 'fixture', serviceId: 'gateway', generation: 'generation-one' },
          endpoint: { origin, apiPath: '/v1', auth: { scheme: 'none' } },
          models: {
            generation: 'models-one',
            defaultAlias: 'one',
            aliases: [{ alias: 'one', gatewayModelId: 'model-one' }],
          },
          cleanup: { authorityId: 'fixture' },
        },
        dispose,
      }),
      subscribeNativeProviders: () => () => {},
    } as unknown as ManagedServiceNativeActivation,
  }
}

function sandboxPolicy(root: string, node: string, codex: string, claude: string): string {
  // The package roots are the minimum installation trees needed by these CLIs.
  // Node modules elsewhere, user homes, volumes, Keychain, and ordinary temp
  // files remain inaccessible. The test's ephemeral root is the only writable
  // location among those trees. Securityd and all networking are denied.
  const allowNode = path.dirname(path.dirname(node))
  const allowCodex = path.dirname(path.dirname(codex))
  const claudeParent = path.dirname(claude)
  const allowClaude = path.basename(claudeParent) === 'bin' ? path.dirname(claudeParent) : claudeParent
  const installs = [[node, allowNode], [codex, allowCodex], [claude, allowClaude]] as const
  for (const [entry, directory] of installs) {
    if (entry.startsWith('/usr/')) continue
    if (!directory.startsWith('/Users/') || directory.split(path.sep).length < 6) {
      throw new Error('Real CLI smoke requires narrowly scoped /Users or /usr installations')
    }
  }
  const paths = [
    ...installs.filter(([entry]) => entry.startsWith('/Users/')).map(([, directory]) => directory),
    '/private/etc',
    '/private/var/db/dyld',
    root,
  ]
  return `(version 1)
    (allow default)
    (deny network*)
    (deny file-read-data (subpath "/Users") (subpath "/Volumes") (subpath "/Library") (subpath "/private"))
    (allow file-read-data ${paths.map(directory => `(subpath ${JSON.stringify(directory)})`).join(' ')})
    (deny file-write* (subpath "/Users") (subpath "/Volumes") (subpath "/Library") (subpath "/private"))
    (allow file-write* (subpath ${JSON.stringify(root)}))
    (deny mach-lookup (global-name "com.apple.securityd"))`
}

async function assertNodeScript(entry: string): Promise<void> {
  const file = await open(entry, 'r')
  try {
    if (!(await file.stat()).isFile()) throw new Error('CLI entry must be a regular Node script')
    const buffer = Buffer.alloc(256)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    const line = buffer.subarray(0, bytesRead).toString('utf8').split(/\r?\n/u)[0] ?? ''
    if (!/^#!\s*(?:\/usr\/bin\/env\s+node|\/(?:[\w.-]+\/)*node)\s*$/u.test(line)) {
      throw new Error('CLI entry must be a regular Node script with an unambiguous Node shebang')
    }
  } finally {
    await file.close()
  }
}

async function withCleanups<T>(run: (defer: (cleanup: () => Promise<void>) => void) => Promise<T>): Promise<T> {
  const cleanups: Array<() => Promise<void>> = []
  try {
    return await run(cleanup => cleanups.push(cleanup))
  } finally {
    const errors: unknown[] = []
    for (const cleanup of cleanups.reverse()) {
      try {
        await cleanup()
      } catch (error) {
        errors.push(error)
      }
    }
    if (errors.length) throw new AggregateError(errors, 'Isolated CLI smoke cleanup failed')
  }
}

function runProbe(args: string[], env: NodeJS.ProcessEnv, cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', args, { env, cwd, stdio: ['ignore', 'pipe', 'ignore'] })
    let stdout = ''
    child.stdout!.setEncoding('utf8').on('data', chunk => {
      stdout += chunk
    })
    child.once('error', reject)
    child.once('exit', code => resolve({ code: code ?? -1, stdout }))
  })
}

async function waitForClient(completion: Promise<{ ok: boolean; error?: unknown }>) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      completion,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Isolated CLI did not exit')), 10_000)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('real CLI smoke isolation', () => {
  it('allows distinct client installation trees without allowing the whole home', () => {
    const policy = sandboxPolicy(
      '/private/tmp/isolated',
      '/Users/test/node/releases/one/bin/node',
      '/Users/test/codex/releases/one/bin/codex.js',
      '/Users/test/claude/releases/two/cli.js',
    )
    expect(policy).toContain('(subpath "/Users/test/codex/releases/one")')
    expect(policy).toContain('(subpath "/Users/test/claude/releases/two")')
    expect(policy).not.toContain('(subpath "/Users/test")')
  })

  it('rejects non-Node CLI entries', () =>
    withCleanups(async defer => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'cx-cli-entry-'))
      defer(() => rm(root, { recursive: true, force: true }))
      const script = path.join(root, 'cli.js')
      const binary = path.join(root, 'cli-native')
      await writeFile(script, '#!/usr/bin/env node\n')
      await writeFile(binary, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0x00]))
      await expect(assertNodeScript(script)).resolves.toBeUndefined()
      await expect(assertNodeScript(binary)).rejects.toThrow('Node script')
    }))

  it('closes a listening gateway and deletes its root after initialization fails', async () => {
    let root = ''
    let gateway: ReturnType<typeof createServer> | undefined
    await expect(withCleanups(async defer => {
      root = await mkdtemp(path.join(os.tmpdir(), 'cx-cli-init-failure-'))
      defer(() => rm(root, { recursive: true, force: true }))
      gateway = createServer()
      const server = gateway
      defer(() => new Promise<void>(resolve => server.close(() => resolve())))
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      throw new Error('synthetic initialization failure')
    })).rejects.toThrow('synthetic initialization failure')
    expect(gateway!.listening).toBe(false)
    await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe.skipIf(!enabled)('installed terminal clients with isolated model-service leases', () => {
  it.each(['codex', 'claude-code'] as const)(
    'releases only the %s lease when that real client exits first',
    async firstClient =>
      withCleanups(async defer => {
        const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'cx-real-clients-'))
        defer(() => rm(tempRoot, { recursive: true, force: true }))
        const root = await realpath(tempRoot)
        const outside = await mkdtemp(path.join(os.tmpdir(), 'cx-real-clients-denied-'))
        defer(() => rm(outside, { recursive: true, force: true }))
        const [node, codex, claude] = await Promise.all([
          realpath(process.execPath),
          realpath(codexCli!),
          realpath(claudeCli!),
        ])
        await Promise.all([assertNodeScript(codex), assertNodeScript(claude)])
        const policy = sandboxPolicy(root, node, codex, claude)
        const home = path.join(root, 'home')
        const codexHome = path.join(root, 'codex')
        const claudeHome = path.join(root, 'claude')
        await Promise.all([home, codexHome, claudeHome].map(directory => mkdir(directory)))
        const env = {
          HOME: home,
          TMPDIR: root,
          PATH: `${path.dirname(node)}:/usr/bin:/bin`,
          USER: 'cordisx-isolated-test',
          LOGNAME: 'cordisx-isolated-test',
          LANG: 'C.UTF-8',
          CI: '1',
          CORDISX_HOME: root,
          CODEX_HOME: codexHome,
          CLAUDE_CONFIG_DIR: claudeHome,
          // On macOS Claude Code defaults to /tmp independently of TMPDIR.
          CLAUDE_CODE_TMPDIR: root,
          XDG_CONFIG_HOME: path.join(root, 'xdg-config'),
          XDG_CACHE_HOME: path.join(root, 'xdg-cache'),
          XDG_DATA_HOME: path.join(root, 'xdg-data'),
        }
        const allowed = path.join(root, 'allowed.txt')
        const denied = path.join(outside, 'denied.txt')
        await writeFile(allowed, 'temporary-allowed-marker')
        await writeFile(denied, 'temporary-denied-marker')
        const gate = path.join(root, 'gate.sh')
        await writeFile(gate, '#!/bin/sh\nkill -STOP $$\nexec "$@"\n')
        const configPath = path.join(root, 'config.json')
        await writeFile(configPath, JSON.stringify(createDefaultHomeConfig()), { mode: 0o600 })

        let connections = 0
        const gateway = createServer(socket => {
          connections++
          socket.destroy()
        })
        defer(() => new Promise<void>(resolve => gateway.close(() => resolve())))
        await new Promise<void>((resolve, reject) => {
          gateway.once('error', reject)
          gateway.listen(0, '127.0.0.1', resolve)
        })
        const address = gateway.address()
        if (!address || typeof address === 'string') throw new Error('Synthetic gateway did not bind')
        const origin = `http://127.0.0.1:${address.port}`
        const fixture = activation(origin)
        const terminal = createServiceTerminalProvider({ activation: fixture.value })
        defer(() => terminal.close())
        const leases = new Map<string, string>()
        const manager = await openProductionPluginManagementComposition({
          homeDir: root,
          configPath,
          appId: 'codex',
          profileId: 'default',
          runtimeGeneration: 'runtime-one',
          token: 'a'.repeat(64),
          mode: 'service',
          coordinator: new PluginLifecycleCoordinator({
            homeDir: root,
            profileId: 'default',
            runtimeGeneration: 'runtime-one',
            permissionPolicies: [],
            runtime: {
              stage: async () => undefined,
              commit: async () => undefined,
              abort: async () => undefined,
              reload: async () => undefined,
            },
          }),
          terminalProvider: async request => {
            const result = await terminal.request(request)
            if (request.kind === 'prepare' && result.kind === 'prepared') {
              leases.set(request.client ?? 'codex', result.leaseId)
            }
            return result
          },
        })
        defer(() => manager.close())
        const children = new Map<string, ChildProcess>()
        const output = new Map<string, string>()
        const completions: Promise<{ ok: boolean; error?: unknown }>[] = []
        defer(async () => {
          for (const child of children.values()) if (child.exitCode === null) child.kill('SIGKILL')
          await Promise.all(completions)
        })
        expect(await runProbe(['-p', policy, '/bin/cat', allowed], env, root)).toEqual({
          code: 0,
          stdout: 'temporary-allowed-marker',
        })
        expect((await runProbe(['-p', policy, '/bin/cat', denied], env, root)).code).not.toBe(0)
        const networkProbe = [
          'const s=require("node:net").connect(Number(process.argv[1]),"127.0.0.1");',
          's.on("connect",()=>process.exit(2));',
          's.on("error",e=>process.exit(e.code==="EPERM"||e.code==="EACCES"?0:3));',
          'setTimeout(()=>process.exit(4),2000);',
        ].join('')
        expect((await runProbe(['-p', policy, node, '-e', networkProbe, String(address.port)], env, root)).code).toBe(0)

        const runtime = {
          env,
          cwd: root,
          homedir: home,
          internalCheckTerminalClient: async (executable: string) => executable,
          internalSpawnTerminal: (executable: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
            const client = executable === 'codex' ? 'codex' : 'claude-code'
            const entry = client === 'codex' ? codex : claude
            const child = spawn('/usr/bin/sandbox-exec', ['-p', policy, '/bin/sh', gate, node, entry, ...args], {
              ...options,
              stdio: ['ignore', 'pipe', 'pipe'],
            })
            children.set(client, child)
            child.stdout!.setEncoding('utf8').on(
              'data',
              chunk => output.set(client, (output.get(client) ?? '') + chunk),
            )
            child.stderr!.resume()
            return child
          },
        }
        for (const client of ['codex', 'claude-code'] as const) {
          completions.push(
            runCordisXCli([
              'start',
              '--mode',
              'cli',
              client,
              '-s',
              'fixture-provider',
              '-m',
              'model-one',
              '--',
              '--version',
            ], runtime).then(() => ({ ok: true }), error => ({ ok: false, error })),
          )
        }
        await vi.waitFor(async () => {
          expect(children.size).toBe(2)
          expect(leases.size).toBe(2)
          for (const child of children.values()) {
            const status = await new Promise<string>((resolve, reject) => {
              const ps = spawn('/bin/ps', ['-o', 'state=', '-p', String(child.pid)])
              let value = ''
              ps.stdout!.setEncoding('utf8').on('data', chunk => {
                value += chunk
              })
              ps.once('error', reject)
              ps.once('exit', code => code === 0 ? resolve(value.trim()) : reject(new Error('Client is not running')))
            })
            expect(status.startsWith('T')).toBe(true)
          }
        }, { timeout: 10_000 })
        expect(new Set(leases.values()).size).toBe(2)

        const remainingClient = firstClient === 'codex' ? 'claude-code' : 'codex'
        children.get(firstClient)!.kill('SIGCONT')
        const firstResult = await waitForClient(completions[firstClient === 'codex' ? 0 : 1]!)
        expect(firstResult).toEqual({ ok: true })
        expect(output.get(firstClient)).toMatch(firstClient === 'codex' ? /codex-cli/iu : /Claude Code/iu)
        await expect(terminal.request({ kind: 'renew', leaseId: leases.get(firstClient)! })).rejects.toThrow()
        expect(await terminal.request({ kind: 'renew', leaseId: leases.get(remainingClient)! })).toEqual({
          kind: 'renewed',
        })

        children.get(remainingClient)!.kill('SIGCONT')
        const secondResult = await waitForClient(completions[remainingClient === 'codex' ? 0 : 1]!)
        expect(secondResult).toEqual({ ok: true })
        expect(output.get(remainingClient)).toMatch(remainingClient === 'codex' ? /codex-cli/iu : /Claude Code/iu)
        await expect(terminal.request({ kind: 'renew', leaseId: leases.get(remainingClient)! })).rejects.toThrow()
        expect(fixture.dispose).toHaveBeenCalled()
        expect(connections).toBe(0)
      }),
    30_000,
  )
})
