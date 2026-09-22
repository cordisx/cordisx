import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { observeHostExit, waitForExit } from '../packages/cli/src/cli/host-lifecycle.js'

describe('Host exit evidence', () => {
  it.each(
    [
      [0, null],
      [null, 'SIGTERM'],
      [7, null],
    ] as const,
  )('records exit code %s and signal %s without changing exit handling', async (code, signal) => {
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null }) as ChildProcess
    const logs: string[] = []
    const remove = observeHostExit(child, line => logs.push(line), () => true)
    const waiting = waitForExit(child)
    child.emit('exit', code, signal)
    if (code === 7) await expect(waiting).rejects.toThrow('host exited with status 7')
    else await expect(waiting).resolves.toBeUndefined()
    expect(JSON.parse(logs[0]!.slice('[cordisx-lifecycle] '.length))).toEqual({
      at: expect.any(Number),
      launcherPid: process.pid,
      hostPid: 123,
      ready: true,
      event: 'host-exit',
      exitCode: code,
      signal,
    })
    remove()
    expect(child.listenerCount('exit')).toBe(0)
    // waitForExit owns its existing error listener; the diagnostic listener is removed.
    expect(child.listenerCount('error')).toBe(1)
  })

  it('captures an already exited prelaunched Host and excludes process error bodies', () => {
    const child = Object.assign(new EventEmitter(), { pid: 123, exitCode: 0, signalCode: null }) as ChildProcess
    const logs: string[] = []
    const remove = observeHostExit(child, line => logs.push(line), () => false)
    child.emit('error', new Error('sensitive user content'))
    expect(logs).toHaveLength(2)
    expect(logs[0]).toContain('"event":"host-exit"')
    expect(logs[1]).toContain('"event":"host-process-error"')
    expect(logs.join('\n')).not.toContain('sensitive')
    remove()
    expect(child.listenerCount('error')).toBe(0)
  })
})
