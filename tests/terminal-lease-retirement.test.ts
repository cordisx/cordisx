import { EventEmitter } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { createDefaultHomeConfig } from '../packages/cli/src/config/home-config.js'
import { runCordisXCli } from '../packages/cli/src/cli/run.js'

const fixture = vi.hoisted(() => ({ request: vi.fn() }))
vi.mock('../packages/cli/src/launcher/existing-terminal-provider-rpc.js', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/cli/src/launcher/existing-terminal-provider-rpc.js')>(),
  connectExistingTerminalProvider: async () => fixture.request,
}))

it('does not signal an exited terminal when a renewal fails late', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cx-terminal-retirement-'))
  await writeFile(path.join(root, 'config.json'), JSON.stringify(createDefaultHomeConfig()))
  let rejectRenew!: (error: Error) => void
  const renewal = new Promise<never>((_resolve, reject) => rejectRenew = reject)
  fixture.request.mockImplementation(async (request: { kind: string }) => {
    if (request.kind === 'prepare') {
      return {
        kind: 'prepared',
        leaseId: 'lease',
        providerId: 'fixture',
        model: 'model',
        provider: { name: 'Fixture' },
      }
    }
    if (request.kind === 'renew') return await renewal
    return { kind: 'released' }
  })
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(),
  })
  let spawned!: () => void
  const started = new Promise<void>(resolve => spawned = resolve)
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  const running = runCordisXCli(['cli', '--service', 'fixture', '--model', 'model', '--', '--version'], {
    env: { HOME: root, CODEX_HOME: path.join(root, 'codex'), CORDISX_HOME: root, PATH: '/usr/bin:/bin' },
    internalCheckTerminalClient: async executable => executable,
    internalSpawnTerminal: (() => {
      spawned()
      return child
    }) as never,
  }).then(() => undefined, error => error as Error)
  try {
    await started
    await vi.advanceTimersByTimeAsync(10_000)
    expect(fixture.request).toHaveBeenCalledWith({ kind: 'renew', leaseId: 'lease' })
    child.signalCode = 'SIGTERM'
    child.emit('exit', null, 'SIGTERM')
    expect((await running)?.message).toContain('status 143')
    rejectRenew(new Error('owner retired'))
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(child.kill).not.toHaveBeenCalled()
  } finally {
    rejectRenew(new Error('test cleanup'))
    child.emit('exit', 0, null)
    await running
    vi.useRealTimers()
    await rm(root, { recursive: true, force: true })
  }
})
